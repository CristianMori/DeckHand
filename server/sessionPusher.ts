import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { hostname } from 'node:os';
import { DATA_DIR, CLAUDE_PROJECTS_DIR } from './config.js';

/**
 * Pushes settled Claude Code session transcripts to the SecondBrain relay so they become
 * searchable knowledge. "Each machine pushes its own": this sweeps the local
 * ~/.claude/projects for *.jsonl transcripts (hub-owned and plain-terminal sessions alike),
 * and pushes any session that (a) hasn't been written for quietMinutes and (b) has grown
 * since the last push (ledger in data/pushed-sessions.json). The brain deduplicates by
 * session id, so re-pushes are always safe.
 *
 * Config: data/pusher.json
 *   { "enabled": true, "relayUrl": "http://vps-node:5180", "token": "…",
 *     "quietMinutes": 30, "minLines": 30, "maxPerSweep": 10, "sweepMinutes": 10 }
 *
 * Standalone: npx tsx server/sessionPusher.ts --once
 */

const CONFIG_FILE = join(DATA_DIR, 'pusher.json');
const LEDGER_FILE = join(DATA_DIR, 'pushed-sessions.json');

interface PusherConfig {
  enabled: boolean;
  relayUrl: string;
  token: string;
  quietMinutes: number;
  minLines: number;
  maxPerSweep: number;
  sweepMinutes: number;
}

function loadConfig(): PusherConfig | null {
  if (!existsSync(CONFIG_FILE)) return null;
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8').replace(/^﻿/, ''));
    if (!raw.enabled || !raw.relayUrl || !raw.token) return null;
    return {
      enabled: true,
      relayUrl: String(raw.relayUrl).replace(/\/+$/, ''),
      token: String(raw.token),
      quietMinutes: Number(raw.quietMinutes) || 30,
      minLines: Number(raw.minLines) || 30,
      maxPerSweep: Number(raw.maxPerSweep) || 10,
      sweepMinutes: Number(raw.sweepMinutes) || 10,
    };
  } catch {
    return null;
  }
}

function loadLedger(): Record<string, number> {
  try {
    return existsSync(LEDGER_FILE) ? JSON.parse(readFileSync(LEDGER_FILE, 'utf8')) : {};
  } catch {
    return {};
  }
}

function countLines(buf: Buffer): number {
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
  return n;
}

const KEEP_TYPES = ['"type":"user"', '"type":"assistant"', '"type":"ai-title"', '"type":"custom-title"'];
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * Strips a transcript to what the brain's parser actually reads: dialogue text and titles.
 * Message lines are REBUILT with only their text blocks — tool_use inputs (full file
 * bodies), tool_results (base64 screenshots), and thinking are dropped, turning 200 MB
 * transcripts into KBs. If the result still exceeds the upload cap, middle lines go first
 * (openings carry the goal, endings carry the conclusions).
 */
function distill(buf: Buffer): string {
  const kept: string[] = [];
  for (const line of buf.toString('utf8').split('\n')) {
    if (line.length === 0 || !KEEP_TYPES.some((t) => line.includes(t))) continue;
    try {
      const o = JSON.parse(line);
      if (o.type === 'ai-title' || o.type === 'custom-title') {
        kept.push(line);
        continue;
      }
      if (o.type !== 'user' && o.type !== 'assistant') continue;
      if (o.isSidechain) continue;
      const content = o.message?.content;
      let text: string | null = null;
      if (typeof content === 'string') text = content;
      else if (Array.isArray(content)) {
        const parts = content
          .filter((b) => b?.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text);
        if (parts.length > 0) text = parts.join('\n\n');
      }
      if (!text || text.trim().length === 0) continue;
      kept.push(
        JSON.stringify({
          type: o.type,
          sessionId: o.sessionId,
          isSidechain: false,
          cwd: o.cwd,
          timestamp: o.timestamp,
          message: { role: o.message?.role, content: text },
        }),
      );
    } catch {
      // malformed line — skip
    }
  }
  let out = kept;
  while (out.reduce((n, l) => n + l.length + 1, 0) > MAX_UPLOAD_BYTES && out.length > 20) {
    out = [...out.slice(0, Math.floor(out.length * 0.6) - 5), ...out.slice(Math.floor(out.length * 0.6) + 5)];
  }
  return out.join('\n') + '\n';
}

export async function sweepOnce(log: (msg: string) => void = console.log): Promise<number> {
  const config = loadConfig();
  if (!config) return 0;
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return 0;

  const ledger = loadLedger();
  const quietMs = config.quietMinutes * 60_000;
  const machine = hostname().toLowerCase();
  let pushed = 0;

  outer: for (const projectDir of readdirSync(CLAUDE_PROJECTS_DIR)) {
    const dir = join(CLAUDE_PROJECTS_DIR, projectDir);
    let entries: string[];
    try {
      entries = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const file of entries) {
      const path = join(dir, file);
      let stats;
      try {
        stats = statSync(path);
      } catch {
        continue;
      }
      if (Date.now() - stats.mtimeMs < quietMs) continue; // still live

      const sessionId = basename(file, '.jsonl');
      const buf = readFileSync(path);
      const lines = countLines(buf);
      if (lines < config.minLines) continue;
      if ((ledger[sessionId] ?? 0) >= lines) continue; // already pushed at this size

      try {
        const form = new FormData();
        form.append('file', new Blob([distill(buf)]), `${machine}__${sessionId}.jsonl`);
        const resp = await fetch(`${config.relayUrl}/drop`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.token}` },
          body: form,
        });
        if (!resp.ok) {
          log(`[pusher] relay rejected ${sessionId}: ${resp.status}`);
          break outer; // relay unhappy — stop this sweep, retry next cycle
        }
        ledger[sessionId] = lines;
        writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 2));
        pushed++;
        log(`[pusher] pushed ${projectDir}/${sessionId} (${lines} lines)`);
        if (pushed >= config.maxPerSweep) break outer; // trickle backfill, don't flood
      } catch (err) {
        log(`[pusher] push failed (${(err as Error).message}) — retry next sweep`);
        break outer;
      }
    }
  }
  return pushed;
}

/** Hub wiring: periodic sweep for as long as the hub runs. No-op when unconfigured. */
export function startSessionPusher(log: (msg: string) => void = console.log): void {
  const config = loadConfig();
  if (!config) {
    log('[pusher] disabled (configure data/pusher.json to push sessions to the brain)');
    return;
  }
  log(`[pusher] pushing settled sessions to ${config.relayUrl} every ${config.sweepMinutes} min`);
  void sweepOnce(log);
  setInterval(() => void sweepOnce(log), config.sweepMinutes * 60_000).unref();
}

// Standalone: npx tsx server/sessionPusher.ts --once
if (process.argv.includes('--once')) {
  sweepOnce().then((n) => {
    console.log(`[pusher] done — ${n} session(s) pushed`);
    process.exit(0);
  });
}
