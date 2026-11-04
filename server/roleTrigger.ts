import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { matchesPaths, type RoleCharter, type RoleSkip } from './roleCharters.js';
import type { RoleStart } from './swarm.js';

/**
 * When specialist roles run. The hub owns no hook inside the user's repository,
 * so the one moment it reliably sees "a merge landed" is the merged-branch
 * check on the lead's hub: swarm.remove() for local workers, the worker-merged
 * route for cross-machine ones — both feed onMerge(), and so does the manual
 * "run now" (POST /api/sessions/:id/run-role). For each enabled charter the
 * merge's diff is held against the charter's paths and skip rules, a run
 * ledger makes retries and refuse-once loops one run, a 10-minute cooldown is
 * judged on the incremental diff since the last run, and at most one instance
 * runs per (project, role, platform) — a merge landing meanwhile records a
 * pending head that fires once the running instance's report is acked.
 * The decision itself is pure (roleRunDecision), so it tests without a hub.
 */

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await run('git', ['-C', cwd, ...args], { timeout: 30_000, windowsHide: true })).stdout.trim();

export const gitHead = (folder: string) => git(folder, 'rev-parse', 'HEAD');

export const ROLE_COOLDOWN_MS = 10 * 60_000;
const LEDGER_MAX = 200;

/** One slot's last run, and at most one head waiting behind it. */
export interface RoleRun {
  head: string;
  at: number;
  pendingHead?: string;
}

/**
 * One run per (project, role, platform, head), on disk so a hub restart
 * doesn't re-run everything. Insertion order is the LRU order: a slot that
 * runs again moves to the back, and the oldest fall off past LEDGER_MAX.
 */
export class RoleLedger {
  private runs = new Map<string, RoleRun>();

  constructor(private file?: string) {
    if (!file) return;
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, RoleRun>;
      for (const [k, v] of Object.entries(data ?? {})) {
        if (v && typeof v.head === 'string' && typeof v.at === 'number') this.runs.set(k, v);
      }
    } catch {
      /* no ledger yet */
    }
  }

  get(key: string): RoleRun | undefined {
    return this.runs.get(key);
  }

  /** A run started on this head. */
  ran(key: string, head: string, at = Date.now()) {
    this.runs.delete(key);
    this.runs.set(key, { head, at });
    while (this.runs.size > LEDGER_MAX) this.runs.delete(this.runs.keys().next().value!);
    this.save();
  }

  /** A merge landed while an instance runs: one head waits, always the newest. */
  pend(key: string, head: string) {
    const entry = this.runs.get(key) ?? { head: '', at: 0 };
    entry.pendingHead = head;
    this.runs.delete(key);
    this.runs.set(key, entry);
    this.save();
  }

  /** The waiting head, if any, with the last run's head as its base; taking it clears it. */
  takePending(key: string): { head: string; base?: string } | undefined {
    const entry = this.runs.get(key);
    if (!entry?.pendingHead) return undefined;
    const out = { head: entry.pendingHead, base: entry.head || undefined };
    delete entry.pendingHead;
    this.save();
    return out;
  }

  private save() {
    if (!this.file) return;
    try {
      writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.runs)));
    } catch (err) {
      console.warn(`[roles] ledger not saved: ${err}`);
    }
  }
}

export interface RoleDiff {
  files: string[];
  insertions: number;
  deletions: number;
}

/** Why a charter's skip rules pass on this diff, or undefined when it is worth a run. */
export function skipReason(skip: RoleSkip, diff: RoleDiff): string | undefined {
  if (skip.underLines && diff.insertions + diff.deletions < skip.underLines) {
    return `diff under ${skip.underLines} lines (+${diff.insertions} −${diff.deletions})`;
  }
  if (skip.docsOnly && diff.files.length && diff.files.every((f) => /^docs\//i.test(f) || /\.md$/i.test(f))) {
    return 'only documentation changed';
  }
  return undefined;
}

export type RoleDecision =
  | { do: 'run' }
  | { do: 'skip'; reason: string }
  | { do: 'pending' }
  /** within the cooldown: the caller computes the diff since the last run's head and asks again */
  | { do: 'need-incremental'; since: string };

/** Whether one (project, role, platform) slot runs on this merge. Pure: the caller owns the ledger and git. */
export function roleRunDecision(
  charter: { enabled: boolean; skip: RoleSkip },
  trig: { head: string; manual?: boolean } & RoleDiff,
  state: { last?: RoleRun; live: boolean },
  now: number,
  incremental?: RoleDiff,
): RoleDecision {
  if (!charter.enabled) return { do: 'skip', reason: 'disabled' };
  if (trig.manual) return { do: 'run' }; // a hand on the button outranks every economy
  const below = skipReason(charter.skip, trig);
  if (below) return { do: 'skip', reason: below };
  if (state.last?.head === trig.head) return { do: 'skip', reason: 'already ran on this head' };
  if (state.live) return { do: 'pending' };
  if (state.last?.head && now - state.last.at < ROLE_COOLDOWN_MS) {
    if (!incremental) return { do: 'need-incremental', since: state.last.head };
    const incBelow = skipReason(charter.skip, incremental);
    if (incBelow) return { do: 'skip', reason: `within the cooldown, and since ${state.last.head.slice(0, 7)}: ${incBelow}` };
  }
  return { do: 'run' };
}

/** A hub that could host an instance: this one (self) or a connected peer. */
export interface PlatformSeat {
  platform: string;
  machine?: string;
  self?: boolean;
}

/** Which (platform, machine) seats a charter claims among what is reachable right now. */
export function fanOutPlatforms(
  platforms: RoleCharter['platforms'],
  seats: PlatformSeat[],
): { platform: string; machine?: string; label?: string }[] {
  const self = seats.find((s) => s.self);
  if (platforms === 'any') return self ? [{ platform: self.platform }] : [];
  const wanted = platforms === 'all' ? [...new Set(seats.map((s) => s.platform))] : platforms;
  const out: { platform: string; machine?: string; label?: string }[] = [];
  for (const p of wanted) {
    const seat = seats.find((s) => s.self && s.platform === p) ?? seats.find((s) => s.platform === p);
    if (!seat) continue; // an unreachable platform is simply not run, this time
    out.push({ platform: p, machine: seat.self ? undefined : seat.machine, label: p });
  }
  return out;
}

/** What onMerge needs from its session: enough of a HubSession, and fakeable in tests. */
export interface RoleLead {
  cwd: string;
  name: string;
  proc: unknown;
}

export interface RoleTriggerEvent {
  project: string;
  folder: string;
  base?: string;
  head: string;
  manual?: boolean;
  /** only this role (a manual run's button, or a pending head firing) */
  role?: string;
}

export interface RoleTriggerDeps<L extends RoleLead = RoleLead> {
  /** charter names known without the project layer (built-in + fleet) */
  names: () => string[];
  /** the effective charter, the project layer's text already read from the lead's working folder */
  resolve: (name: string, projectText?: string) => RoleCharter | undefined;
  /** swarm.startRole, injected to avoid an import cycle */
  startRole: (lead: L, charter: RoleCharter, trig: RoleStart) => Promise<unknown>;
  /** this hub and its connected peers, by OS */
  seats: () => PlatformSeat[];
  /** an instance for this slot is still going somewhere in the fleet (not reported/failed) */
  liveInstance: (project: string, role: string, platform: string) => boolean;
  ledger: RoleLedger;
}

export interface RoleRunSummary {
  started: string[];
  skipped: { role: string; reason: string }[];
}

async function mergeDiff(folder: string, base: string, head: string): Promise<RoleDiff> {
  const [names, numstat] = await Promise.all([
    git(folder, 'diff', '--name-only', `${base}..${head}`),
    git(folder, 'diff', '--numstat', `${base}..${head}`),
  ]);
  let insertions = 0;
  let deletions = 0;
  for (const line of numstat ? numstat.split('\n') : []) {
    const [i, d] = line.split('\t'); // '-' for binary files reads as 0
    insertions += Number(i) || 0;
    deletions += Number(d) || 0;
  }
  return { files: names ? names.split('\n') : [], insertions, deletions };
}

const warnedProjectCharters = new Set<string>();

/**
 * A role's project-layer charter: the architect's living file in the lead's
 * working folder (docs/architect/ is not in git, so there is no commit to read
 * it from; the trigger always runs on the lead's hub, where the folder is).
 * Missing file: no project layer. Unreadable: the layer is skipped, warned once.
 */
function projectCharterText(folder: string, name: string): string | undefined {
  const file = join(folder, 'docs', 'architect', 'roles', `${name}.md`);
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      const key = `${folder}|${name}`;
      if (!warnedProjectCharters.has(key)) {
        warnedProjectCharters.add(key);
        console.warn(`[roles] project charter ${name} is skipped: ${err instanceof Error ? err.message : err}`);
      }
    }
    return undefined;
  }
}

/**
 * A merge landed in a lead's repository (or its "run now" button was pressed):
 * decide, per enabled charter and per platform, whether an instance runs.
 * Fires on the lead's hub. Answers what it started and what it skipped and why.
 */
export async function onMerge<L extends RoleLead>(lead: L, ev: RoleTriggerEvent, deps: RoleTriggerDeps<L>): Promise<RoleRunSummary> {
  const out: RoleRunSummary = { started: [], skipped: [] };
  const names = ev.role ? [ev.role] : deps.names();
  if (!lead.proc) {
    console.log(`[roles] ${ev.project}: merge ${ev.head.slice(0, 7)} seen, but the lead session is not running — nobody to report to`);
    for (const name of names) out.skipped.push({ role: name, reason: 'the lead session is not running' });
    return out;
  }
  const now = Date.now();
  const diff: RoleDiff =
    ev.manual || !ev.base ? { files: [], insertions: 0, deletions: 0 } : await mergeDiff(ev.folder, ev.base, ev.head);
  for (const name of names) {
    const text = projectCharterText(ev.folder, name);
    const charter = deps.resolve(name, text);
    if (!charter) {
      out.skipped.push({ role: name, reason: 'no such role' });
      continue;
    }
    if (!charter.enabled) {
      out.skipped.push({ role: name, reason: 'disabled' });
      continue;
    }
    if (!ev.manual && !matchesPaths(charter, diff.files)) {
      out.skipped.push({ role: name, reason: 'no changed file matches its paths' });
      continue;
    }
    const targets = fanOutPlatforms(charter.platforms, deps.seats());
    if (!targets.length) out.skipped.push({ role: name, reason: 'no reachable machine has a platform it asks for' });
    for (const t of targets) {
      const slot = `${ev.project}|${name}|${t.platform}`;
      const tag = t.label ? `${name} (${t.platform})` : name;
      const state = { last: deps.ledger.get(slot), live: deps.liveInstance(ev.project, name, t.platform) };
      let decision = roleRunDecision(charter, { ...diff, head: ev.head, manual: ev.manual }, state, now);
      if (decision.do === 'need-incremental') {
        const inc = await mergeDiff(ev.folder, decision.since, ev.head).catch(() => diff);
        decision = roleRunDecision(charter, { ...diff, head: ev.head, manual: ev.manual }, state, now, inc);
      }
      if (decision.do === 'skip') {
        out.skipped.push({ role: tag, reason: decision.reason });
        console.log(`[roles] ${ev.project}: ${tag} skipped on ${ev.head.slice(0, 7)} — ${decision.reason}`);
        continue;
      }
      if (decision.do === 'pending') {
        deps.ledger.pend(slot, ev.head);
        out.skipped.push({ role: tag, reason: 'an instance is still running: this head runs when its report is read' });
        console.log(`[roles] ${ev.project}: ${tag} busy — ${ev.head.slice(0, 7)} waits`);
        continue;
      }
      try {
        await deps.startRole(lead, charter, {
          project: ev.project,
          base: ev.base,
          head: ev.head,
          files: diff.files,
          insertions: diff.insertions,
          deletions: diff.deletions,
          manual: ev.manual,
          machine: t.machine,
          platformLabel: t.label,
        });
        deps.ledger.ran(slot, ev.head, now);
        out.started.push(tag);
        console.log(`[roles] ${ev.project}: ${tag} started on merge ${ev.head.slice(0, 7)}${t.machine ? ` on ${t.machine}` : ''}`);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        out.skipped.push({ role: tag, reason: `could not start: ${why}` });
        console.warn(`[roles] ${ev.project}: ${tag} could not start — ${why}`);
      }
    }
  }
  return out;
}

/**
 * A role instance's report was acked (swarm.ackInbox): if a merge landed while
 * it ran, the recorded pending head fires once, diffed from the last run's
 * head, so bursts of merges coalesce into one follow-up run.
 */
export async function reportAcked<L extends RoleLead>(
  lead: L,
  w: { charter?: string; project?: string; platform?: string },
  deps: RoleTriggerDeps<L>,
): Promise<RoleRunSummary | undefined> {
  if (!w.charter || !w.project || !w.platform) return undefined;
  const pending = deps.ledger.takePending(`${w.project}|${w.charter}|${w.platform}`);
  if (!pending) return undefined;
  console.log(`[roles] ${w.project}: firing the pending head ${pending.head.slice(0, 7)} for ${w.charter}`);
  return onMerge(lead, { project: w.project, folder: lead.cwd, base: pending.base, head: pending.head, role: w.charter }, deps);
}
