import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { CLAUDE_PROJECTS_DIR, encodeProjectDir } from './config.js';

const TAIL_BYTES = 64 * 1024;

/**
 * Reads the tail of a session's transcript jsonl and returns the last assistant
 * text (trimmed) for the dashboard summary line. Best-effort — returns undefined
 * on any miss.
 */
export async function lastAssistantText(
  claudeSessionId: string,
  cwd: string,
): Promise<string | undefined> {
  const path = join(CLAUDE_PROJECTS_DIR, encodeProjectDir(cwd), `${claudeSessionId}.jsonl`);
  let tail: string;
  try {
    const fh = await open(path, 'r');
    try {
      const { size } = await fh.stat();
      const start = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      await fh.read(buf, 0, buf.length, start);
      tail = buf.toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return undefined;
  }

  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'assistant' || entry.isSidechain) continue;
      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;
      const text = content
        .filter((c: { type: string; text?: string }) => c.type === 'text' && c.text)
        .map((c: { text: string }) => c.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) return text.length > 160 ? text.slice(0, 157) + '…' : text;
    } catch {
      // first line of the tail window is usually a partial JSON — skip
    }
  }
  return undefined;
}
