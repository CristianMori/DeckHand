import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { storeFilePath } from './transcriptStore.js';
import { readTail } from './transcriptIo.js';
import { join } from 'node:path';
import { getAgent } from './agents/index.js';
import { PROJECTS_ROOT } from './config.js';
import type { SessionManager } from './sessionManager.js';
import type { SyncManager } from './syncthing.js';
import type { Federation } from './federation.js';
import type { SessionInfo } from './types.js';

export type ResumePhase =
  | 'checking'
  | 'push-source' // source machine is pushing the folder to the VPS
  | 'pulling' // this machine is pulling the folder from the VPS
  | 'transcript'
  | 'spawning'
  | 'done'
  | 'error';

export interface ResumeJob {
  id: string;
  folder: string;
  agentType: string;
  claudeSessionId: string;
  phase: ResumePhase;
  pct: number;
  error?: string;
  session?: SessionInfo;
}

const jobs = new Map<string, ResumeJob>();

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function poll(
  job: ResumeJob,
  phase: ResumePhase,
  read: () => Promise<number>,
  timeoutMs: number,
) {
  job.phase = phase;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let pct = 0;
    try {
      pct = await read();
    } catch {
      /* transient API miss — keep polling */
    }
    job.pct = Math.round(pct);
    if (pct >= 100) return;
    if (Date.now() > deadline) throw new Error(`${phase} timed out`);
    await sleep(1500);
  }
}

export function getResumeJob(id: string): ResumeJob | undefined {
  return jobs.get(id);
}

/**
 * Resume a conversation of `folder` on THIS machine, materializing the folder
 * first if needed: source machine pushes to the VPS, we pull from the VPS,
 * the transcript is fetched from whichever hub holds it, then the agent resumes it.
 */
export function startFleetResume(opts: {
  folder: string;
  agentType?: string;
  claudeSessionId: string;
  sourceMachine?: string;
  selfName: string;
  manager: SessionManager;
  sync: SyncManager | null;
  federation: Federation;
}): ResumeJob {
  const agent = getAgent(opts.agentType);
  const job: ResumeJob = {
    id: randomUUID().slice(0, 8),
    folder: opts.folder,
    agentType: agent.id,
    claudeSessionId: opts.claudeSessionId,
    phase: 'checking',
    pct: 0,
  };
  jobs.set(job.id, job);
  if (jobs.size > 50) {
    for (const [k, j] of jobs) {
      if (j.phase === 'done' || j.phase === 'error') jobs.delete(k);
      if (jobs.size <= 50) break;
    }
  }

  void (async () => {
    try {
      // guard: never invent a projects root on a misconfigured machine —
      // materializing folders into a nonexistent default root is how paths go wrong
      if (!existsSync(PROJECTS_ROOT)) {
        throw new Error(
          `projects root ${PROJECTS_ROOT} does not exist on this machine — set HUB_PROJECTS_ROOT (hub-env.cmd)`,
        );
      }
      const localPath = join(PROJECTS_ROOT, opts.folder);
      const remoteSource = opts.sourceMachine && opts.sourceMachine !== opts.selfName;

      if (!existsSync(localPath)) {
        // folder must travel: VPS catalog first, else ask the source to push
        if (!opts.sync) throw new Error('folder not on this machine and sync is not configured');
        const onVps = (await opts.sync.vpsCatalog()).includes(opts.folder);
        if (!onVps) {
          if (!remoteSource) throw new Error(`folder ${opts.folder} not found anywhere reachable`);
          const peer = opts.federation.peerByMachine(opts.sourceMachine!);
          if (!peer) throw new Error(`machine ${opts.sourceMachine} is not connected`);
          const out = await opts.federation.forward(peer, '/api/sync/register', {
            method: 'POST',
            body: { folder: opts.folder },
          });
          if (out.status !== 200) throw new Error(`source push failed: ${JSON.stringify(out.body)}`);
          await poll(job, 'push-source', () => opts.sync!.vpsCompletion(opts.folder), 30 * 60_000);
        }
        await opts.sync.registerFolder(opts.folder);
        await poll(job, 'pulling', () => opts.sync!.localCompletion(opts.folder), 30 * 60_000);
      } else if (opts.sync) {
        // folder already here — make sure it's on the sync rails for next time
        job.phase = 'checking';
        await opts.sync.registerFolder(opts.folder).catch(() => {});
      }

      // transcript: fetch from the hub that holds it, re-homed for our path
      const ops = agent.transcript;
      if (!ops) throw new Error(`${agent.label} conversations cannot be moved between machines`);
      let transcriptPath = ops.file(localPath, opts.claudeSessionId);
      if (remoteSource && !existsSync(transcriptPath)) {
        job.phase = 'transcript';
        job.pct = 0;
        const peer = opts.federation.peerByMachine(opts.sourceMachine!);
        if (!peer) throw new Error(`machine ${opts.sourceMachine} is not connected`);
        const res = await fetch(
          `${peer.info.url}/api/transcripts/${opts.claudeSessionId}` +
            `?folder=${encodeURIComponent(opts.folder)}&agent=${encodeURIComponent(agent.id)}`,
        );
        if (!res.ok) throw new Error(`transcript fetch failed: ${res.status}`);
        transcriptPath = await ops.install(localPath, opts.claudeSessionId, Buffer.from(await res.arrayBuffer()));
      }
      if (!existsSync(transcriptPath)) {
        // last resort: this machine may itself hold the durable store
        const stored = storeFilePath(opts.folder, opts.claudeSessionId, agent.id);
        if (existsSync(stored)) {
          transcriptPath = await ops.install(localPath, opts.claudeSessionId, await readFile(stored));
        }
      }
      if (!existsSync(transcriptPath)) {
        throw new Error('transcript not found — cannot resume this conversation here');
      }

      // migrated conversations remember their old absolute paths — when the
      // folder now lives somewhere else, orient the resumed session up front
      let nudge: string | undefined;
      try {
        const oldCwd = ops.parseTail(await readTail(transcriptPath)).cwd;
        if (oldCwd && oldCwd.toLowerCase() !== localPath.toLowerCase()) {
          nudge =
            `Heads up: this session was migrated — the project folder now lives at ${localPath} ` +
            `on machine "${opts.selfName}". Any references to ${oldCwd} earlier in this conversation ` +
            `point to the previous location. Re-check paths before reusing them.`;
        }
      } catch {
        /* nudge is best-effort */
      }

      job.phase = 'spawning';
      job.pct = 100;
      const session = opts.manager.create({
        cwd: localPath,
        agentType: agent.id,
        name: opts.folder,
        resumeSessionId: opts.claudeSessionId,
        initialPrompt: nudge,
      });
      job.session = { ...session.info(), machine: opts.selfName };
      job.phase = 'done';
    } catch (err) {
      job.phase = 'error';
      job.error = err instanceof Error ? err.message : String(err);
    }
  })();

  return job;
}
