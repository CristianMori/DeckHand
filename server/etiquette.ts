import { basename, resolve, sep } from 'node:path';
import { PROJECTS_ROOT } from './config.js';
import { getAgent } from './agents/index.js';
import { memoryBriefing } from './fleetMemory.js';
import type { SessionInfo, SessionRole, WorkerLink } from './types.js';

/**
 * Fleet etiquette for agents running inside Deckhand.
 *  Level 1: every spawned session is told who it is and the rules (briefing).
 *  Level 2: an edit into a folder owned by another live session gets a warning
 *           back through the agent's own hook output. Nothing is blocked.
 */

export interface Identity {
  hubId: string;
  conversationId: string;
  machine: string;
  engine: string;
  cwd: string;
  hubUrl: string;
  role?: SessionRole;
  worker?: WorkerLink;
}

export const FLEET_RULES = `You are one agent session among several running inside Deckhand, a fleet of coding-agent sessions spread over this user's machines. Other sessions may be working in other project folders right now, on this machine or another.

Rules of the fleet:
1. Your folder is yours. Another live session's folder is theirs: read it freely, but never change its code without talking to that session first.
2. Talk to other sessions only through the "deckhand" MCP server every fleet session is given (tools dh_whoami, dh_list_sessions, dh_send_prompt, dh_wait_for_session, dh_last_reply, …). Describe the change you want and why, wait for the reply, then act on what was agreed. Keep that exchange in the conversation; it is the record of who changed what.
3. If you must touch another session's folder and cannot reach its owner, say so explicitly in your own conversation before editing, and keep the change minimal.
4. A hook will warn you when an edit lands in a folder that belongs to another live session. Treat that warning as a stop sign, not a formality.

When the user asks you to give, send or share a file ("give me that file"), call dh_send_file with its path. The Deckhand dashboard they are looking at downloads it right away, wherever they are. Do not just tell them the path: they may be on another machine.

Fleet memory is shared by every session on every machine (dh_remember, dh_recall, dh_forget). Remember facts about the world around the code that another session would otherwise have to ask for: machine and environment state ("installed WSL2 + Ubuntu 22.04 on this machine for ROS2"), accounts and licences ("the user has the Apple Developer subscription"), infrastructure observations with a date ("Wi-Fi on the laptop flaky since about Oct 19"), hardware quirks. Pick the narrowest scope that fits: machine for one machine's state, project for one folder, global otherwise. Do not store task progress, code decisions, or anything the repo, git history or a handoff already records. Rule zero: when the user says "remember this" (or the like), always store it, with instructed=true, whatever it is. When a remembered fact turns out wrong or outdated, dh_forget it and remember the correction.`;

export const ARCHITECT_RULES = `Your role: ARCHITECT of this project. You stay with the user for a long time, so your context is the scarce thing. Spend it on understanding, not on detail you will forget.

You do: discuss design and decisions with the user, know the whole architecture, keep the repository in order (review and merge work, commit, publish where the project says to), and keep the documentation true.
You delegate: writing and debugging code, research, reading through many files, running builds and long test runs, anything whose detail stops mattering once its result is known. A small fix of a line or two is yours if a worker would be silly.

How to delegate:
- dh_start_worker gives a task to a new worker session, in its own git worktree and branch off your current commit. Commit first: uncommitted work is not in its checkout. The worker knows nothing but what you write, so state the goal, the constraints, what you have ruled out, and what the result must contain.
- A worker can run on any fleet machine (machine, see dh_list_fleet): pick one for what it has, or to spread the load. The hub carries the code there and brings its branch back to your repository before you hear from it, so a report from any machine is handled the same way. Another machine can be another operating system: write tasks with paths relative to the repository, never your machine's, and remember a test that passes on one system says nothing about another. A report says where it ran.
- A large part of the system can have its own lead: dh_start_subarchitect gives a module to a sub-architect, which holds that module's detail and runs workers of its own on its own branch, then reports to you. You can have sub-architects and workers; a sub-architect can only have workers. Use one when a module needs sustained design of its own, not for a single task.
- Don't wait for it or check on it. End your turn: reports and questions arrive by themselves as a prompt starting "[Deckhand,". Stay out of its transcript unless a report doesn't add up. Knowing the least about how it went is the point.
- A report gives you a result and a branch. Check it fits the design, merge it, then dh_remove_worker. dh_worker_followup sends more work to the same worker, which still has its context. dh_list_workers shows them all.
- A worker asks you first when it needs a decision. Answer from what you know of the design with dh_send_prompt. Bring it to the user only when it is really the user's decision.

Your memory: docs/ARCHITECTURE.md holds the architecture: the parts, how they talk, where things live, and why the big decisions went the way they did. Create it if it is missing, with a worker's survey if the project is large. Read it when you start, and whenever you notice you've lost track of something. Update it in the same breath as any decision or merge that changes it: what is not written there will be forgotten when your context is compacted.`;

const OS: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
export const osName = (platform?: string) => (platform ? (OS[platform] ?? platform) : 'an unknown system');

/** What matters when the work is done on one system and merged on another. */
function acrossSystems(w: WorkerLink): string {
  if (!w.architectMachine || !w.architectPlatform || w.architectPlatform === process.platform) return '';
  const rules = [
    `\n\nYou are on ${osName(process.platform)}; your architect is on ${w.architectMachine}, ${osName(w.architectPlatform)}, and merges your branch there. Paths in your task are relative to the repository. Don't change line endings or file modes beyond what the task needs, and say in your report what system your tests ran on.`,
  ];
  if (w.architectPlatform === 'win32') {
    rules.push(`Windows has to be able to check out what you commit: no file names containing : * ? " < > | or ending in a dot or space, no reserved names like con or aux, no two names differing only by case, and no symlinks. Scripts committed from Windows may have lost their executable bit: run them with sh rather than committing a mode change.`);
  }
  return rules.join(' ');
}

const workerRules = (w: WorkerLink) => `Your role: WORKER for the architect session "${w.architectName}". You have one task and a clean context. The architect wants the result, not the story.

${w.worktree ? `You work in your own checkout (${w.worktree}) on your own branch (${w.branch}), made from a clean commit: files git ignores, like dependencies and local config, are not there, so install or ask for what you need. Stay in it, commit your work on your branch, and never push, merge or touch main${w.architectMachine ? '. The architect is on ' + w.architectMachine + ': the hub takes your branch to it when you report, so just commit' : ' or the folder ' + w.baseFolder}.` : `You work in the architect's own folder (${w.baseFolder}), which is not a git repository, so nothing isolates your changes: be careful.`}

Auto-approve is on so that you never stall, and that makes you responsible: don't deploy, publish, restart services, or change anything outside your checkout unless your task says so.

Rules:
- Finish with dh_report: what you found or built, whether tests pass, and anything the architect must know or decide. Keep it short: your transcript stays readable if anyone wants the detail. The hub stops you after the report, and you may be brought back for a follow-up.
- If you cannot go on without a decision, call dh_ask_architect and end your turn; the answer comes as your next prompt. Never use an interactive question tool, and never wait for a person.
- Any later prompt comes from the architect or the user, and is part of this task.

${assignment(w)}`;

const assignment = (w: WorkerLink) => `Your task, in case your context was compacted:
${w.task}${w.followUps?.length ? `\n\nFollow-ups since:\n${w.followUps.join('\n')}` : ''}${acrossSystems(w)}`;

const subarchitectRules = (w: WorkerLink) => `Your role: SUB-ARCHITECT of one module, under the architect session "${w.architectName}". You hold this module's detail so that the architect doesn't have to. Your context is the scarce thing: spend it on the module's design, and delegate what can be forgotten once its result is known.

You work in your own checkout (${w.worktree}) on your own branch (${w.branch}), and that branch is what the architect merges. Files git ignores are not there. Never push, or touch main${w.architectMachine ? '' : ` or the folder ${w.baseFolder}`}. Keep the module's design in docs/architecture/, in a file named for the module, and commit it with the work.

How to delegate: dh_start_worker gives a task to a worker, on any fleet machine, in its own branch off your current commit. Commit first. You can only have workers: you can't start a sub-architect, so if the module needs one, it is for the architect to divide differently. Don't wait for a worker: end your turn, and reports and questions arrive by themselves as a prompt starting "[Deckhand,". Check each report fits the design, merge its branch into yours with git merge, then dh_remove_worker. dh_worker_followup sends more to the same worker. Answer a worker's question from what you know of the module, with dh_send_prompt.

Finish with dh_report once your workers are done and merged: what the module now does, whether tests pass and on what system, and anything the architect must know or decide. Keep it short. It is refused while a worker is still going. The hub stops you afterwards, and dh_worker_followup can bring you back with your context. If you need a decision that is above the module, call dh_ask_architect and end your turn. Never use an interactive question tool, and never wait for a person. Auto-approve is on, so don't deploy, publish, restart services, or change anything outside your checkout unless your task says so.

${assignment(w)}`;

function roleRules(id: Identity): string {
  if (id.role === 'architect') return `\n\n${ARCHITECT_RULES}`;
  if (id.role === 'subarchitect' && id.worker) return `\n\n${subarchitectRules(id.worker)}`;
  if (id.role === 'worker' && id.worker) return `\n\n${workerRules(id.worker)}`;
  return '';
}

/** Files an architect edits itself. Everything else inside its folder is a worker's. */
export function isDocPath(file: string): boolean {
  return /\.(md|mdx|markdown|txt|rst|adoc)$/i.test(file) || /(^|[\\/])docs?[\\/]/i.test(file);
}

/** Names Windows can't check out. Only what a merge there would trip over. */
export function windowsUnsafeNames(files: string[]): string[] {
  const seen = new Map<string, string>();
  const bad = new Set<string>();
  for (const file of files) {
    const lower = file.toLowerCase();
    const twin = seen.get(lower);
    if (twin && twin !== file) bad.add(file).add(twin);
    seen.set(lower, file);
    for (const part of file.split('/')) {
      if (/[:*?"<>|\\\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part)) bad.add(file);
    }
  }
  return [...bad];
}

/** Etiquette for an architect editing code in its own folder: it may, but it is told. */
export function architectEditWarning(cwd: string, files: string[]): string | null {
  const root = resolve(cwd).toLowerCase() + sep;
  const file = files.find((f) => resolve(f).toLowerCase().startsWith(root) && !isDocPath(f));
  if (!file) return null;
  return `Deckhand: you are the architect and ${file} is code. Unless this is a line or two, delegate it with dh_start_worker: detail you take in here crowds out the design you are here to hold.`;
}

export function fleetBriefing(id: Identity): string {
  // a worker's checkout is named for the worker: its project is the architect's
  const home = id.worker?.baseFolder ?? id.cwd;
  const memories = memoryBriefing(id.machine, id.worker?.project ?? projectFolderOf(home) ?? basename(home.replace(/[\\/]+$/, '')));
  return (
    `Deckhand fleet session: hub id ${id.hubId}` +
    (id.conversationId.startsWith('pending-') ? '' : `, conversation ${id.conversationId}`) +
    `, engine ${id.engine}, machine ${id.machine}, folder ${id.cwd}. Hub API at ${id.hubUrl}. ` +
    `The same identity is in the environment as DECKHAND_SESSION, DECKHAND_MACHINE, DECKHAND_ENGINE, DECKHAND_FOLDER, DECKHAND_HUB_URL.\n\n` +
    FLEET_RULES +
    roleRules(id) +
    (memories ? `\n\n${memories}` : '')
  );
}

export function identityEnv(id: Identity): Record<string, string> {
  return {
    DECKHAND_SESSION: id.hubId,
    DECKHAND_CONVERSATION: id.conversationId,
    DECKHAND_MACHINE: id.machine,
    DECKHAND_ENGINE: id.engine,
    DECKHAND_FOLDER: id.cwd,
    DECKHAND_HUB_URL: id.hubUrl,
  };
}

/** Project folder name (first segment under the projects root) of an absolute path, or null when outside. */
export function projectFolderOf(absPath: string): string | null {
  const root = resolve(PROJECTS_ROOT);
  const p = resolve(absPath);
  if (p.toLowerCase() === root.toLowerCase()) return null;
  if (!p.toLowerCase().startsWith(root.toLowerCase() + sep)) return null;
  return p.slice(root.length + 1).split(sep)[0] || null;
}

/** File paths an edit-type tool call is about to change, from the hook payload. */
export function editedPaths(toolName: string | undefined, toolInput: unknown, cwd: string | undefined): string[] {
  const input = (toolInput ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  const abs = (p: string) => (/^[A-Za-z]:[\\/]|^\//.test(p) ? p : resolve(cwd ?? PROJECTS_ROOT, p));
  switch (toolName) {
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      if (typeof input.file_path === 'string') out.push(abs(input.file_path));
      break;
    case 'NotebookEdit':
      if (typeof input.notebook_path === 'string') out.push(abs(input.notebook_path));
      break;
    case 'apply_patch': {
      // Codex: "*** Update File: path" / "*** Add File: path" / "*** Delete File: path"
      const text = typeof input.patch === 'string' ? input.patch : typeof input.input === 'string' ? input.input : '';
      for (const m of text.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) out.push(abs(m[1].trim()));
      break;
    }
    default:
      break;
  }
  return out;
}

/**
 * Among live sessions, the one that owns `folder` (its cwd is that project
 * folder or inside it) and is not the editing conversation itself.
 */
export function folderOwner(
  folder: string,
  editingConversationId: string,
  live: SessionInfo[],
): SessionInfo | undefined {
  const target = folder.toLowerCase();
  return live.find((s) => {
    if (!s.alive || s.unreachable) return false;
    if (s.claudeSessionId === editingConversationId) return false;
    // only agents own folders: a terminal cannot be asked for permission
    if (getAgent(s.agentType).ownsFolder === false) return false;
    const sFolder = projectFolderOfAny(s.cwd);
    return sFolder !== null && sFolder.toLowerCase() === target;
  });
}

/** Like projectFolderOf but tolerant of other machines' roots: last resort, the folder's own name. */
function projectFolderOfAny(cwd: string): string | null {
  return projectFolderOf(cwd) ?? basename(cwd.replace(/[\\/]+$/, '')) ?? null;
}

export function ownershipWarning(owner: SessionInfo, folder: string, file: string): string {
  return (
    `Deckhand: ${file} is in project folder "${folder}", which belongs to the live session "${owner.name}" ` +
    `(${owner.agentType ?? 'claude'} on ${owner.machine ?? 'this machine'}, hub id ${owner.hubId}). ` +
    `Fleet etiquette: do not change another session's code without agreeing it with that session first ` +
    `(dh_send_prompt to ${owner.hubId}, then dh_last_reply). If you already agreed, proceed; if not, stop and ask.`
  );
}
