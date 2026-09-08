import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { listAgents } from './agents/index.js';
import { PROJECTS_ROOT } from './config.js';
import { activeSessionIds } from './conversations.js';
import { readTail } from './transcriptIo.js';

export interface FolderConversation {
  agentType: string;
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
 * The machine's project folders with their conversations from every agent.
 * Each adapter knows how to find the transcripts that belong to a folder.
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
  const agents = listAgents().filter((a) => a.transcript);

  const folders: FolderInfo[] = [];
  for (const name of names) {
    const path = join(PROJECTS_ROOT, name);
    const conversations: FolderConversation[] = [];
    let latest = 0;

    for (const agent of agents) {
      const refs = (await agent.transcript!.listFolder(path)).sort((a, b) => b.mtime - a.mtime);
      for (const ref of refs.slice(0, MAX_CONVERSATIONS_PER_FOLDER)) {
        if (inHubSessionIds.has(ref.sessionId)) continue; // already a live hub card
        latest = Math.max(latest, ref.mtime);
        const entry: FolderConversation = {
          agentType: agent.id,
          claudeSessionId: ref.sessionId,
          updatedAt: ref.mtime,
          activeElsewhere: active.has(ref.sessionId),
        };
        try {
          const parsed = agent.transcript!.parseTail(await readTail(ref.path));
          entry.title = parsed.title ?? ref.title;
          entry.lastText = parsed.lastText;
        } catch {
          /* bare entry */
        }
        conversations.push(entry);
      }
    }
    conversations.sort((a, b) => b.updatedAt - a.updatedAt);

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
