import { open, readdir, rename, rmdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Move a directory to a new path. When the destination already exists the
 * entries are merged into it, and an entry already present there is kept (the
 * source copy stays behind). Missing source: nothing to do. Returns true when
 * something moved.
 */
export async function moveDir(from: string, to: string): Promise<boolean> {
  try {
    await stat(from);
  } catch {
    return false;
  }
  try {
    await stat(to);
  } catch {
    await rename(from, to);
    return true;
  }
  if (from.toLowerCase() === to.toLowerCase()) {
    await rename(from, to); // a case-only rename on a case-insensitive disk
    return true;
  }
  let moved = false;
  for (const e of await readdir(from, { withFileTypes: true })) {
    const src = join(from, e.name);
    const dst = join(to, e.name);
    if (e.isDirectory()) moved = (await moveDir(src, dst)) || moved;
    else {
      try {
        await stat(dst);
        continue;
      } catch {
        await rename(src, dst);
        moved = true;
      }
    }
  }
  await rmdir(from).catch(() => {}); // left alone when something stayed behind
  return moved;
}

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
    // Git Bash / Cygwin / WSL spelling of a drive: Claude records the shell's
    // cwd after a `cd` in its Bash tool, so /d/DataDrive/x is D:\DataDrive\x
    .replace(/^\/(?:cygdrive\/|mnt\/)?([a-zA-Z])(?=\/|$)/, '$1:')
    .replace(/[\\/]+$/, '')
    .replace(/\//g, '\\')
    .toLowerCase();
}
