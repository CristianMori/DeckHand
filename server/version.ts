import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { HUB_ROOT } from './config.js';

export interface VersionInfo {
  version: string;
  /** monotonic build number (git commit count at publish time); 0 = dev tree */
  build: number;
  builtAt?: string;
}

/** version.json is stamped by scripts/publish.ps1 — absent in a dev checkout. */
export function loadVersionInfo(): VersionInfo {
  const stamped = join(HUB_ROOT, 'version.json');
  if (existsSync(stamped)) {
    try {
      const v = JSON.parse(readFileSync(stamped, 'utf8')) as VersionInfo;
      if (typeof v.build === 'number' && v.version) return v;
    } catch {
      /* fall through */
    }
  }
  try {
    const pkg = JSON.parse(readFileSync(join(HUB_ROOT, 'package.json'), 'utf8'));
    return { version: `${pkg.version}-dev`, build: 0 };
  } catch {
    return { version: 'unknown', build: 0 };
  }
}
