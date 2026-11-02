import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DATA_DIR } from './config.js';
import type { HubSession, SessionManager } from './sessionManager.js';
import type { WorkerLink } from './types.js';

/**
 * Architects and their workers. An architect session keeps the design in its
 * head and delegates; each worker is an ordinary session on the same machine,
 * in its own git worktree and branch, briefed with its task. It finishes with
 * dh_report: the hub checks the branch, tells the architect and stops the
 * worker. Everything that must reach the architect waits in the worker's
 * outbox until the architect is idle, so a report survives a busy or stopped
 * architect and a hub restart.
 */

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await run('git', ['-C', cwd, ...args], { timeout: 30_000, windowsHide: true })).stdout.trim();
const gitOk = (cwd: string, ...args: string[]) => git(cwd, ...args).then(() => true, () => false);

/** A report is what the architect needs, not the story. The transcript holds the rest. */
export const REPORT_MAX = 3000;
const TASK_MAX = 20_000;
const STOP_AFTER_REPORT_MS = 8000;
/** Time for a finished turn to call dh_report before it is reminded. */
const IDLE_GRACE_MS = 45_000;
/** Auto-yes answers a permission prompt within a second; longer means it can't. */
const PERMISSION_GRACE_MS = 30_000;
/** Don't type over the user: a recent keystroke holds delivery back. */
const USER_TYPING_MS = 10_000;
const NUDGE_IGNORED_MS = 120_000;

export const WORKER_NUDGE =
  'Your turn ended without a report. If the task is done, commit and call dh_report. If you are blocked, call dh_ask_architect. Otherwise carry on.';

function slug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'worker';
}

/** What a worker's state calls for next. Pure: the Swarm carries it out. */
export type WorkerStep =
  | { do: 'resume-tracking' }
  | { do: 'stopped' }
  | { do: 'waiting' }
  | { do: 'nudge' }
  | { do: 'stalled' }
  | null;

export function workerStep(
  w: WorkerLink,
  s: { alive: boolean; state: string; stateSince: number; detail?: string; autoYes?: boolean },
  now: number,
): WorkerStep {
  if (w.status === 'reported' || w.status === 'failed') return null;
  // told something new since it asked or stalled: it is working again
  if ((w.status === 'asking' && s.state === 'WORKING' && s.stateSince > (w.askedAt ?? 0)) || (w.status === 'stalled' && s.state === 'WORKING')) {
    return { do: 'resume-tracking' };
  }
  // a hub restart brings it back by itself
  if (!s.alive) return s.detail === 'hub restarted' ? null : { do: 'stopped' };
  if (s.state === 'WAITING_QUESTION' || s.state === 'WAITING_PERMISSION') {
    if (w.forwardedWait === s.stateSince) return null;
    if (s.state === 'WAITING_PERMISSION' && s.autoYes && now - s.stateSince < PERMISSION_GRACE_MS) return null;
    return { do: 'waiting' };
  }
  if (w.status !== 'working' || s.state !== 'IDLE' || now - s.stateSince < IDLE_GRACE_MS) return null;
  if (!w.nudgedAt) return { do: 'nudge' };
  // it took the reminder and stopped again, or never took it
  return s.stateSince > w.nudgedAt || now - w.nudgedAt > NUDGE_IGNORED_MS ? { do: 'stalled' } : null;
}

export interface WorktreeFacts {
  branch?: string;
  commits: number;
  files: number;
  dirty: boolean;
}

export async function worktreeFacts(w: Pick<WorkerLink, 'worktree' | 'branch' | 'baseCommit'>): Promise<WorktreeFacts> {
  if (!w.worktree || !w.baseCommit) return { commits: 0, files: 0, dirty: false };
  const [count, names, status] = await Promise.all([
    git(w.worktree, 'rev-list', '--count', `${w.baseCommit}..HEAD`),
    git(w.worktree, 'diff', '--name-only', `${w.baseCommit}..HEAD`),
    git(w.worktree, 'status', '--porcelain'),
  ]);
  return { branch: w.branch, commits: Number(count) || 0, files: names ? names.split('\n').length : 0, dirty: !!status };
}

/** The worker's own branch off the folder's current commit, outside every synced folder. */
export async function createWorktree(folder: string, name: string, root = join(DATA_DIR, 'worktrees')) {
  const id = randomBytes(3).toString('hex');
  const top = await git(folder, 'rev-parse', '--show-toplevel').catch(() => undefined);
  if (!top) return undefined; // not a git repo: there is nothing to isolate with
  const baseCommit = await git(folder, 'rev-parse', 'HEAD').catch(() => undefined);
  if (!baseCommit) throw new Error('the repository has no commits yet: commit something first, a worker branches from it');
  const baseDirty = !!(await git(folder, 'status', '--porcelain'));
  mkdirSync(root, { recursive: true });
  const dir = `${slug(name)}-${id}`;
  const worktree = join(root, dir);
  const branch = `worker/${dir}`;
  await git(top, 'worktree', 'add', '-b', branch, worktree, baseCommit);
  // a session in a subfolder gets its worker in the same subfolder
  const sub = relative(resolve(top), resolve(folder));
  return { worktree, branch, baseCommit, repo: top, cwd: sub ? join(worktree, sub) : worktree, baseDirty };
}

export interface StartWorker {
  task: string;
  name?: string;
  agentType?: string;
  model?: string;
  permissionMode?: string;
}

export class Swarm {
  /** architects with a prompt being typed right now */
  private delivering = new Set<string>();

  constructor(
    private manager: SessionManager,
    private deps: {
      typePrompt: (session: HubSession, text: string) => Promise<unknown>;
      /** the prompt coming: the sender answers a worker's questions, the user an architect's */
      promptFrom: (session: HubSession, caller: string, queued: boolean) => void;
      lastReply: (session: HubSession) => Promise<string | undefined>;
      save: () => void;
    },
  ) {
    manager.on('removed', (s: HubSession) => void this.tidyAfterRemoval(s));
  }

  workersOf(architect: HubSession): HubSession[] {
    return [...this.manager.sessions.values()].filter((s) => s.worker?.architect === architect.claudeSessionId);
  }

  async start(architect: HubSession, opts: StartWorker) {
    if (architect.role !== 'architect') throw new Error('only an architect session starts workers');
    const task = opts.task?.trim();
    if (!task) throw new Error('task required');
    if (task.length > TASK_MAX) throw new Error(`task too long (${task.length} characters, the limit is ${TASK_MAX})`);
    const name = opts.name?.trim() || `${architect.name} worker`;
    const tree = await createWorktree(architect.cwd, name);
    const worker: WorkerLink = {
      architect: architect.claudeSessionId,
      architectName: architect.name,
      task,
      baseFolder: architect.cwd,
      worktree: tree?.worktree,
      repo: tree?.repo,
      branch: tree?.branch,
      baseCommit: tree?.baseCommit,
      status: 'working',
      startedAt: Date.now(),
    };
    const session = this.manager.create({
      cwd: tree?.cwd ?? architect.cwd,
      name,
      agentType: opts.agentType ?? architect.agentType,
      model: opts.model ?? architect.model,
      permissionMode: opts.permissionMode,
      initialPrompt: task,
      role: 'worker',
      worker,
    });
    session.autoYes = true; // unattended: a prompt nobody is watching would stall it
    this.deps.promptFrom(session, `session:${architect.hubId}`, true);
    this.manager.emit('change', session);
    this.deps.save();
    return { session, baseDirty: tree?.baseDirty ?? false, isolated: !!tree };
  }

  /** The worker is done. Refused while its work isn't committed, unless it is reporting failure. */
  async report(session: HubSession, result: string, failed: boolean) {
    const w = session.worker;
    if (!w) throw new Error('only a worker reports');
    if (w.status === 'reported' || w.status === 'failed') throw new Error('already reported: end your turn now');
    const text = result?.trim();
    if (!text) throw new Error('result required');
    if (text.length > REPORT_MAX) {
      throw new Error(`too long (${text.length} characters, the limit is ${REPORT_MAX}). Give the result, not the story: the transcript stays readable.`);
    }
    const facts = await worktreeFacts(w);
    if (facts.dirty && !failed) throw new Error('uncommitted changes in your worktree: commit them first, or report with failed=true to say they should not be taken');
    w.status = failed ? 'failed' : 'reported';
    w.result = text;
    w.reportedAt = Date.now();
    w.commits = facts.commits;
    w.files = facts.files;
    const where = facts.branch
      ? `Branch ${facts.branch}: ${facts.commits} commit${facts.commits === 1 ? '' : 's'}, ${facts.files} file${facts.files === 1 ? '' : 's'} changed${facts.dirty ? ', with uncommitted changes left in its worktree' : ''}.`
      : 'It worked in your folder, with no branch of its own.';
    const next = facts.commits ? `\nReview and merge the branch, then dh_remove_worker. A follow-up: dh_worker_followup.` : `\nWhen you are done with it: dh_remove_worker. A follow-up: dh_worker_followup.`;
    this.queue(session, `${failed ? 'could not finish' : 'finished'}. ${where}\nRESULT:\n${text}${next}`);
    setTimeout(() => {
      if (session.worker?.status === w.status && session.proc) this.manager.kill(session.hubId);
    }, STOP_AFTER_REPORT_MS).unref?.();
    return facts;
  }

  /** The worker needs a decision: it ends its turn and the answer arrives as its next prompt. */
  ask(session: HubSession, question: string) {
    const w = session.worker;
    if (!w) throw new Error('only a worker asks its architect');
    const text = question?.trim();
    if (!text) throw new Error('question required');
    if (text.length > REPORT_MAX) throw new Error(`too long (${text.length} characters, the limit is ${REPORT_MAX})`);
    w.status = 'asking';
    w.askedAt = Date.now();
    w.question = text;
    this.queue(session, `asks:\n${text}\nAnswer with dh_send_prompt to ${session.hubId}, or ask the user if it is theirs to decide.`);
  }

  /** More for a worker to do: brings a stopped one back with its context. */
  async followUp(session: HubSession, task: string) {
    const w = session.worker;
    if (!w) throw new Error('not a worker');
    const text = task?.trim();
    if (!text) throw new Error('task required');
    w.status = 'working';
    w.followUps = [...(w.followUps ?? []), text];
    w.result = undefined;
    w.reportedAt = undefined;
    w.nudgedAt = undefined;
    w.question = undefined;
    if (!session.proc) this.manager.resume(session.hubId);
    await new Promise<void>((done) => {
      const started = Date.now();
      const check = () => {
        if (!session.proc || session.state !== 'STARTING' || Date.now() - started > 30_000) return done();
        setTimeout(check, 500);
      };
      check();
    });
    if (!session.proc) throw new Error(`it did not come back (${session.detail ?? 'exited'})`);
    this.deps.promptFrom(session, 'session:architect', true);
    await this.deps.typePrompt(session, text);
    this.manager.emit('change', session);
    this.deps.save();
  }

  /** Take a worker's card, worktree and branch away. Unmerged work needs discard. */
  async remove(session: HubSession, discard: boolean) {
    const w = session.worker;
    if (!w) throw new Error('not a worker');
    if (w.worktree && w.repo && !discard) {
      const facts = await worktreeFacts(w).catch(() => undefined);
      if (facts?.dirty) throw new Error('its worktree has uncommitted changes: pass discard=true to throw them away');
      if (facts?.commits && !(await gitOk(w.repo, 'merge-base', '--is-ancestor', w.branch!, 'HEAD'))) {
        throw new Error(`branch ${w.branch} is not merged: merge it, or pass discard=true to throw it away`);
      }
    }
    // a running process holds its folder on Windows, and git could not remove it
    if (session.proc) {
      this.manager.kill(session.hubId);
      for (let i = 0; i < 24 && session.proc; i++) await new Promise((r) => setTimeout(r, 250));
    }
    await this.dropWorktree(w, discard);
    w.worktree = undefined; // nothing left for the card's removal to tidy
    this.manager.remove(session.hubId);
    this.deps.save();
  }

  private async dropWorktree(w: WorkerLink, force: boolean) {
    if (!w.worktree || !w.repo) return;
    await git(w.repo, 'worktree', 'remove', ...(force ? ['--force'] : []), w.worktree).catch((err) => console.warn(`[swarm] worktree ${w.worktree} stays: ${err}`));
    await git(w.repo, 'branch', force ? '-D' : '-d', w.branch!).catch(() => {}); // unmerged: the branch stays
  }

  /** A card removed from the dashboard: clean worktrees go, and work is never thrown away. */
  private async tidyAfterRemoval(s: HubSession) {
    const w = s.worker;
    if (!w?.worktree) return;
    const facts = await worktreeFacts(w).catch(() => undefined);
    if (!facts || facts.dirty) return;
    // the process has only just been told to stop, and it holds the folder on Windows
    setTimeout(() => void this.dropWorktree(w, false), s.proc ? 4000 : 0);
  }

  private queue(worker: HubSession, text: string) {
    const w = worker.worker!;
    w.outbox = [...(w.outbox ?? []), `[Deckhand, worker "${worker.name}" (${worker.hubId})] ${text}`];
    this.manager.emit('change', worker);
    this.deps.save();
  }

  /** Called every few seconds: move each worker along, and hand over what is waiting. */
  async tick(now = Date.now()) {
    const workers = [...this.manager.sessions.values()].filter((s) => s.worker);
    for (const s of workers) await this.step(s, now).catch((err) => console.warn(`[swarm] ${s.name}: ${err}`));
    const byArchitect = new Map<string, HubSession[]>();
    for (const s of workers) {
      if (!s.worker?.outbox?.length) continue;
      byArchitect.set(s.worker.architect, [...(byArchitect.get(s.worker.architect) ?? []), s]);
    }
    for (const [conversation, from] of byArchitect) {
      const architect = this.manager.byClaudeSessionId(conversation);
      if (!architect?.proc || architect.state !== 'IDLE' || now - architect.lastInputAt < USER_TYPING_MS) continue;
      if (this.delivering.has(architect.hubId)) continue;
      this.delivering.add(architect.hubId);
      const text = from.flatMap((s) => s.worker!.outbox!).join('\n\n');
      for (const s of from) s.worker!.outbox = undefined;
      // not from a session: a question the architect then asks is really for the user
      this.deps.promptFrom(architect, 'swarm', false);
      void this.deps.typePrompt(architect, text).finally(() => {
        this.delivering.delete(architect.hubId);
        this.deps.save();
      });
    }
  }

  private async step(s: HubSession, now: number) {
    const w = s.worker!;
    const step = workerStep(w, { alive: !!s.proc, state: s.state, stateSince: s.stateSince, detail: s.detail, autoYes: s.autoYes }, now);
    switch (step?.do) {
      case 'resume-tracking':
        w.status = 'working';
        w.nudgedAt = undefined;
        w.question = undefined;
        this.deps.save();
        return;
      case 'stopped':
        w.status = 'failed';
        w.result = `stopped without reporting (${s.detail ?? 'exited'})`;
        return this.queue(s, `stopped without reporting (${s.detail ?? 'exited'}). dh_read_exchanges shows how far it got; dh_worker_followup brings it back.`);
      case 'waiting':
        w.forwardedWait = s.stateSince;
        return this.queue(s, `is stuck at a prompt: ${s.detail ?? s.state}${s.lastTool ? ` (${s.lastTool.summary})` : ''}. dh_read_screen shows it; dh_send_keys or dh_send_prompt answers it.`);
      case 'nudge':
        w.nudgedAt = now;
        this.deps.promptFrom(s, 'session:architect', false);
        await this.deps.typePrompt(s, WORKER_NUDGE);
        return;
      case 'stalled': {
        w.status = 'stalled';
        const said = await this.deps.lastReply(s).catch(() => undefined);
        return this.queue(s, `stopped working without reporting, even when reminded. It last said:\n${(said ?? '(nothing readable)').slice(0, REPORT_MAX)}`);
      }
      default:
    }
  }
}
