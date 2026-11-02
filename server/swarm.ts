import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DATA_DIR } from './config.js';
import { folderNameOf } from './frozen.js';
import { projectFolderOf } from './etiquette.js';
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
 *
 * A worker can run on another machine. Nothing is assumed to be shared: its
 * hub keeps a bare mirror per project under data/worktrees, the base commit
 * arrives as a git bundle, and the architect's hub fetches the branch back as
 * a bundle before it accepts the report. A message only leaves the worker's
 * outbox once the other hub has it, so a machine being away just delays it.
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
const RETRY_MS = 15_000;

export const WORKER_NUDGE =
  'Your turn ended without a report. If the task is done, commit and call dh_report. If you are blocked, call dh_ask_architect. Otherwise carry on.';

/** A project's name holds on every machine: its folder name under the projects root. */
function projectName(cwd: string) {
  return projectFolderOf(cwd) ?? folderNameOf(cwd);
}

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

const WORKTREES = join(DATA_DIR, 'worktrees');

/** Where a folder's repository stands, or undefined when it isn't in one. */
async function repoBase(folder: string) {
  const top = await git(folder, 'rev-parse', '--show-toplevel').catch(() => undefined);
  if (!top) return undefined; // not a git repo: there is nothing to isolate with
  const baseCommit = await git(folder, 'rev-parse', 'HEAD').catch(() => undefined);
  if (!baseCommit) throw new Error('the repository has no commits yet: commit something first, a worker branches from it');
  // a session in a subfolder gets its worker in the same subfolder
  const sub = relative(resolve(top), resolve(folder));
  return { top, baseCommit, sub, baseDirty: !!(await git(folder, 'status', '--porcelain')) };
}

async function addWorktree(repo: string, baseCommit: string, name: string, root: string) {
  mkdirSync(root, { recursive: true });
  const dir = `${slug(name)}-${randomBytes(3).toString('hex')}`;
  const worktree = join(root, dir);
  const branch = `worker/${dir}`;
  await git(repo, 'worktree', 'add', '-b', branch, worktree, baseCommit);
  return { worktree, branch };
}

/** The worker's own branch off the folder's current commit, outside every synced folder. */
export async function createWorktree(folder: string, name: string, root = WORKTREES) {
  const base = await repoBase(folder);
  if (!base) return undefined;
  const tree = await addWorktree(base.top, base.baseCommit, name, root);
  return { ...tree, baseCommit: base.baseCommit, repo: base.top, cwd: base.sub ? join(tree.worktree, base.sub) : tree.worktree, baseDirty: base.baseDirty };
}

/** Run with a temp file for a bundle, removed afterwards. */
async function withBundleFile<T>(run: (file: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'deckhand-bundle-'));
  try {
    return await run(join(dir, 'x.bundle'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The bare repository that holds a project on a machine where it runs workers only. */
export async function projectMirror(project: string, root = WORKTREES) {
  const dir = join(root, '.mirrors', `${slug(project)}.git`);
  mkdirSync(dir, { recursive: true });
  await git(dir, 'init', '-q', '--bare');
  return dir;
}

/** What a mirror already holds, for the sender to leave out. */
export async function mirrorHeads(mirror: string): Promise<string[]> {
  const out = await git(mirror, 'for-each-ref', '--count=100', '--sort=-committerdate', '--format=%(objectname)', 'refs/deckhand/base');
  return out ? out.split('\n') : [];
}

/** A commit as bytes, minus what the other side has. Undefined: it has the commit already. */
export async function bundleCommit(repo: string, commit: string, have: string[]): Promise<Buffer | undefined> {
  if (have.includes(commit)) return undefined;
  const known: string[] = [];
  for (const sha of have) if (/^[0-9a-f]{40,64}$/.test(sha) && (await gitOk(repo, 'cat-file', '-e', `${sha}^{commit}`))) known.push(sha);
  const ref = `refs/deckhand/send/${commit}`;
  await git(repo, 'update-ref', ref, commit);
  try {
    return await withBundleFile(async (file) => {
      await run('git', ['-C', repo, 'bundle', 'create', '-q', file, ref, ...known.map((k) => `^${k}`)], { timeout: 300_000, windowsHide: true, maxBuffer: 1 << 26 });
      return readFileSync(file);
    });
  } finally {
    await git(repo, 'update-ref', '-d', ref).catch(() => {});
  }
}

export async function receiveCommit(mirror: string, bytes: Buffer) {
  await withBundleFile(async (file) => {
    writeFileSync(file, bytes);
    await run('git', ['-C', mirror, 'fetch', '-q', file, 'refs/deckhand/send/*:refs/deckhand/base/*'], { timeout: 300_000, windowsHide: true });
  });
}

/** The worker's commits as bytes, for the architect's repository, which has their base. */
export async function bundleBranch(repo: string, branch: string, baseCommit: string): Promise<Buffer> {
  return withBundleFile(async (file) => {
    await run('git', ['-C', repo, 'bundle', 'create', '-q', file, `refs/heads/${branch}`, `^${baseCommit}`], { timeout: 300_000, windowsHide: true, maxBuffer: 1 << 26 });
    return readFileSync(file);
  });
}

/** Into the architect's repository, as a branch of the same name. A follow-up moves it on. */
export async function receiveBranch(folder: string, branch: string, bytes: Buffer) {
  await withBundleFile(async (file) => {
    writeFileSync(file, bytes);
    await run('git', ['-C', folder, 'fetch', '-q', file, `+refs/heads/${branch}:refs/heads/${branch}`], { timeout: 300_000, windowsHide: true });
  });
}

export const isMergedHere = (folder: string, commit: string) => gitOk(folder, 'merge-base', '--is-ancestor', commit, 'HEAD');
export const dropBranchHere = (folder: string, branch: string, force: boolean) => git(folder, 'branch', force ? '-D' : '-d', branch);

export interface StartWorker {
  task: string;
  name?: string;
  agentType?: string;
  model?: string;
  permissionMode?: string;
  /** another fleet machine to run it on */
  machine?: string;
}

/** What the worker's hub is told by the architect's. */
export interface HostWorker {
  task: string;
  name: string;
  agentType?: string;
  model?: string;
  permissionMode?: string;
  project: string;
  baseCommit: string;
  sub: string;
  architect: string;
  architectName: string;
  architectMachine: string;
  baseFolder: string;
  author?: { name: string; email: string };
}

export type Hop = (machine: string, path: string, body: unknown) => Promise<{ status: number; body: any }>;

/** Reaching other hubs. Absent on a hub with no peers to reach, as in tests. */
export interface SwarmFleet {
  self: string;
  call: Hop;
  upload: (machine: string, path: string, bytes: Buffer) => Promise<{ status: number; body: any }>;
  /** the hub with this architect, live: undefined when it isn't reachable */
  callArchitect: (conversation: string, path: string, body: unknown) => Promise<{ status: number; body: any } | undefined>;
  isFrozen: (folder: string) => boolean;
}

export class Swarm {
  /** architects with a prompt being typed right now */
  private delivering = new Set<string>();
  /** sessions with a message on its way to another hub, and when to try a failed one again */
  private sending = new Set<string>();
  private retryAt = new Map<string, number>();

  constructor(
    private manager: SessionManager,
    private deps: {
      typePrompt: (session: HubSession, text: string) => Promise<unknown>;
      /** the prompt coming: the sender answers a worker's questions, the user an architect's */
      promptFrom: (session: HubSession, caller: string, queued: boolean) => void;
      lastReply: (session: HubSession) => Promise<string | undefined>;
      save: () => void;
      fleet?: SwarmFleet;
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
    if (opts.machine && opts.machine !== this.deps.fleet?.self) return this.startElsewhere(architect, { ...opts, task, name }, opts.machine);
    const tree = await createWorktree(architect.cwd, name);
    const worker: WorkerLink = {
      architect: architect.claudeSessionId,
      architectName: architect.name,
      task,
      baseFolder: architect.cwd,
      project: projectName(architect.cwd),
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
    return { session, info: undefined, baseDirty: tree?.baseDirty ?? false, isolated: !!tree };
  }

  /** On the architect's hub: get the code to the other machine, and start the worker there. */
  private async startElsewhere(architect: HubSession, opts: StartWorker & { name: string }, machine: string) {
    const fleet = this.deps.fleet;
    if (!fleet) throw new Error('this hub has no fleet to reach');
    const project = projectName(architect.cwd);
    // freezing a folder promises its code stays on this machine
    if (fleet.isFrozen(folderNameOf(architect.cwd))) throw new Error(`${project} is frozen to this machine: its code can't go to ${machine}. Run the worker here, or unfreeze it.`);
    const base = await repoBase(architect.cwd);
    if (!base) throw new Error(`${project} is not a git repository, so nothing can carry its code to ${machine}. Run the worker here.`);
    const ask = async (path: string, body: unknown) => {
      const out = await fleet.call(machine, path, body).catch(() => undefined);
      if (!out) throw new Error(`machine not reachable: ${machine}`);
      if (out.status === 404) throw new Error(`${machine} doesn't know about workers yet: update its hub`);
      if (out.status !== 200) throw new Error(`${machine}: ${out.body?.error ?? out.status}`);
      return out.body;
    };
    const { heads } = await ask('/api/worker-host/heads', { project });
    const bytes = await bundleCommit(base.top, base.baseCommit, heads);
    if (bytes) {
      const sent = await fleet.upload(machine, `/api/worker-host/commit?project=${encodeURIComponent(project)}`, bytes).catch(() => undefined);
      if (sent?.status !== 200) throw new Error(`could not send the code to ${machine}: ${sent?.body?.error ?? 'not reachable'}`);
    }
    const author = await Promise.all([git(base.top, 'config', 'user.name'), git(base.top, 'config', 'user.email')]).catch(() => undefined);
    const host: HostWorker = {
      task: opts.task,
      name: opts.name,
      agentType: opts.agentType ?? architect.agentType,
      model: opts.model ?? architect.model,
      permissionMode: opts.permissionMode,
      project,
      baseCommit: base.baseCommit,
      sub: base.sub.replace(/\\/g, '/'),
      architect: architect.claudeSessionId,
      architectName: architect.name,
      architectMachine: fleet.self,
      baseFolder: architect.cwd,
      author: author && { name: author[0], email: author[1] },
    };
    const info = await ask('/api/worker-host/start', host);
    return { session: undefined, info, baseDirty: base.baseDirty, isolated: true };
  }

  /** On the worker's hub: the code has arrived, so give it a checkout and start. */
  async hostWorker(h: HostWorker) {
    const repo = await projectMirror(h.project);
    if (h.author?.name) await git(repo, 'config', 'user.name', h.author.name);
    if (h.author?.email) await git(repo, 'config', 'user.email', h.author.email);
    const tree = await addWorktree(repo, h.baseCommit, h.name, WORKTREES);
    const session = this.manager.create({
      cwd: h.sub ? join(tree.worktree, h.sub) : tree.worktree,
      name: h.name,
      agentType: h.agentType,
      model: h.model,
      permissionMode: h.permissionMode,
      initialPrompt: h.task,
      role: 'worker',
      worker: {
        architect: h.architect,
        architectName: h.architectName,
        architectMachine: h.architectMachine,
        task: h.task,
        baseFolder: h.baseFolder,
        project: h.project,
        worktree: tree.worktree,
        repo,
        branch: tree.branch,
        baseCommit: h.baseCommit,
        status: 'working',
        startedAt: Date.now(),
      },
    });
    session.autoYes = true;
    this.deps.promptFrom(session, 'session:architect', true);
    this.manager.emit('change', session);
    this.deps.save();
    return session;
  }

  /** On the architect's hub: a worker elsewhere has something to say. */
  acceptMessage(architect: HubSession, text: string) {
    architect.inbox = [...(architect.inbox ?? []), text];
    this.manager.emit('change', architect);
    this.deps.save();
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
    if (w.architectMachine && facts.commits) w.sendBranch = true;
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
      if (facts?.commits && !(await this.isMerged(w))) {
        throw new Error(`branch ${w.branch} is not merged: merge it, or pass discard=true to throw it away`);
      }
    }
    // a running process holds its folder on Windows, and git could not remove it
    if (session.proc) {
      this.manager.kill(session.hubId);
      for (let i = 0; i < 24 && session.proc; i++) await new Promise((r) => setTimeout(r, 250));
    }
    // merged in the architect's repo, not the mirror here: checked above, so the mirror's copy can go
    await this.dropWorktree(w, discard || !!w.architectMachine);
    // the copy it fetched has served its purpose too
    if (w.architectMachine && w.branch) await this.deps.fleet?.callArchitect(w.architect, 'worker-branch-gone', { branch: w.branch, discard }).catch(() => {});
    w.worktree = undefined; // nothing left for the card's removal to tidy
    this.manager.remove(session.hubId);
    this.deps.save();
  }

  private async isMerged(w: WorkerLink) {
    if (!w.architectMachine) return gitOk(w.repo!, 'merge-base', '--is-ancestor', w.branch!, 'HEAD');
    const head = await git(w.repo!, 'rev-parse', `refs/heads/${w.branch}`);
    const out = await this.deps.fleet?.callArchitect(w.architect, 'worker-merged', { commit: head }).catch(() => undefined);
    if (!out) throw new Error(`can't check whether ${w.branch} was merged: its architect isn't reachable. Pass discard=true to remove it anyway`);
    return out.status === 200 && !!out.body?.merged;
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
      const lead = this.manager.byClaudeSessionId(s.worker.architect);
      // not running here: it's on another machine, or stopped and will be back
      if (!lead?.proc) {
        this.sendAcross(s, now);
        continue;
      }
      byArchitect.set(s.worker.architect, [...(byArchitect.get(s.worker.architect) ?? []), s]);
    }
    const architects = new Set(byArchitect.keys());
    for (const s of this.manager.sessions.values()) {
      if (!s.inbox?.length) continue;
      if (s.proc) architects.add(s.claudeSessionId);
      else this.passInboxOn(s, now); // it moved to another machine since
    }
    for (const conversation of architects) {
      const from = byArchitect.get(conversation) ?? [];
      const architect = this.manager.byClaudeSessionId(conversation);
      if (!architect?.proc || architect.state !== 'IDLE' || now - architect.lastInputAt < USER_TYPING_MS) continue;
      if (this.delivering.has(architect.hubId)) continue;
      this.delivering.add(architect.hubId);
      const text = [...(architect.inbox ?? []), ...from.flatMap((s) => s.worker!.outbox!)].join('\n\n');
      architect.inbox = undefined;
      for (const s of from) s.worker!.outbox = undefined;
      // not from a session: a question the architect then asks is really for the user
      this.deps.promptFrom(architect, 'swarm', false);
      void this.deps.typePrompt(architect, text).finally(() => {
        this.delivering.delete(architect.hubId);
        this.deps.save();
      });
    }
  }

  /** Only once the other hub has the message, and the branch it talks about, is it off our hands. */
  private sendAcross(s: HubSession, now: number) {
    const fleet = this.deps.fleet;
    if (!fleet || this.sending.has(s.hubId) || (this.retryAt.get(s.hubId) ?? 0) > now) return;
    const w = s.worker!;
    const texts = [...w.outbox!];
    const body = { text: texts.join('\n\n'), worker: s.claudeSessionId, branch: w.sendBranch ? w.branch : undefined };
    this.sending.add(s.hubId);
    void fleet.callArchitect(w.architect, 'worker-message', body).then((out) => {
      if (out?.status !== 200) return void this.retryAt.set(s.hubId, Date.now() + RETRY_MS);
      this.retryAt.delete(s.hubId);
      w.outbox = w.outbox?.slice(texts.length);
      if (!w.outbox?.length) w.outbox = undefined;
      if (body.branch) w.sendBranch = false;
      this.deps.save();
    }).catch(() => void this.retryAt.set(s.hubId, Date.now() + RETRY_MS)).finally(() => this.sending.delete(s.hubId));
  }

  private passInboxOn(s: HubSession, now: number) {
    const fleet = this.deps.fleet;
    if (!fleet || this.sending.has(s.hubId) || (this.retryAt.get(s.hubId) ?? 0) > now) return;
    const texts = [...s.inbox!];
    this.sending.add(s.hubId);
    void fleet.callArchitect(s.claudeSessionId, 'worker-message', { text: texts.join('\n\n') }).then((out) => {
      if (out?.status !== 200) return void this.retryAt.set(s.hubId, Date.now() + RETRY_MS);
      s.inbox = s.inbox?.slice(texts.length);
      if (!s.inbox?.length) s.inbox = undefined;
      this.deps.save();
    }).catch(() => void this.retryAt.set(s.hubId, Date.now() + RETRY_MS)).finally(() => this.sending.delete(s.hubId));
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
