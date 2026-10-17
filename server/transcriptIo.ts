import { open } from 'node:fs/promises';

const TAIL_BYTES = 64 * 1024;

/** Last 64 KB of a file — enough for titles, cwd and the closing exchange. */
export async function readTail(path: string): Promise<string> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

/** Normalize a folder path for equality checks across agents and platforms. */
export function normCwd(p: string): string {
  return p
    .replace(/^\\\\\?\\/, '') // Windows extended-length prefix (Codex stores it)
    .replace(/[\\/]+$/, '')
    .replace(/\//g, '\\')
    .toLowerCase();
}
