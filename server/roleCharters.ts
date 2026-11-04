import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';

/**
 * Role charters: what a specialist role (tester, doc keeper, …) checks, how it
 * reports, and when it runs. One markdown file per role — YAML front matter
 * for the trigger and cost fields, prose body for the instructions. Three
 * layers, the most specific winning per field, the body taken whole from the
 * most specific layer that has one:
 *
 *   builtin  server/roles/<name>.md, shipped with Deckhand
 *   fleet    DATA_DIR/roles/<name>.md on the fleet-memory authority,
 *            replicated to every hub (edited in ADMIN → ROLES, user-only)
 *   project  docs/architect/roles/<name>.md read from the merged commit —
 *            the caller reads that from git and passes the text in
 *
 * The fleet layer syncs like fleet memory in spirit — one authority, replicas
 * pull — but as its own small store: the authority keeps the files plus a
 * version counter, and every hub pulls the full set when the counter moves.
 * An edit made while the authority is unreachable is refused, never queued:
 * charters change rarely, and a silent queue could leave hubs running
 * different rules for days.
 */

export interface RoleSkip {
  underLines?: number;
  docsOnly?: boolean;
}

export interface RoleCharter {
  name: string; // slug [a-z0-9-]{1,30}
  title: string;
  on: 'merge';
  paths: string[]; // globs over repo-relative paths (forward slashes); empty = every merge
  platforms: 'any' | 'all' | string[]; // 'any' = one instance on the lead's machine; 'all' = one per distinct OS among connected hubs; list = process.platform values
  model?: string; // passed to the agent spawn
  effort?: string; // rendered into the instance briefing as pace guidance
  skip: RoleSkip;
  enabled: boolean;
  body: string; // charter prose, front matter stripped
  layers: ('builtin' | 'fleet' | 'project')[]; // which layers contributed, in that order
}

export const ROLE_NAME_RE = /^[a-z0-9-]{1,30}$/;
export const MAX_CHARTER_BYTES = 16 * 1024;

type Layer = RoleCharter['layers'][number];

// ------------------------------------------------------------- front matter

export interface CharterText {
  fields: Record<string, unknown>;
  body: string;
}

const unquote = (v: string) => (/^(['"]).*\1$/.test(v) && v.length >= 2 ? v.slice(1, -1) : v);

function scalar(raw: string): unknown {
  const v = raw.trim();
  if (/^\[.*\]$/.test(v)) {
    const inner = v.slice(1, -1).trim();
    return inner ? inner.split(',').map((x) => unquote(x.trim())) : [];
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return unquote(v);
}

/**
 * Parse one charter file. Front matter between --- fences: scalars, booleans,
 * numbers, inline lists [a, b], and a one-level nested map (skip:). Unknown
 * fields are kept (and ignored by the merge). A file with no front matter is
 * all body. Malformed front matter throws — a write is refused with the
 * message, a read skips the layer with a warning.
 */
export function parseCharter(text: string): CharterText {
  if (!/^---\s*(\r?\n|$)/.test(text)) return { fields: {}, body: text.trim() };
  const lines = text.split(/\r?\n/);
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) throw new Error('front matter never closes: no second ---');
  const fields: Record<string, unknown> = {};
  let map: Record<string, unknown> | undefined;
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const nested = /^[ \t]+([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (nested) {
      if (!map) throw new Error(`front matter line ${i + 1} is indented under nothing: ${line.trim()}`);
      map[nested[1]] = scalar(nested[2]);
      continue;
    }
    const top = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!top) throw new Error(`front matter line ${i + 1} is not "key: value": ${line.trim()}`);
    if (top[2].trim() === '') {
      map = {};
      fields[top[1]] = map; // a nested one-level map follows
    } else {
      map = undefined;
      fields[top[1]] = scalar(top[2]);
    }
  }
  return { fields, body: lines.slice(end + 1).join('\n').trim() };
}

// ------------------------------------------------------------------ layering

const asStringList = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.map(String) : typeof v === 'string' && v.trim() ? [v.trim()] : undefined;

/** Merge parsed layers, least specific first. Per field the most specific wins;
 *  the body comes whole from the most specific non-empty one; `enabled: false`
 *  at any layer switches the role off, whatever the other layers say. */
function assemble(name: string, layers: { layer: Layer; parsed: CharterText }[]): RoleCharter | undefined {
  if (!layers.length) return undefined;
  const c: RoleCharter = {
    name,
    title: name,
    on: 'merge',
    paths: [],
    platforms: 'any',
    skip: {},
    enabled: true,
    body: '',
    layers: layers.map((l) => l.layer),
  };
  let disabled = false;
  for (const { parsed } of layers) {
    const f = parsed.fields;
    if (typeof f.title === 'string' && f.title) c.title = f.title;
    const paths = asStringList(f.paths);
    if (paths) c.paths = paths;
    if (f.platforms === 'any' || f.platforms === 'all') c.platforms = f.platforms;
    else if (Array.isArray(f.platforms)) c.platforms = f.platforms.map(String);
    if (typeof f.model === 'string' && f.model) c.model = f.model;
    if (typeof f.effort === 'string' && f.effort) c.effort = f.effort;
    if (f.skip && typeof f.skip === 'object' && !Array.isArray(f.skip)) {
      const s = f.skip as Record<string, unknown>;
      const skip: RoleSkip = {};
      if (typeof s.underLines === 'number') skip.underLines = s.underLines;
      if (typeof s.docsOnly === 'boolean') skip.docsOnly = s.docsOnly;
      c.skip = skip;
    }
    if (f.enabled === false) disabled = true;
    if (parsed.body) c.body = parsed.body;
  }
  c.enabled = !disabled;
  return c;
}

// ------------------------------------------------------- the store, two dirs

export interface RoleCharterDeps {
  selfName: () => string;
  authorityName: string;
  /** call the authority hub; undefined when it is not connected */
  callAuthority: (path: string, init?: { method?: string; body?: unknown }) => Promise<{ status: number; body: unknown } | undefined>;
  /** tests only: elsewhere these default to server/roles and DATA_DIR/roles */
  builtinDir?: string;
  fleetDir?: string;
}

let deps: RoleCharterDeps | undefined;
let builtinDir = join(import.meta.dirname, 'roles');
let fleetDir = join(DATA_DIR, 'roles');

const isAuthority = () => !!deps && deps.selfName() === deps.authorityName;
const metaFile = () => join(fleetDir, '_meta.json');

/** The version this hub's fleet set is at (the authority bumps it on every edit). */
export function fleetRolesVersion(): number {
  try {
    return Number(JSON.parse(readFileSync(metaFile(), 'utf8')).version) || 0;
  } catch {
    return 0;
  }
}

function setVersion(v: number) {
  mkdirSync(fleetDir, { recursive: true });
  writeFileSync(metaFile(), JSON.stringify({ version: v }));
}

function namesIn(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3))
      .filter((n) => ROLE_NAME_RE.test(n))
      .sort();
  } catch {
    return [];
  }
}

function textIn(dir: string, name: string): string | undefined {
  try {
    return readFileSync(join(dir, `${name}.md`), 'utf8');
  } catch {
    return undefined;
  }
}

/** The fleet layer as this hub has it: name → raw charter text. */
export function fleetRoleTexts(): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of namesIn(fleetDir)) {
    const t = textIn(fleetDir, n);
    if (t !== undefined) out.set(n, t);
  }
  return out;
}

export function initRoleCharters(d: RoleCharterDeps): void {
  deps = d;
  if (d.builtinDir) builtinDir = d.builtinDir;
  if (d.fleetDir) fleetDir = d.fleetDir;
  // same cadence as fleet-memory sync: soon after boot, then every minute
  setTimeout(() => void syncRoles(), 15_000).unref();
  setInterval(() => void syncRoles(), 60_000).unref();
}

// --------------------------------------------------------- resolving charters

const warnedLayers = new Set<string>();

function readLayer(name: string, layer: Layer, text: string | undefined): { layer: Layer; parsed: CharterText } | undefined {
  if (text === undefined) return undefined;
  try {
    return { layer, parsed: parseCharter(text) };
  } catch (err) {
    const key = `${layer}:${name}`;
    if (!warnedLayers.has(key)) {
      warnedLayers.add(key);
      console.warn(`[roles] ${layer} charter ${name} is skipped: ${err instanceof Error ? err.message : err}`);
    }
    return undefined;
  }
}

/**
 * Effective charter from builtin + fleet + optional project-layer text (caller
 * reads that from git). Undefined: no such role in any layer.
 */
export function resolveCharter(name: string, projectText?: string): RoleCharter | undefined {
  const layers = [
    readLayer(name, 'builtin', textIn(builtinDir, name)),
    readLayer(name, 'fleet', textIn(fleetDir, name)),
    readLayer(name, 'project', projectText),
  ].filter((l): l is NonNullable<typeof l> => !!l);
  return assemble(name, layers);
}

/** All effective charters. projectTexts: name -> project-layer raw text. */
export function listCharters(projectTexts?: Map<string, string>): RoleCharter[] {
  const names = new Set<string>([...namesIn(builtinDir), ...namesIn(fleetDir), ...(projectTexts?.keys() ?? [])]);
  return [...names]
    .sort()
    .map((n) => resolveCharter(n, projectTexts?.get(n)))
    .filter((c): c is RoleCharter => !!c);
}

// ---------------------------------------------------------------- path globs

function globToRegExp(glob: string): RegExp {
  const src = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  let out = '';
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '*') {
      if (src[i + 1] === '*') {
        // '**' crosses segments; '**/' also matches no directory at all
        if (src[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else {
      out += src[i].replace(/[.+^${}()|[\]\\?]/, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

/** True when charter.paths is empty or any file matches any glob (* = within one segment, ** = across segments). */
export function matchesPaths(charter: RoleCharter, files: string[]): boolean {
  if (!charter.paths.length) return true;
  const res = charter.paths.map(globToRegExp);
  return files.some((f) => {
    const p = f.replace(/\\/g, '/').replace(/^\.\//, '');
    return res.some((re) => re.test(p));
  });
}

// ------------------------------------------------- fleet edits and replication

function validate(name: string, text: string) {
  if (!ROLE_NAME_RE.test(name)) throw new Error('name: a slug of a-z, 0-9 and dashes, at most 30 characters');
  if (!text.trim()) throw new Error('charter text is empty');
  if (Buffer.byteLength(text, 'utf8') > MAX_CHARTER_BYTES) {
    throw new Error(`charter is over ${MAX_CHARTER_BYTES / 1024} KB — a charter is instructions, not a manual`);
  }
  parseCharter(text); // throws with the line when the front matter is malformed
}

/** The authority's answer for replicas: the whole fleet set and its version. */
export function fleetRolesSnapshot(): { version: number; files: Record<string, string> } {
  return { version: fleetRolesVersion(), files: Object.fromEntries(fleetRoleTexts()) };
}

function applyPutHere(name: string, text: string): { name: string; version: number } {
  mkdirSync(fleetDir, { recursive: true });
  writeFileSync(join(fleetDir, `${name}.md`), text);
  const version = fleetRolesVersion() + 1;
  setVersion(version);
  return { name, version };
}

function applyDeleteHere(name: string): { name: string; deleted: boolean; version: number } {
  let deleted = false;
  try {
    unlinkSync(join(fleetDir, `${name}.md`));
    deleted = true;
  } catch {
    /* nothing there: nothing to delete */
  }
  const version = deleted ? fleetRolesVersion() + 1 : fleetRolesVersion();
  if (deleted) setVersion(version);
  return { name, deleted, version };
}

async function onAuthority<T>(path: string, method: string, body: unknown, local: () => T): Promise<T> {
  if (!deps) throw new Error('role charters are not initialized');
  if (isAuthority()) return local();
  let out: { status: number; body: unknown } | undefined;
  try {
    out = await deps.callAuthority(path, { method, body });
  } catch {
    out = undefined;
  }
  if (!out) {
    throw new Error(
      `role charters are kept on ${deps.authorityName}, which is unreachable right now — nothing was changed (edits are deliberately not queued)`,
    );
  }
  if (out.status !== 200) throw new Error(String((out.body as { error?: string })?.error ?? `refused (${out.status})`));
  await syncRoles(); // pull the new set so this hub shows the edit at once
  return out.body as T;
}

/** Write one fleet-layer charter (forwarded to the authority from a replica). */
export async function putFleetRole(name: string, text: string): Promise<{ name: string; version: number }> {
  validate(name, text);
  return onAuthority(`/api/roles/${name}`, 'PUT', { text }, () => applyPutHere(name, text));
}

/** Delete one fleet-layer charter — "revert to built-in" in the dashboard. */
export async function deleteFleetRole(name: string): Promise<{ name: string; deleted: boolean; version: number }> {
  if (!ROLE_NAME_RE.test(name)) throw new Error('name: a slug of a-z, 0-9 and dashes, at most 30 characters');
  return onAuthority(`/api/roles/${name}`, 'DELETE', undefined, () => applyDeleteHere(name));
}

let syncing = false;
/** Replica: pull the authority's full set when its version counter moved. */
export async function syncRoles(): Promise<void> {
  if (!deps || isAuthority() || syncing) return;
  syncing = true;
  try {
    const out = await deps.callAuthority('/api/roles/sync');
    if (!out || out.status !== 200) return;
    const { version, files } = out.body as { version: number; files: Record<string, string> };
    if (typeof version !== 'number' || !files || version === fleetRolesVersion()) return;
    mkdirSync(fleetDir, { recursive: true });
    for (const stale of namesIn(fleetDir)) {
      if (!(stale in files)) unlinkSync(join(fleetDir, `${stale}.md`));
    }
    for (const [name, text] of Object.entries(files)) {
      if (ROLE_NAME_RE.test(name) && typeof text === 'string') writeFileSync(join(fleetDir, `${name}.md`), text);
    }
    setVersion(version);
  } catch (err) {
    console.warn(`[roles] sync: ${err instanceof Error ? err.message : err}`);
  } finally {
    syncing = false;
  }
}
