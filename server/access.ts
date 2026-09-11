import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';

/**
 * Who may talk to the hub.
 *
 *   loopback, this machine's own addresses, the tailnet   → trusted, no token
 *   private LAN ranges (10/8, 172.16/12, 192.168/16)      → allowed with the API token
 *   anything else                                         → 403
 *
 * The token lives in data/api-token (generated on first start). LAN callers
 * present it as `Authorization: Bearer <token>`, as the `deckhand_token`
 * cookie, or once as `?token=` — which sets that cookie, so a phone browser
 * on the Wi-Fi opens http://<lan-ip>:5959/?token=… a single time.
 * HUB_LAN=0 switches LAN access off again (tailnet-only, as before).
 */

export const LAN_ENABLED = process.env.HUB_LAN !== '0';
export const TOKEN_FILE = join(DATA_DIR, 'api-token');
export const COOKIE_NAME = 'deckhand_token';

let apiToken = '';

/** Read the token, minting one on first start. */
export function loadApiToken(): string {
  if (apiToken) return apiToken;
  try {
    if (existsSync(TOKEN_FILE)) apiToken = readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    /* unreadable — regenerate below */
  }
  if (!apiToken) {
    apiToken = randomBytes(24).toString('hex');
    writeFileSync(TOKEN_FILE, apiToken + '\n', { mode: 0o600 });
    console.log(`[access] generated API token in ${TOKEN_FILE}`);
  }
  return apiToken;
}

// Own addresses matter because Windows resolves the machine's own name to
// its LAN IP — browsing your own hub by name arrives from that IP.
let ownAddrs = new Set<string>();
let ownAddrsAt = 0;
function isOwnAddress(ip: string): boolean {
  const now = Date.now();
  if (now - ownAddrsAt > 30_000) {
    ownAddrs = new Set(
      Object.values(networkInterfaces())
        .flat()
        .filter((i): i is NonNullable<typeof i> => !!i)
        .map((i) => i.address.toLowerCase()),
    );
    ownAddrsAt = now;
  }
  return ownAddrs.has(ip.toLowerCase());
}

const stripMapped = (addr: string) => addr.replace(/^::ffff:/, '');

/** Loopback, own interface, or tailnet (100.64.0.0/10 v4, fd7a:115c:a1e0::/48 v6). */
export function isTrustedSource(addr: string | undefined): boolean {
  if (!addr) return false;
  const ip = stripMapped(addr);
  if (ip === '127.0.0.1' || ip === '::1') return true;
  const m = ip.match(/^100\.(\d+)\./);
  if (m) {
    const octet = Number(m[1]);
    return octet >= 64 && octet <= 127;
  }
  if (ip.toLowerCase().startsWith('fd7a:115c:a1e0')) return true;
  return isOwnAddress(ip);
}

/** RFC 1918 private ranges — the home/office LAN. */
export function isLanSource(addr: string | undefined): boolean {
  if (!addr) return false;
  const ip = stripMapped(addr);
  if (/^10\./.test(ip) || /^192\.168\./.test(ip)) return true;
  const m = ip.match(/^172\.(\d+)\./);
  return !!m && Number(m[1]) >= 16 && Number(m[1]) <= 31;
}

function sameToken(candidate: string | undefined): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(loadApiToken());
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The token a request carries, from header, cookie or query — in that order. */
function presentedToken(headers: Record<string, string | string[] | undefined>, url: string) {
  const auth = headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return { token: auth.slice(7).trim(), viaQuery: false };
  }
  const cookie = headers.cookie;
  if (typeof cookie === 'string') {
    const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
    if (m) return { token: decodeURIComponent(m[1]), viaQuery: false };
  }
  try {
    const q = new URL(url, 'http://x').searchParams.get('token');
    if (q) return { token: q, viaQuery: true };
  } catch {
    /* unparsable url */
  }
  return { token: undefined, viaQuery: false };
}

export interface AccessVerdict {
  /** 0 = allowed */
  status: 0 | 401 | 403;
  /** the caller authenticated with ?token= — hand it the cookie so the rest of the page works */
  setCookie: boolean;
}

export function authorize(
  remoteAddress: string | undefined,
  headers: Record<string, string | string[] | undefined>,
  url: string,
): AccessVerdict {
  if (isTrustedSource(remoteAddress)) return { status: 0, setCookie: false };
  if (!LAN_ENABLED || !isLanSource(remoteAddress)) return { status: 403, setCookie: false };
  const { token, viaQuery } = presentedToken(headers, url);
  if (sameToken(token)) return { status: 0, setCookie: viaQuery };
  return { status: 401, setCookie: false };
}

export function cookieHeader(): string {
  return `${COOKIE_NAME}=${loadApiToken()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`;
}
