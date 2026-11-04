import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

/**
 * The architect documentation convention, and what the hub does to enforce it.
 * Every architect keeps docs/architect/ in its project: architecture.md (what
 * is true now) and notes/YYYY-MM-DD.md (append-only history). The folder is
 * NOT tracked in git: it is listed in the project's .gitignore and moves
 * between machines with Deckhand's own folder sync, so every check reads the
 * lead's working folder, never a commit. The hub
 *  - refuses to start a worker while architecture.md isn't in the lead's folder,
 *  - refuses once to remove a merged worker while the lead's docs are
 *    fingerprint-identical to when the worker started,
 *  - re-feeds the documents after a compaction or resume (SessionStart hook),
 *  - counts the commits made after docs/architect/ was last modified.
 * The hub never writes the documents itself: they are the architect's words.
 * The convention: docs/architect-convention.md in the Deckhand repository.
 */

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await run('git', ['-C', cwd, ...args], { timeout: 30_000, windowsHide: true })).stdout.trim();

export const DOCS_DIR = 'docs/architect';
export const ARCHITECTURE_FILE = 'docs/architect/architecture.md';

/**
 * A fingerprint of a folder's working docs/architect/: a hash of
 * architecture.md's text plus the notes files' names and sizes. Taken when a
 * worker starts and compared when it is removed: unchanged means the merge
 * went undocumented. Undefined: no architecture.md to fingerprint.
 */
export function docsFingerprint(cwd: string): string | undefined {
  const dir = join(cwd, 'docs', 'architect');
  let hash;
  try {
    hash = createHash('sha256').update(readFileSync(join(dir, 'architecture.md')));
  } catch {
    return undefined;
  }
  try {
    for (const f of readdirSync(join(dir, 'notes')).sort()) hash.update(`\n${f}:${statSync(join(dir, 'notes', f)).size}`);
  } catch {
    /* no notes yet */
  }
  return hash.digest('hex');
}

/** When any file under docs/architect/ was last modified, in ms. Undefined: no folder. */
function newestDocsMtime(folder: string): number | undefined {
  const walk = (dir: string): number => {
    let newest = 0;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      newest = Math.max(newest, e.isDirectory() ? walk(p) : statSync(p).mtimeMs);
    }
    return newest;
  };
  try {
    return walk(join(folder, 'docs', 'architect')) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Commits on the folder's current branch made after the working docs/architect/
 * was last modified (the docs are untracked, so their mtime is the only clock
 * they have). Undefined: not a repo.
 */
export async function docsBehindCount(folder: string): Promise<number | undefined> {
  try {
    const since = newestDocsMtime(folder);
    const count = await git(folder, 'rev-list', '--count', ...(since ? [`--since=@${Math.floor(since / 1000)}`] : []), 'HEAD');
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
    `in your folder changed since the worker started, and its report doesn't say "Docs: no change". Write what its report's "Docs:" section ` +
    `says into architecture.md and today's note (and take the worker's line out of "In flight"), then remove it again. ` +
    `Calling dh_remove_worker again within 10 minutes removes it anyway.`
  );
}

/** What a session newly made an architect is told when its folder has no docs/architect/ yet. */
export const CREATE_DOCS_PROMPT = `[Deckhand] You are this project's architect now, and ${ARCHITECTURE_FILE} does not exist yet. Before anything else, create docs/architect/ and add \`docs/architect/\` to the project's .gitignore — the folder is never committed: it stays untracked and moves between machines with Deckhand's own folder sync. In it: architecture.md (what is true now — the parts, how they talk, and why — with Mermaid diagrams; a "## Summary" section right after the title; anything that exists only on a branch marked "⎇ <branch> (not merged)", plus an "In flight" list of workers out right now), notes/<today's date>.md (append-only history: the user's requests quoted verbatim, decisions with the options weighed and why, what happened, open items), a README.md explaining the folder, and assets/. Standard relative links (no wikilinks) and YAML front matter, self-contained, so the folder reads the same dropped into Obsidian or any Markdown viewer. If the project is large, have a worker survey it first. Never put secrets, phone numbers, IP addresses or real machine names in it — the folder still syncs between machines: write machines and people as roles. The full convention: docs/architect-convention.md in the Deckhand repository (github.com/CristianMori/DeckHand/blob/main/docs/architect-convention.md). The hub will refuse to start workers until architecture.md exists.`;

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

/**
 * architecture.md split at its `## Summary` section (the essentials an
 * architect must never lose, kept right after the title by convention):
 * that section with its heading, and everything else. No section: no summary.
 */
export function splitSummary(architecture: string): { summary?: string; rest: string } {
  const m = /^##\s+Summary\s*$/im.exec(architecture);
  if (!m) return { rest: architecture };
  const afterHeading = m.index + m[0].length;
  const next = architecture.slice(afterHeading).search(/^##?\s/m);
  const end = next === -1 ? architecture.length : afterHeading + next;
  return {
    summary: architecture.slice(m.index, end).trimEnd(),
    rest: (architecture.slice(0, m.index).trimEnd() + '\n\n' + architecture.slice(end).trimStart()).trim(),
  };
}

/**
 * How much of a lead's `## Summary` a cross-machine worker's briefing carries:
 * the worker can't read the lead's untracked docs over there, so the summary
 * travels in its place, capped like the convention asks it to be written.
 */
export const SUMMARY_CAP = 3_000;

/** The `## Summary` of a folder's working architecture.md, capped for a briefing. Undefined: no file or no summary. */
export function readLeadSummary(cwd: string): string | undefined {
  try {
    const { summary } = splitSummary(readFileSync(join(cwd, 'docs', 'architect', 'architecture.md'), 'utf8'));
    return summary && clip(summary, SUMMARY_CAP, ARCHITECTURE_FILE);
  } catch {
    return undefined;
  }
}

/**
 * The post-compaction refeed, composed from the documents' text: the
 * `## Summary` section first and in full, then as much of the rest of
 * architecture.md as fits, then the newest notes — every cut marked.
 * Undefined: nothing to say.
 */
export function composeDocsRefeed(
  architecture: string | undefined,
  notes: { name: string; text: string }[],
  cap: number = REFEED_CAP,
): string | undefined {
  if (!architecture && !notes.length) return undefined;
  const header = `[Deckhand] Your context was compacted or resumed. ${ARCHITECTURE_FILE} is your memory: this is its current state and the newest note${notes.length === 1 ? '' : 's'}, re-read the files themselves if anything looks stale.`;
  const noteParts = notes.map((n) => {
    const file = `${DOCS_DIR}/notes/${n.name}`;
    return `--- ${file} ---\n${clip(n.text, NOTE_CAP, file)}`;
  });
  const parts = [header, ...noteParts];
  if (architecture) {
    const { summary, rest } = splitSummary(architecture);
    const archParts: string[] = [];
    if (summary) archParts.push(`--- ${ARCHITECTURE_FILE}: ## Summary (in full) ---\n${summary}`);
    const used = [...parts, ...archParts].reduce((a, p) => a + p.length + 2, 0);
    const budget = Math.max(ARCHITECTURE_MIN, cap - used - 40);
    if (rest) archParts.push(`--- ${ARCHITECTURE_FILE}${summary ? ': the rest' : ''} ---\n${clip(rest, budget, ARCHITECTURE_FILE)}`);
    parts.splice(1, 0, ...archParts);
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
