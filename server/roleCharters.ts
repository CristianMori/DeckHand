import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HUB_ROOT } from './config.js';

/**
 * Role charters: what a specialist role checks, when it runs and what it costs.
 * A charter is one markdown file — YAML front matter for the trigger and cost
 * fields, prose body for what to check. Three layers, the most specific winning
 * per front-matter field, the body taken whole from the most specific layer
 * that has one: built-in (server/roles/), fleet-wide (data/roles/ on the
 * authority, replicated), per-project (docs/architect/roles/, read from the
 * merged commit).
 *
 * This file is the minimal implementation of the agreed interface — built-in
 * layer plus a caller-supplied project text; the fleet layer, its sync and the
 * dashboard editor are built in parallel against these exact signatures.
 */

export interface RoleSkip {
  underLines?: number;
  docsOnly?: boolean;
}

export interface RoleCharter {
  name: string;
  title: string;
  on: 'merge';
  /** globs, repo-relative, forward slashes; empty = every merge */
  paths: string[];
  /** 'any' = one instance on the lead's machine; 'all' = one per distinct OS among connected hubs; list = process.platform values */
  platforms: 'any' | 'all' | string[];
  model?: string;
  effort?: string;
  skip: RoleSkip;
  enabled: boolean;
  /** charter prose */
  body: string;
  layers: ('builtin' | 'fleet' | 'project')[];
}

const ROLES_DIR = join(HUB_ROOT, 'server', 'roles');
const ROLE_NAME = /^[a-z0-9][a-z0-9-]{0,60}$/;

/** One scalar the way the front matter writes it. */
function scalar(v: string): unknown {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (/^\[.*\]$/.test(v)) {
    return v.slice(1, -1).split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  }
  return v.replace(/^['"]|['"]$/g, '');
}

/** The small YAML subset charters use: scalars, inline and block lists, one-level maps. */
function parseFrontMatter(src: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#') || /^\s/.test(line)) continue;
    const kv = /^([\w-]+):\s*(.*?)\s*$/.exec(line);
    if (!kv) continue;
    const [, key, value] = kv;
    if (value !== '') {
      out[key] = scalar(value);
      continue;
    }
    // nothing after the colon: the indented block below is a list or a one-level map
    const items: unknown[] = [];
    const map: Record<string, unknown> = {};
    let isList = false;
    let isMap = false;
    for (let j = i + 1; j < lines.length && (/^\s/.test(lines[j]) || !lines[j].trim()); j++) {
      const sub = lines[j].trim();
      if (!sub || sub.startsWith('#')) continue;
      if (sub.startsWith('- ')) {
        isList = true;
        items.push(scalar(sub.slice(2).trim()));
      } else {
        const skv = /^([\w-]+):\s*(.*?)\s*$/.exec(sub);
        if (skv) {
          isMap = true;
          map[skv[1]] = scalar(skv[2]);
        }
      }
    }
    out[key] = isList ? items : isMap ? map : '';
  }
  return out;
}

interface Layer {
  fields: Record<string, unknown>;
  body: string;
}

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function layerOf(text: string): Layer {
  const m = FRONT.exec(text);
  if (!m) return { fields: {}, body: text.trim() };
  return { fields: parseFrontMatter(m[1]), body: text.slice(m[0].length).trim() };
}

function readBuiltin(name: string): Layer | undefined {
  if (!ROLE_NAME.test(name)) return undefined;
  try {
    return layerOf(readFileSync(join(ROLES_DIR, `${name}.md`), 'utf8'));
  } catch {
    return undefined;
  }
}

function skipOf(v: unknown): RoleSkip {
  const raw = (v ?? {}) as Record<string, unknown>;
  const out: RoleSkip = {};
  if (typeof raw.underLines === 'number') out.underLines = raw.underLines;
  if (typeof raw.docsOnly === 'boolean') out.docsOnly = raw.docsOnly;
  return out;
}

/** The effective charter for a role: layers merged per field, body from the most specific. */
export function resolveCharter(name: string, projectText?: string): RoleCharter | undefined {
  const layers: { which: 'builtin' | 'fleet' | 'project'; layer: Layer }[] = [];
  const builtin = readBuiltin(name);
  if (builtin) layers.push({ which: 'builtin', layer: builtin });
  if (projectText) layers.push({ which: 'project', layer: layerOf(projectText) });
  if (!layers.length) return undefined;
  const fields: Record<string, unknown> = {};
  for (const { layer } of layers) {
    for (const [k, v] of Object.entries(layer.fields)) fields[k] = v; // most specific last: it wins per field
  }
  const body = [...layers].reverse().find((l) => l.layer.body)?.layer.body ?? '';
  const platforms = fields.platforms;
  return {
    name,
    title: typeof fields.title === 'string' && fields.title ? fields.title : name,
    on: 'merge',
    paths: Array.isArray(fields.paths) ? fields.paths.map(String) : [],
    platforms: platforms === 'all' ? 'all' : Array.isArray(platforms) ? platforms.map(String) : 'any',
    model: typeof fields.model === 'string' && fields.model ? fields.model : undefined,
    effort: typeof fields.effort === 'string' && fields.effort ? fields.effort : undefined,
    skip: skipOf(fields.skip),
    enabled: fields.enabled !== false,
    body,
    layers: layers.map((l) => l.which),
  };
}

/** Every known role's effective charter, project texts keyed by role name. */
export function listCharters(projectTexts?: Map<string, string>): RoleCharter[] {
  const names = new Set<string>();
  try {
    for (const f of readdirSync(ROLES_DIR)) if (f.endsWith('.md')) names.add(f.slice(0, -3));
  } catch {
    /* no built-in charters shipped */
  }
  for (const n of projectTexts?.keys() ?? []) names.add(n);
  return [...names]
    .sort()
    .map((n) => resolveCharter(n, projectTexts?.get(n)))
    .filter((c): c is RoleCharter => !!c);
}

function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
        if (glob[i + 1] === '/') i++; // "a/**/b" also matches "a/b"
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`, 'i');
}

/** Whether a merge's changed files give this charter something to look at. */
export function matchesPaths(charter: RoleCharter, files: string[]): boolean {
  if (!charter.paths.length) return true;
  const regs = charter.paths.map(globToRegExp);
  return files.some((f) => {
    const p = f.replace(/\\/g, '/');
    return regs.some((r) => r.test(p));
  });
}
