import { createWriteStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { basename, join, relative, resolve, sep } from 'node:path';
import { PROJECTS_ROOT } from './config.js';

/**
 * Fleet file browser. Every machine exposes the tree under its projects root:
 * listing for the dialog, raw bytes for downloads and machine-to-machine
 * copies. Paths are always relative to the root and can never escape it.
 */

export interface FileEntry {
  name: string;
  dir: boolean;
  size: number;
  mtime: number;
}

/** Absolute path for a root-relative one; throws when it would leave the root. */
export function safePath(rel: string): string {
  const root = resolve(PROJECTS_ROOT);
  const target = resolve(root, rel.replace(/^[\\/]+/, '') || '.');
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error('path escapes the projects root');
  }
  return target;
}

export function relPath(abs: string): string {
  return relative(resolve(PROJECTS_ROOT), abs).split(sep).join('/');
}

export async function listDir(rel: string): Promise<{ path: string; entries: FileEntry[] }> {
  const abs = safePath(rel);
  const dirents = await readdir(abs, { withFileTypes: true });
  const entries: FileEntry[] = [];
  for (const d of dirents) {
    try {
      const s = await stat(join(abs, d.name));
      entries.push({ name: d.name, dir: d.isDirectory(), size: d.isDirectory() ? 0 : s.size, mtime: s.mtimeMs });
    } catch {
      /* vanished or unreadable — skip */
    }
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return { path: relPath(abs), entries };
}

/**
 * Copy one file into this machine's projects root. `sourceUrl` is the owning
 * hub's raw endpoint for a remote file; `sourceAbs` a local absolute path.
 */
export async function copyIn(opts: {
  sourceAbs?: string;
  sourceUrl?: string;
  toDir: string;
  name: string;
  overwrite?: boolean;
}): Promise<{ path: string; bytes: number }> {
  const name = basename(opts.name);
  if (!name || name === '.' || name === '..') throw new Error('bad file name');
  const dir = safePath(opts.toDir);
  await mkdir(dir, { recursive: true });
  const dest = join(dir, name);
  if (existsSync(dest) && !opts.overwrite) throw new Error(`${relPath(dest)} already exists`);

  if (opts.sourceAbs) {
    await copyFile(opts.sourceAbs, dest);
  } else if (opts.sourceUrl) {
    const res = await fetch(opts.sourceUrl, { signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`source hub answered ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as import('stream/web').ReadableStream), createWriteStream(dest));
  } else {
    throw new Error('no source');
  }
  const s = await stat(dest);
  return { path: relPath(dest), bytes: s.size };
}
