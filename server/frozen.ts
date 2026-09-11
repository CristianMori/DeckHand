import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';

/**
 * Folders frozen to this machine: never registered for sync, never pushed to
 * the VPS, never materialized elsewhere. A per-machine list in the hub's data
 * dir — deliberately not a marker inside the folder, so it cannot travel.
 */
const FILE = join(DATA_DIR, 'frozen-folders.json');

let frozen = new Set<string>();
try {
  if (existsSync(FILE)) frozen = new Set(JSON.parse(readFileSync(FILE, 'utf8')) as string[]);
} catch {
  /* fresh */
}

const key = (folder: string) => folder.toLowerCase();

export function isFrozen(folder: string): boolean {
  return frozen.has(key(folder));
}

export function setFrozen(folder: string, on: boolean): void {
  if (on) frozen.add(key(folder));
  else frozen.delete(key(folder));
  writeFileSync(FILE, JSON.stringify([...frozen], null, 2));
}

export function frozenFolders(): string[] {
  return [...frozen];
}

export const folderNameOf = (cwd: string) => cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
