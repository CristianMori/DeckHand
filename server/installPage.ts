import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HUB_ROOT } from './config.js';

/** What the shelf's version.json says (scripts/publish.ps1 stamps it). */
export interface ShelfVersion {
  version?: string;
  build?: number;
  builtAt?: string;
}

/** Where the installers download from, and what that shelf currently serves. */
export interface InstallShelf {
  base: string;
  version?: ShelfVersion;
}

const PLACEHOLDER = '__DECKHAND_BASE_URL__';

/**
 * http(s)://host[:port] with a plain hostname/IPv4 or a bracketed IPv6 —
 * nothing that could escape a quoted string in cmd, PowerShell or bash,
 * since the base is embedded into all three.
 */
export function validBase(base: string): boolean {
  return /^https?:\/\/([a-zA-Z0-9._-]+|\[[0-9a-fA-F:.]+\])(:\d{1,5})?$/.test(base);
}

function embed(templateName: string, base: string): string {
  if (!validBase(base)) throw new Error(`not a usable shelf URL: ${base}`);
  const tpl = readFileSync(join(HUB_ROOT, 'scripts', templateName), 'utf8');
  if (!tpl.includes(PLACEHOLDER)) throw new Error(`${templateName} has no base-URL placeholder`);
  return tpl.split(PLACEHOLDER).join(base);
}

/** The Windows installer, shelf URL embedded, CRLF line endings (cmd needs them). */
export function windowsInstaller(base: string): string {
  return embed('web-install.cmd', base).replace(/\r?\n/g, '\r\n');
}

/** The macOS installer, shelf URL embedded, LF line endings (bash chokes on CR). */
export function macInstaller(base: string): string {
  return embed('web-install.command', base).replace(/\r\n/g, '\n');
}

/** Linux stays a copy-paste line: those machines are servers with a shell open anyway. */
export function linuxOneLiner(base: string): string {
  if (!validBase(base)) throw new Error(`not a usable shelf URL: ${base}`);
  return `mkdir -p ~/deckhand && cd ~/deckhand && curl -fL ${base}/releases/deckhand-release.tgz | tar xz && npm install --no-audit --no-fund && sudo bash scripts/install.sh`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * GET /install — the page behind the one-click installers. Served by every
 * hub; `shelf` is null when this hub holds no releases and the release
 * machine is not connected (the page still renders, with the buttons off).
 */
export function renderInstallPage(shelf: InstallShelf | null, machine: string): string {
  const build = shelf?.version?.build;
  const buildLine = shelf
    ? build
      ? `build ${esc(String(build))} &middot; ${esc(shelf.version?.version ?? '')}`
      : 'release shelf found (build unknown)'
    : 'release shelf not reachable';
  const haveShelf = !!shelf;
  const oneLiner = shelf ? linuxOneLiner(shelf.base) : null;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Deckhand &middot; install</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect width='16' height='16' rx='3' fill='%23141a17'/><circle cx='8' cy='8' r='4' fill='%23ffb454'/></svg>" />
<style>
  :root {
    --bg: #0b0e0d; --bg-card: #141a17; --line: #1f2a25; --line-bright: #2c3b34;
    --ink: #cfe0d8; --ink-dim: #7a8d84; --ink-faint: #46554e;
    --amber: #ffb454; --green: #5af78e; --red: #ff6b6b; --blue: #6ab0f3;
    --font-display: 'Chakra Petch', sans-serif; --font-mono: 'IBM Plex Mono', monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background:
      radial-gradient(ellipse 120% 60% at 50% -10%, #12201a55 0%, transparent 60%),
      repeating-linear-gradient(0deg, transparent 0 31px, #ffffff04 31px 32px),
      repeating-linear-gradient(90deg, transparent 0 31px, #ffffff04 31px 32px),
      var(--bg);
    color: var(--ink); font-family: var(--font-mono); font-size: 13.5px; line-height: 1.65;
    padding: 0 16px 60px;
  }
  main { max-width: 780px; margin: 0 auto; }
  header { display: flex; align-items: baseline; gap: 10px; padding: 26px 0 6px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--amber); align-self: center; box-shadow: 0 0 12px 2px #ffb45488; }
  h1 { font-family: var(--font-display); font-size: 19px; font-weight: 700; letter-spacing: 0.22em; }
  .sub { font-family: var(--font-display); font-size: 10px; letter-spacing: 0.3em; text-transform: uppercase; color: var(--ink-faint); }
  .buildline { color: var(--ink-dim); font-size: 12px; margin-bottom: 22px; }
  .buildline .ok { color: var(--green); }
  .buildline .bad { color: var(--red); }
  h2 { font-family: var(--font-display); font-size: 12px; font-weight: 600; letter-spacing: 0.18em; text-transform: uppercase; color: var(--blue); margin: 30px 0 10px; }
  section { border: 1px solid var(--line); background: var(--bg-card); border-radius: 3px; padding: 16px 18px; }
  ul { padding-left: 20px; }
  li { margin: 5px 0; }
  a { color: var(--blue); }
  code, pre { font-family: var(--font-mono); background: #0d1210; border: 1px solid var(--line); border-radius: 2px; }
  code { padding: 1px 5px; font-size: 12px; }
  pre { padding: 10px 12px; margin: 8px 0; overflow-x: auto; font-size: 12px; color: var(--green); white-space: pre-wrap; word-break: break-all; }
  .dl { display: flex; gap: 14px; flex-wrap: wrap; margin: 14px 0 6px; }
  .btn {
    font-family: var(--font-display); font-size: 13px; font-weight: 700; letter-spacing: 0.1em;
    text-decoration: none; text-align: center; border-radius: 2px; padding: 13px 22px; flex: 1 1 220px;
    background: var(--amber); color: #1a1206; border: 1px solid var(--amber); box-shadow: 0 0 16px -4px #ffb45466;
  }
  .btn:hover { background: #ffc678; }
  .btn small { display: block; font-family: var(--font-mono); font-weight: 400; font-size: 10px; letter-spacing: 0; margin-top: 3px; }
  .btn.off { background: transparent; color: var(--ink-faint); border-color: var(--line-bright); box-shadow: none; pointer-events: none; }
  .note { color: var(--ink-dim); font-size: 12px; margin-top: 8px; }
  .warn { color: var(--amber); }
  .steps { color: var(--ink-dim); }
  .steps b { color: var(--ink); font-weight: 600; }
</style>
</head>
<body>
<main>
  <header><span class="dot"></span><h1>DECKHAND</h1><span class="sub">join the fleet</span></header>
  <div class="buildline">served by <b>${esc(machine)}</b> &middot; <span class="${haveShelf ? 'ok' : 'bad'}">${buildLine}</span></div>
  ${haveShelf ? '' : `<section><span class="warn">This hub holds no releases and the fleet's release machine is not connected right now, so the installers cannot be generated. Open /install on the release machine, or try again when it is back.</span></section>`}

  <h2>Before you install</h2>
  <section class="steps">
    <ul>
      <li><b>Tailscale</b> installed and signed in to the same tailnet — it is the fleet's network and trust boundary (<a href="https://tailscale.com/download">tailscale.com/download</a>).</li>
      <li><b>Node.js 20+</b> — the installer checks, and offers to install it (winget on Windows, Homebrew on macOS) when missing.</li>
      <li><b>Claude Code</b> installed and signed in as you, for agent sessions — the hub itself runs without it (terminal cards only).</li>
    </ul>
  </section>

  <h2>Download</h2>
  <section>
    <div class="dl">
      <a class="btn ${haveShelf ? '' : 'off'}" href="${haveShelf ? '/install/deckhand-install.cmd' : '#'}" ${haveShelf ? 'download' : ''}>DOWNLOAD FOR WINDOWS<small>deckhand-install.cmd</small></a>
      <a class="btn ${haveShelf ? '' : 'off'}" href="${haveShelf ? '/install/deckhand-install.command' : '#'}" ${haveShelf ? 'download' : ''}>DOWNLOAD FOR MAC<small>deckhand-install.command</small></a>
    </div>
    <p class="note"><b class="warn">Windows:</b> your browser may warn about the download (Keep it), and SmartScreen will warn on first run — click <b>More info &rarr; Run anyway</b>. The installer asks for administrator rights (UAC) to create the service and firewall rules.</p>
    <p class="note"><b class="warn">macOS:</b> Gatekeeper blocks double-clicked unsigned downloads — <b>right-click the file &rarr; Open &rarr; Open</b>, or run it from Terminal: <code>bash ~/Downloads/deckhand-install.command</code></p>
    <p class="note"><b>Linux</b> stays a copy-paste line (installs a systemd service; run it as the user whose sign-ins the sessions should use):</p>
    <pre>${oneLiner ? esc(oneLiner) : '(release shelf not reachable — no download URL to embed)'}</pre>
  </section>

  <h2>What the installer does</h2>
  <section class="steps">
    <ul>
      <li>Refuses to touch a machine that already runs a hub — a running hub updates itself from its dashboard (ADMIN &rarr; UPDATE).</li>
      <li>Checks Tailscale and Node 20+, asks for an install folder and a projects root (sensible defaults), downloads the current release from the shelf, extracts it and runs <code>npm install</code>.</li>
      <li><b>Windows:</b> writes <code>hub-env.cmd</code>, adds the two firewall rules (TCP + UDP 5959&ndash;5969), installs the Windows service, waits for the hub to answer — then tells you exactly how to make the service <b>run as your user</b> (Claude Code's sign-ins live in your profile; LocalSystem has none): <code>install.ps1 -Mode service -Account .\&lt;you&gt;</code> or the services.msc Log&nbsp;On tab. Microsoft-account and PIN sign-ins usually need a local password — or use <code>-Mode startup</code> instead.</li>
      <li><b>macOS:</b> installs a per-user LaunchAgent, waits for the hub, and prints the always-on notes: automatic login (FileVault off), keep the Mac awake.</li>
      <li>Logs everything it does, and a dry run prints every step without changing the system: <code>deckhand-install.cmd -DryRun</code> / <code>bash deckhand-install.command --dry-run</code>.</li>
    </ul>
  </section>

  <h2>After it finishes</h2>
  <section class="steps">
    Open <code>http://127.0.0.1:5959</code> on the new machine — within a minute every other dashboard in the fleet shows it, and vice versa. The hub keeps itself up to date from the fleet's release shelf from then on.
  </section>
</main>
</body>
</html>
`;
}
