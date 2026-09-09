import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agentFor, getAgent } from './agents/index.js';
import { PROJECTS_ROOT } from './config.js';
import type { Federation } from './federation.js';
import type { HubSession, SessionManager } from './sessionManager.js';
import type { SessionInfo } from './types.js';

/**
 * Hand a session over to another engine (and/or machine, and/or folder).
 *
 * Not a transcript transplant: each agent's log is its own private replay
 * format. Instead the departing agent writes a brief for its replacement, the
 * hub appends the conversation as plain dialogue, drops the document into the
 * target folder as .deckhand/handoff.md, and starts the target engine with a
 * first prompt that says "read it, then continue".
 */

export type HandoffPhase = 'briefing' | 'composing' | 'sending' | 'done' | 'error';

export interface HandoffJob {
  id: string;
  phase: HandoffPhase;
  pct: number;
  error?: string;
  session?: SessionInfo;
}

export interface HandoffRequest {
  sourceHubId: string;
  targetAgent: string;
  /** undefined or self = this machine */
  targetMachine?: string;
  /** existing folder NAME under the target's projects root; default = source folder name */
  targetFolder?: string;
  /** create this folder under the target's projects root instead */
  newFolder?: string;
  askBrief: boolean;
  includeDialogue: boolean;
  model?: string;
  permissionMode?: string;
}

export interface HandoffOrigin {
  agent: string;
  sessionId: string;
  machine: string;
  name: string;
  path: string;
}

export interface HandoffPayload {
  agentType: string;
  folder?: string;
  newFolder?: string;
  document: string;
  model?: string;
  permissionMode?: string;
  from: HandoffOrigin;
}

const jobs = new Map<string, HandoffJob>();
const MAX_DOC_CHARS = 240_000;
const BRIEF_START_MS = 90_000;
const BRIEF_DONE_MS = 15 * 60_000;

export function getHandoffJob(id: string): HandoffJob | undefined {
  return jobs.get(id);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const folderName = (cwd: string) => cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
const safeFolder = (s: string) => s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(700);
  }
  return pred();
}

/** Ask the live source agent to write its own handoff brief and capture the reply. */
async function collectBrief(
  manager: SessionManager,
  source: HubSession,
  marker: string,
  targetAgent: string,
  targetHint: string,
): Promise<string | undefined> {
  const prompt =
    `[${marker}] You are handing this work over to another coding agent (${targetAgent}) ` +
    `that will continue in ${targetHint}. Write a complete handoff brief for it: the goal, ` +
    `the key decisions and why they were made, the current state of the code, the exact file ` +
    `paths touched, open items and the next steps, and any gotchas. Be thorough and concrete: ` +
    `the other agent has no access to your memory beyond this brief and the conversation transcript.`;
  manager.write(source.hubId, prompt);
  await sleep(120);
  manager.write(source.hubId, '\r');

  // the prompt lands, the agent works, then stops
  await waitFor(() => source.state === 'WORKING', BRIEF_START_MS);
  const finished = await waitFor(
    () => !source.proc || ['IDLE', 'WAITING_QUESTION', 'WAITING_PERMISSION'].includes(source.state),
    BRIEF_DONE_MS,
  );
  if (!finished) return undefined;
  await sleep(1500); // transcript flushes slightly after the stop hook

  const ops = agentFor(source).transcript;
  if (!ops) return undefined;
  const path = ops.file(source.cwd, source.claudeSessionId);
  if (!existsSync(path)) return undefined;
  const exchanges = ops.parseExchanges(await readFile(path, 'utf8'), 20);
  return exchanges.find((e) => e.q.includes(marker))?.r;
}

function composeDocument(o: {
  from: HandoffOrigin;
  toAgent: string;
  toMachine: string;
  toFolderHint: string;
  brief?: string;
  briefRequested: boolean;
  dialogue: { q: string; r: string }[];
}): string {
  const parts: string[] = [];
  parts.push(`# Handoff`);
  parts.push('');
  parts.push(`- From: ${o.from.agent} session "${o.from.name}" on ${o.from.machine}, folder \`${o.from.path}\``);
  parts.push(`- To: ${o.toAgent} on ${o.toMachine}, ${o.toFolderHint}`);
  parts.push(`- Date: ${new Date().toISOString()}`);
  parts.push('');
  parts.push(`## Brief from the previous agent`);
  parts.push('');
  parts.push(
    o.brief ??
      (o.briefRequested
        ? '_The previous agent did not produce a brief in time. Rely on the transcript below._'
        : '_No brief was requested. Rely on the transcript below._'),
  );
  parts.push('');

  let body = '';
  if (o.dialogue.length) {
    const rendered = o.dialogue.map((e) => `### User\n\n${e.q.trim()}\n\n### ${o.from.agent}\n\n${e.r.trim()}\n`);
    // trim from the oldest until the document fits
    let start = 0;
    const size = (from: number) => rendered.slice(from).reduce((n, s) => n + s.length + 2, 0);
    while (start < rendered.length - 1 && parts.join('\n').length + size(start) > MAX_DOC_CHARS) start++;
    const omitted = start > 0 ? `_${start} earlier exchange${start === 1 ? '' : 's'} omitted for length._\n\n` : '';
    body = `## Conversation transcript (${rendered.length - start} of ${rendered.length} exchanges, oldest first; tool activity omitted)\n\n${omitted}${rendered.slice(start).join('\n')}`;
  } else {
    body = '## Conversation transcript\n\n_Not included._';
  }
  parts.push(body);
  return parts.join('\n');
}

/**
 * Target side: place the document in the folder and start the engine there.
 * Runs on whichever hub owns the target machine.
 */
export async function receiveHandoff(
  payload: HandoffPayload,
  deps: { manager: SessionManager; selfName: string },
): Promise<HubSession> {
  const agent = getAgent(payload.agentType);
  if (!agent.available()) throw new Error(`${agent.label} is not installed on ${deps.selfName}`);
  if (!existsSync(PROJECTS_ROOT)) {
    throw new Error(`projects root ${PROJECTS_ROOT} does not exist on ${deps.selfName} — set HUB_PROJECTS_ROOT`);
  }

  let path: string;
  let created = false;
  if (payload.newFolder) {
    const name = safeFolder(payload.newFolder);
    if (!name) throw new Error('new folder name is empty');
    path = join(PROJECTS_ROOT, name);
    if (!existsSync(path)) {
      await mkdir(path, { recursive: true });
      created = true;
    }
  } else {
    const name = safeFolder(payload.folder ?? '');
    if (!name) throw new Error('target folder missing');
    path = join(PROJECTS_ROOT, name);
    if (!existsSync(path)) {
      throw new Error(
        `folder ${name} is not on ${deps.selfName} — resume something there first so it syncs, or hand off to a new folder`,
      );
    }
  }

  const docDir = join(path, '.deckhand');
  await mkdir(docDir, { recursive: true });
  await writeFile(join(docDir, 'handoff.md'), payload.document);

  const from = payload.from;
  const moved = from.path.replace(/[\\/]+$/, '').toLowerCase() !== path.replace(/[\\/]+$/, '').toLowerCase();
  const initialPrompt =
    `This session continues work handed off from ${from.agent} (session "${from.name}" on ${from.machine}, ` +
    `folder ${from.path}). Read .deckhand/handoff.md in this folder first: it contains the previous agent's ` +
    `brief and the conversation transcript. Then continue from where it left off.` +
    (moved
      ? ` Note: the previous work lived in ${from.path}; this folder is ${path}` +
        (created ? ', created for this handoff, so it starts empty apart from the handoff document.' : '.')
      : '');

  return deps.manager.create({
    cwd: path,
    agentType: agent.id,
    name: folderName(path),
    model: payload.model,
    permissionMode: payload.permissionMode,
    initialPrompt,
    handoff: { fromAgent: from.agent, fromSessionId: from.sessionId, fromMachine: from.machine },
  });
}

/**
 * Source side: brief, compose, then hand the document to the target hub.
 * Runs on the hub that owns the source session.
 */
export function startHandoff(
  req: HandoffRequest,
  deps: { manager: SessionManager; federation: Federation; selfName: string },
): HandoffJob {
  const job: HandoffJob = { id: randomUUID().slice(0, 8), phase: 'briefing', pct: 0 };
  jobs.set(job.id, job);
  if (jobs.size > 50) {
    for (const [k, j] of jobs) {
      if (j.phase === 'done' || j.phase === 'error') jobs.delete(k);
      if (jobs.size <= 50) break;
    }
  }

  void (async () => {
    try {
      const source = deps.manager.sessions.get(req.sourceHubId);
      if (!source) throw new Error('source session is not on this machine');
      const targetMachine = req.targetMachine && req.targetMachine !== deps.selfName ? req.targetMachine : deps.selfName;
      const targetAgent = getAgent(req.targetAgent);
      const sourceFolder = folderName(source.cwd);
      const folder = req.newFolder ? undefined : req.targetFolder || sourceFolder;
      const toFolderHint = req.newFolder
        ? `new folder "${safeFolder(req.newFolder)}" under the projects root`
        : folder === sourceFolder
          ? `the same folder (${folder})`
          : `folder "${folder}"`;

      const from: HandoffOrigin = {
        agent: agentFor(source).id,
        sessionId: source.claudeSessionId,
        machine: deps.selfName,
        name: source.name,
        path: source.cwd,
      };

      let brief: string | undefined;
      const briefRequested = req.askBrief && !!source.proc;
      if (briefRequested) {
        job.phase = 'briefing';
        job.pct = 10;
        brief = await collectBrief(deps.manager, source, `HANDOFF-${job.id}`, targetAgent.label, toFolderHint);
      }

      job.phase = 'composing';
      job.pct = 60;
      let dialogue: { q: string; r: string }[] = [];
      if (req.includeDialogue) {
        const ops = agentFor(source).transcript;
        const path = ops?.file(source.cwd, source.claudeSessionId);
        if (ops && path && existsSync(path)) {
          dialogue = ops
            .parseExchanges(await readFile(path, 'utf8'), 400)
            .filter((e) => !e.q.includes(`HANDOFF-${job.id}`)); // the brief request itself stays out
        }
      }
      const document = composeDocument({
        from,
        toAgent: targetAgent.label,
        toMachine: targetMachine,
        toFolderHint,
        brief,
        briefRequested,
        dialogue,
      });

      job.phase = 'sending';
      job.pct = 80;
      const payload: HandoffPayload = {
        agentType: targetAgent.id,
        folder,
        newFolder: req.newFolder ? safeFolder(req.newFolder) : undefined,
        document,
        model: req.model,
        permissionMode: req.permissionMode,
        from,
      };
      if (targetMachine === deps.selfName) {
        const session = await receiveHandoff(payload, { manager: deps.manager, selfName: deps.selfName });
        job.session = { ...session.info(), machine: deps.selfName };
      } else {
        const peer = deps.federation.peerByMachine(targetMachine);
        if (!peer) throw new Error(`machine ${targetMachine} is not connected`);
        const out = await deps.federation.forward(peer, '/api/handoff/receive', { method: 'POST', body: payload });
        if (out.status !== 200) {
          throw new Error((out.body as { error?: string })?.error ?? `target hub answered ${out.status}`);
        }
        job.session = out.body as SessionInfo;
      }
      job.pct = 100;
      job.phase = 'done';
    } catch (err) {
      job.phase = 'error';
      job.error = err instanceof Error ? err.message : String(err);
    }
  })();

  return job;
}
