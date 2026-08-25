import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type { DiscoveredHub } from './discovery.js';
import type { FleetMachine, SessionInfo, SessionState } from './types.js';

const BACKOFF_BASE_MS = 1_500;
const BACKOFF_MAX_MS = 30_000;

export interface PeerAlert {
  machine: string;
  origin?: string;
  hubId: string;
  state: SessionState;
  name: string;
  detail?: string;
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_DEAD_MS = 75_000;

class Peer {
  ws: WebSocket | null = null;
  connected = false;
  sessions: SessionInfo[] = [];
  private lastSessionsJson = '';
  attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lastSeen = 0;
  private closed = false;

  constructor(
    public info: DiscoveredHub,
    private events: Federation,
  ) {
    this.connect();
  }

  get key() {
    return this.info.url;
  }

  private connect() {
    if (this.closed) return;
    const ws = new WebSocket(`ws://${this.info.ip}:${this.info.port}/ws/control`);
    this.ws = ws;

    ws.on('open', () => {
      this.attempts = 0;
      this.connected = true;
      this.lastSeen = Date.now();
      // A laptop sleeping mid-connection leaves this socket half-open: no
      // close event ever fires and the peer looks connected forever while
      // receiving nothing. Ping regularly and kill silent links so the
      // normal reconnect path takes over.
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastSeen > HEARTBEAT_DEAD_MS) {
          ws.terminate(); // emits close → dropped() → reconnect with backoff
          return;
        }
        try {
          ws.ping();
        } catch {
          /* socket already dying */
        }
      }, HEARTBEAT_INTERVAL_MS);
      this.heartbeat.unref?.();
      this.events.emit('change');
    });
    ws.on('pong', () => {
      this.lastSeen = Date.now();
    });
    ws.on('message', (raw) => {
      this.lastSeen = Date.now();
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'sessions' && Array.isArray(msg.sessions)) {
          // keep only sessions the peer itself owns — a peer's broadcast is its
          // merged fleet view, and third-machine sessions arrive via our own
          // direct connection to that third machine (prevents dupes and loops)
          const next = (msg.sessions as SessionInfo[]).filter(
            (s) => s.origin === this.info.instanceId,
          );
          // CRITICAL: only propagate real changes. Hubs are each other's
          // control clients — unconditional re-broadcast on receive makes an
          // infinite broadcast storm between hubs (OOM in minutes).
          const json = JSON.stringify(next);
          if (json !== this.lastSessionsJson) {
            this.lastSessionsJson = json;
            this.sessions = next;
            this.events.emit('change');
          }
        } else if (msg.type === 'alert' && msg.hubId) {
          // same ownership filter for alerts
          if (msg.origin === this.info.instanceId) {
            this.events.emit('alert', { ...msg, machine: this.info.machine } as PeerAlert);
          }
        }
      } catch {
        /* ignore malformed frames */
      }
    });
    ws.on('close', () => this.dropped());
    ws.on('error', () => ws.close());
  }

  private dropped() {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    const wasConnected = this.connected;
    this.connected = false;
    this.ws = null;
    if (wasConnected) this.events.emit('change');
    if (this.closed) return;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(this.attempts++, 6));
    this.retryTimer = setTimeout(() => this.connect(), delay);
    this.retryTimer.unref();
  }

  close() {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close();
  }
}

/**
 * Holds one control connection per sibling hub and merges their session lists
 * into ours. Peers that drop stay listed with cached sessions marked
 * unreachable — sessions outlive links; visibility comes back when they do.
 * Events: 'change' (re-broadcast merged list), 'alert' (PeerAlert).
 */
export class Federation extends EventEmitter {
  private peers = new Map<string, Peer>();

  /** Reconcile with a discovery sweep: add new hubs, adopt moved ports/restarts. */
  setDiscovered(hubs: DiscoveredHub[]) {
    for (const hub of hubs) {
      const existing = this.peers.get(hub.url);
      // a restarted hub keeps its URL but gets a fresh instanceId — replace the
      // entry or its origin-filter drops every session the peer now owns
      if (existing && existing.info.instanceId !== hub.instanceId) {
        existing.close();
        this.peers.delete(hub.url);
      }
      if (!this.peers.get(hub.url)) {
        // same machine may have re-appeared on a new port — drop the stale entry
        for (const [key, peer] of this.peers) {
          if (peer.info.instanceId === hub.instanceId) {
            peer.close();
            this.peers.delete(key);
          }
        }
        this.peers.set(hub.url, new Peer(hub, this));
        this.emit('change');
      }
    }
    // peers absent from the sweep are NOT removed: an offline machine keeps its
    // unreachable cards. Remove only exact-port duplicates handled above.
  }

  mergedSessions(local: SessionInfo[]): SessionInfo[] {
    const merged = [...local];
    for (const peer of this.peers.values()) {
      if (peer.connected) {
        merged.push(...peer.sessions);
      } else {
        merged.push(
          ...peer.sessions.map((s) => ({ ...s, unreachable: true, alive: false })),
        );
      }
    }
    return merged;
  }

  machines(selfName: string): FleetMachine[] {
    const list: FleetMachine[] = [{ machine: selfName, self: true, connected: true }];
    const seen = new Set([selfName]);
    for (const peer of this.peers.values()) {
      if (seen.has(peer.info.machine)) continue;
      seen.add(peer.info.machine);
      list.push({
        machine: peer.info.machine,
        self: false,
        connected: peer.connected,
        url: peer.info.url,
      });
    }
    return list;
  }

  peerBySession(hubId: string): Peer | undefined {
    for (const peer of this.peers.values()) {
      if (peer.sessions.some((s) => s.hubId === hubId)) return peer;
    }
    return undefined;
  }

  connectedPeers(): Peer[] {
    return [...this.peers.values()].filter((p) => p.connected);
  }

  peerByMachine(machine: string): Peer | undefined {
    for (const peer of this.peers.values()) {
      if (peer.info.machine === machine && peer.connected) return peer;
    }
    return undefined;
  }

  /** Forward an API call to the peer that owns the resource. */
  async forward(
    peer: Peer,
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${peer.info.url}${path}`, {
      method: init?.method ?? 'GET',
      headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }

  termWsUrl(peer: Peer, hubId: string): string {
    return `ws://${peer.info.ip}:${peer.info.port}/ws/term/${hubId}`;
  }
}

export type { Peer };
