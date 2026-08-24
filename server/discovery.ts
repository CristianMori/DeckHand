import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { FLEET_PORT_MIN, FLEET_PORT_MAX, resolveTailscaleExe } from './config.js';

const SWEEP_INTERVAL_MS = 60_000;
const PROBE_TIMEOUT_MS = 1_500;

export interface DiscoveredHub {
  machine: string;
  instanceId: string;
  ip: string;
  port: number;
  url: string;
}

interface TailscaleDevice {
  HostName: string;
  /** full tailnet name, e.g. "desktop.tailxxxx.ts.net." */
  DNSName?: string;
  TailscaleIPs?: string[];
  Online?: boolean;
}

interface TailscaleStatus {
  Self: TailscaleDevice;
  Peer?: Record<string, TailscaleDevice>;
}

function v4(device: TailscaleDevice): string | undefined {
  return device.TailscaleIPs?.find((ip) => !ip.includes(':'));
}

async function probe(ip: string, port: number): Promise<DiscoveredHub | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`http://${ip}:${port}/api/hub-info`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const info = (await res.json()) as { hub?: string; machine?: string; instanceId?: string };
    // accept the pre-rename identity during the fleet's transition window
  if ((info.hub !== 'deckhand' && info.hub !== 'claude-hub') || !info.machine || !info.instanceId) return null;
    return { machine: info.machine, instanceId: info.instanceId, ip, port, url: `http://${ip}:${port}` };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Finds sibling hubs with zero configuration: asks the local tailscale daemon
 * who is on the tailnet, then probes each online device (including this one —
 * multiple hubs per machine are legal) across the hub port range.
 */
export class Discovery {
  private tailscaleExe = resolveTailscaleExe();
  private timer: ReturnType<typeof setInterval> | null = null;
  selfName = hostname();

  constructor(
    private selfInstanceId: string,
    private onSweep: (hubs: DiscoveredHub[]) => void,
  ) {}

  start() {
    if (!this.tailscaleExe) {
      console.log('[discovery] tailscale not found — running solo (no fleet)');
      return;
    }
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  private status(): Promise<TailscaleStatus | null> {
    return new Promise((resolve) => {
      execFile(this.tailscaleExe!, ['status', '--json'], { encoding: 'utf8' }, (err, stdout) => {
        if (err) return resolve(null);
        try {
          resolve(JSON.parse(stdout) as TailscaleStatus);
        } catch {
          resolve(null);
        }
      });
    });
  }

  private async sweep() {
    const status = await this.status();
    if (!status?.Self) return;

    // prefer the tailnet device name (matches MagicDNS URLs) over the OS hostname
    const dnsLabel = status.Self.DNSName?.split('.')[0];
    if (dnsLabel) this.selfName = dnsLabel;
    else if (status.Self.HostName) this.selfName = status.Self.HostName;

    const ips: string[] = [];
    const selfIp = v4(status.Self);
    if (selfIp) ips.push(selfIp);
    for (const peer of Object.values(status.Peer ?? {})) {
      const ip = v4(peer);
      if (ip && peer.Online) ips.push(ip);
    }

    const probes: Promise<DiscoveredHub | null>[] = [];
    for (const ip of ips) {
      for (let port = FLEET_PORT_MIN; port <= FLEET_PORT_MAX; port++) {
        probes.push(probe(ip, port));
      }
    }
    const found = (await Promise.all(probes)).filter(
      (h): h is DiscoveredHub => h !== null && h.instanceId !== this.selfInstanceId,
    );
    this.onSweep(found);
  }
}
