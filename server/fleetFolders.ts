import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CLAUDE_PROJECTS_DIR, PROJECTS_ROOT, encodeProjectDir } from './config.js';
import { readTail, parseTranscriptTail, activeSessionIds } from './conversations.js';

export interface FolderConversation {
  claudeSessionId: string;
  title?: string;
  lastText?: string;
  updatedAt: number;
  activeElsewhere: boolean;
  /** machine that holds this transcript (tagged during fleet merge) */
  machine?: string;
}

export interface FolderInfo {
  folder: string;
  path: string;
  machine?: string;
  /** registered with syncthing on this machine */
  synced: boolean;
  /** number of live hub sessions currently in this folder here */
  activeHubSessions: number;
  updatedAt: number;
  conversations: FolderConversation[];
}

const MAX_CONVERSATIONS_PER_FOLDER = 15;

/**
 * The machine's project folders with their Claude conversations. Transcripts
 * live in ~/.claude/projects/<encoded-cwd>/ — folder membership is recovered
 * by encoding each folder's local path the way Claude Code does.
 */
export async function listLocalFolders(
  syncedIds: Set<string>,
  hubSessionCwds: string[],
  inHubSessionIds: Set<string>,
): Promise<FolderInfo[]> {
  let names: string[];
  try {
    names = (await readdir(PROJECTS_ROOT, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('$'))
      .map((d) => d.name);
  } catch {
    return [];
  }
  const active = await activeSessionIds();

  const folders: FolderInfo[] = [];
  for (const name of names) {
    const path = join(PROJECTS_ROOT, name);
    const transcriptDir = join(CLAUDE_PROJECTS_DIR, encodeProjectDir(path));
    const conversations: FolderConversation[] = [];
    let latest = 0;

    try {
      const files = [];
      for (const f of await readdir(transcriptDir)) {
        if (!f.endsWith('.jsonl')) continue;
        try {
          const s = await stat(join(transcriptDir, f));
          if (s.size > 0) files.push({ f, mtime: s.mtimeMs });
        } catch {
          /* skip */
        }
      }
      files.sort((a, b) => b.mtime - a.mtime);
      for (const { f, mtime } of files.slice(0, MAX_CONVERSATIONS_PER_FOLDER)) {
        const sessionId = f.slice(0, -6);
        if (inHubSessionIds.has(sessionId)) continue; // already a live hub card
        latest = Math.max(latest, mtime);
        const entry: FolderConversation = {
          claudeSessionId: sessionId,
          updatedAt: mtime,
          activeElsewhere: active.has(sessionId),
        };
        try {
          const parsed = parseTranscriptTail(await readTail(join(transcriptDir, f)));
          entry.title = parsed.title;
          entry.lastText = parsed.lastText;
        } catch {
          /* bare entry */
        }
        conversations.push(entry);
      }
    } catch {
      /* folder has no conversations yet — still listed */
    }

    folders.push({
      folder: name,
      path,
      synced: syncedIds.has(name),
      activeHubSessions: hubSessionCwds.filter((c) => c.toLowerCase() === path.toLowerCase()).length,
      updatedAt: latest,
      conversations,
    });
  }
  return folders;
}
