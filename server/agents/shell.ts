import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import type { AgentAdapter, AgentOption, BuildArgsInput } from './types.js';

/**
 * Plain terminal sessions: an interactive shell in a card, no agent. On
 * Windows the choice is PowerShell 7 (when installed), Windows PowerShell and
 * cmd; elsewhere the user's login shell plus bash/zsh/sh as installed. The
 * shell is picked through the adapter's option list (the dialog's model slot).
 *
 * A session given a `command` runs it non-interactively and exits with its
 * exit code — that is what /api/run (dh_run) uses, so every scripted command
 * runs in a card the user can open.
 */

const isWin = process.platform === 'win32';

function whereWin(name: string): string | undefined {
  try {
    const out = execFileSync('where.exe', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/).map((l) => l.trim()).find((l) => l && existsSync(l));
  } catch {
    return undefined;
  }
}

function loginShell(): string {
  try {
    const sh = userInfo().shell;
    if (sh && existsSync(sh)) return sh;
  } catch {
    /* no passwd entry */
  }
  return process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/sh';
}

const shellName = (path: string) => path.split(/[\\/]/).pop()!.replace(/\.exe$/i, '').toLowerCase();

/** value -> executable, in preference order (the first is the default).
 *  Probed at most every 30 s — the agents list asks on every dialog open. */
let probed: { at: number; found: Map<string, string> } | undefined;
function shells(): Map<string, string> {
  if (probed && Date.now() - probed.at < 30_000) return probed.found;
  const found = new Map<string, string>();
  if (isWin) {
    const pwsh = whereWin('pwsh.exe');
    if (pwsh) found.set('pwsh', pwsh);
    const sys = process.env.SystemRoot ?? 'C:\\Windows';
    found.set('powershell', `${sys}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`);
    found.set('cmd', process.env.ComSpec ?? `${sys}\\System32\\cmd.exe`);
  } else {
    const login = loginShell();
    found.set(shellName(login), login);
    for (const p of ['/bin/bash', '/bin/zsh', '/bin/sh']) {
      if (existsSync(p) && !found.has(shellName(p))) found.set(shellName(p), p);
    }
  }
  probed = { at: Date.now(), found };
  return found;
}

const LABELS: Record<string, string> = {
  pwsh: 'PowerShell 7',
  powershell: 'Windows PowerShell',
  cmd: 'Command Prompt',
};

function resolveShell(option?: string): { name: string; exe: string } {
  const all = shells();
  const name = option && all.has(option) ? option : [...all.keys()][0];
  return { name, exe: all.get(name)! };
}

/** PowerShell's -EncodedCommand: base64 of the UTF-16LE script — no quoting to get wrong. */
const encodePs = (script: string) => Buffer.from(script, 'utf16le').toString('base64');

function interactiveArgs(name: string): string[] {
  if (name === 'pwsh' || name === 'powershell') return ['-NoLogo'];
  if (name === 'cmd') return [];
  return ['-l']; // login shell: the PATH a terminal window would have (brew, nvm, …)
}

function commandArgs(name: string, command: string): string[] {
  if (name === 'pwsh' || name === 'powershell') {
    // $LASTEXITCODE of the last native program, or 1 when a cmdlet failed;
    // no progress bars — they repaint in place and bury the output read back
    const script = `$ProgressPreference = 'SilentlyContinue'\n${command}\nif ($LASTEXITCODE) { exit $LASTEXITCODE } elseif (-not $?) { exit 1 }`;
    return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePs(script)];
  }
  return ['-lc', command];
}

export const shellAdapter: AgentAdapter = {
  id: 'shell',
  label: 'Terminal',
  optionLabel: 'SHELL',
  outputOnlyStatus: true,
  ownsFolder: false,
  // no conversation of its own; a fresh id per card keeps lookups unique
  clientChosenId: true,
  resolveExe: (option) => resolveShell(option).exe,
  available: () => true,
  buildArgs(input: BuildArgsInput) {
    const { name } = resolveShell(input.model);
    return input.command ? commandArgs(name, input.command) : interactiveArgs(name);
  },
  mapHookEvent: () => null,
  acceptKeystroke: '\r',
  get models(): AgentOption[] {
    return [...shells().keys()].map((value) => ({ value, label: LABELS[value] ?? value }));
  },
  permissionModes: [],
};

/**
 * The shell a dh_run command runs in: the one asked for when installed, else
 * the machine default. Never cmd — its /c quoting does not survive the PTY's
 * command-line assembly, so Windows runs go through PowerShell.
 */
export function runShell(asked?: string): string {
  const all = shells();
  if (asked && asked !== 'cmd' && all.has(asked)) return asked;
  if (!isWin) return resolveShell().name;
  return all.has('pwsh') ? 'pwsh' : 'powershell';
}
