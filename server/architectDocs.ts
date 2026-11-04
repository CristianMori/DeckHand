import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

/**
 * The architect documentation convention, and what the hub does to enforce it.
 * Every architect keeps docs/architect/ in its project: architecture.md (what
 * is true now) and notes/YYYY-MM-DD.md (append-only history). The hub
 *  - refuses to start a worker while architecture.md isn't in the base commit,
 *  - refuses once to remove a merged worker whose merge touched no docs,
 *  - re-feeds the documents after a compaction or resume (SessionStart hook),
 *  - counts how far a branch has moved since docs/architect/ last changed.
 * The hub never writes the documents itself: they are the architect's words.
 */

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await run('git', ['-C', cwd, ...args], { timeout: 30_000, windowsHide: true })).stdout.trim();

export const DOCS_DIR = 'docs/architect';
export const ARCHITECTURE_FILE = 'docs/architect/architecture.md';

/** Whether the lead's architecture.md exists in a commit. `sub`: the lead's folder inside the repo, forward slashes. */
export async function architectureInCommit(folder: string, commit: string, sub = ''): Promise<boolean> {
  const path = (sub ? `${sub.replace(/\\/g, '/')}/` : '') + ARCHITECTURE_FILE;
  return git(folder, 'cat-file', '-e', `${commit}:${path}`).then(() => true, () => false);
}

/** Whether architecture.md or any note changed between a base commit and HEAD, seen from the lead's folder. */
export async function docsChangedSince(folder: string, baseCommit: string): Promise<boolean> {
  return !!(await git(folder, 'diff', '--name-only', `${baseCommit}..HEAD`, '--', ARCHITECTURE_FILE, `${DOCS_DIR}/notes`));
}

/** Commits on the folder's current branch since the last one that touched docs/architect/. Undefined: not a repo. */
export async function docsBehindCount(folder: string): Promise<number | undefined> {
  try {
    const last = await git(folder, 'rev-list', '-1', 'HEAD', '--', DOCS_DIR);
    const count = await git(folder, 'rev-list', '--count', last ? `${last}..HEAD` : 'HEAD');
    return Number(count) || 0;
  } catch {
    return undefined; // not a git repository, or no commits yet
  }
}

/** True when the folder has no committed-or-not architecture.md to read. */
export function docsMissing(cwd: string): boolean {
  return !existsSync(join(cwd, 'docs', 'architect', 'architecture.md'));
}

/** The line the architect is handed for architecture.md's "In flight" list when a worker starts. */
export function inFlightLine(name: string, branch: string | undefined, task: string): string {
  const summary = (task.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 120);
  return `- ⚙ ${name}${branch ? ` — ⎇ ${branch}` : ''}: ${summary}`;
}

/** How long a docs refusal is remembered: removing the same worker again inside this window goes through. */
export const DOCS_RETRY_WINDOW_MS = 10 * 60_000;

/**
 * Whether removing a merged worker is refused because the merge updated no
 * documentation. Refused once: the caller owns `reminded` (worker id → when it
 * was refused), and a second removal within DOCS_RETRY_WINDOW_MS goes through.
 * docsChanged undefined means it could not be checked (an older hub, a folder
 * that is gone): nobody is held to what can't be seen. Pure, like
 * architectEditDecision, so the logic tests without a hub.
 */
export function docsMergeDecision(
  reminded: Map<string, number>,
  workerId: string,
  state: { merged: boolean; docsChanged?: boolean; report?: string },
  now: number = Date.now(),
): string | null {
  if (!state.merged || state.docsChanged !== false) return null;
  if (/docs:\s*no change/i.test(state.report ?? '')) return null;
  for (const [k, t] of reminded) if (now - t > DOCS_RETRY_WINDOW_MS) reminded.delete(k);
  if (reminded.has(workerId)) return null;
  reminded.set(workerId, now);
  return (
    `Deckhand refused this removal once: the branch was merged, but neither ${ARCHITECTURE_FILE} nor ${DOCS_DIR}/notes/ ` +
    `changed since the worker branched, and its report doesn't say "Docs: no change". Update architecture.md and today's note ` +
    `(and take the worker's line out of "In flight"), commit, then remove it again. Calling dh_remove_worker again within 10 minutes removes it anyway.`
  );
}

/** What a session newly made an architect is told when its folder has no docs/architect/ yet. */
export const CREATE_DOCS_PROMPT = `[Deckhand] You are this project's architect now, and ${ARCHITECTURE_FILE} does not exist yet. Before anything else, create docs/architect/ and commit it: architecture.md (what is true now — the parts, how they talk, and why — with Mermaid diagrams; anything that exists only on a branch marked "⎇ <branch> (not merged)", plus an "In flight" list of workers out right now), notes/<today's date>.md (append-only history: the user's requests quoted verbatim, decisions with the options weighed and why, what happened, open items), a README.md explaining the folder, and assets/. Standard relative links (no wikilinks) and YAML front matter, self-contained, so the folder reads the same on GitHub and dropped into Obsidian. If the project is large, have a worker survey it first. Never put secrets, phone numbers, IP addresses or real machine names in it: write machines and people as roles. The hub will refuse to start workers until architecture.md is committed.`;

/**
 * Claude Code caps a SessionStart hook's additionalContext at 10,000
 * characters (anything longer is spilled to a file the agent is not asked to
 * read), so the refeed stays under it however the documents have grown.
 */
export const REFEED_CAP = 9_500;
const NOTE_CAP = 2_200;
const ARCHITECTURE_MIN = 2_000;

function clip(text: string, limit: number, file: string): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[…cut by Deckhand: ${text.length - limit} more characters — read ${file} for the rest.]`;
}

/** The post-compaction refeed, composed from the documents' text. Undefined: nothing to say. */
export function composeDocsRefeed(
  architecture: string | undefined,
  notes: { name: string; text: string }[],
  cap: number = REFEED_CAP,
): string | undefined {
  if (!architecture && !notes.length) return undefined;
  const header = `[Deckhand] Your context was compacted or resumed. ${ARCHITECTURE_FILE} is your memory: this is its committed state and the newest note${notes.length === 1 ? '' : 's'}, re-read the files themselves if anything looks stale.`;
  const noteParts = notes.map((n) => {
    const file = `${DOCS_DIR}/notes/${n.name}`;
    return `--- ${file} ---\n${clip(n.text, NOTE_CAP, file)}`;
  });
  const parts = [header, ...noteParts];
  if (architecture) {
    const used = parts.reduce((a, p) => a + p.length + 2, 0);
    const budget = Math.max(ARCHITECTURE_MIN, cap - used - 40);
    parts.splice(1, 0, `--- ${ARCHITECTURE_FILE} ---\n${clip(architecture, budget, ARCHITECTURE_FILE)}`);
  }
  return parts.join('\n\n').slice(0, cap + 200);
}

/** Read a folder's docs/architect/ and compose the refeed. Undefined: no documents, or unreadable. */
export function readDocsRefeed(cwd: string): string | undefined {
  try {
    const dir = join(cwd, 'docs', 'architect');
    let architecture: string | undefined;
    try {
      architecture = readFileSync(join(dir, 'architecture.md'), 'utf8');
    } catch {
      /* no architecture.md yet */
    }
    let notes: { name: string; text: string }[] = [];
    try {
      notes = readdirSync(join(dir, 'notes'))
        .filter((f) => /^\d{4}-\d{2}-\d{2}.*\.md$/i.test(f))
        .sort()
        .slice(-2)
        .map((name) => ({ name, text: readFileSync(join(dir, 'notes', name), 'utf8') }));
    } catch {
      /* no notes yet */
    }
    return composeDocsRefeed(architecture, notes);
  } catch {
    return undefined;
  }
}
