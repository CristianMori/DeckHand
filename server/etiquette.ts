import { basename, resolve, sep } from 'node:path';
import { PROJECTS_ROOT } from './config.js';
import type { SessionInfo } from './types.js';

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
}

export const FLEET_RULES = `You are one agent session among several running inside Deckhand, a fleet of coding-agent sessions spread over this user's machines. Other sessions may be working in other project folders right now, on this machine or another.

Rules of the fleet:
1. Your folder is yours. Another live session's folder is theirs: read it freely, but never change its code without talking to that session first.
2. Talk to other sessions only through the deckhand-agent MCP tools (dh_list_sessions, dh_send_prompt, dh_wait_for_session, dh_last_reply). Describe the change you want and why, wait for the reply, then act on what was agreed. Keep that exchange in the conversation; it is the record of who changed what.
3. If you must touch another session's folder and cannot reach its owner, say so explicitly in your own conversation before editing, and keep the change minimal.
4. A hook will warn you when an edit lands in a folder that belongs to another live session. Treat that warning as a stop sign, not a formality.`;

export function fleetBriefing(id: Identity): string {
  return (
    `Deckhand fleet session: hub id ${id.hubId}` +
    (id.conversationId.startsWith('pending-') ? '' : `, conversation ${id.conversationId}`) +
    `, engine ${id.engine}, machine ${id.machine}, folder ${id.cwd}. Hub API at ${id.hubUrl}. ` +
    `The same identity is in the environment as DECKHAND_SESSION, DECKHAND_MACHINE, DECKHAND_ENGINE, DECKHAND_FOLDER, DECKHAND_HUB_URL.\n\n` +
    FLEET_RULES
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
