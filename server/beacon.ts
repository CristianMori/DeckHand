import { createSocket, type Socket } from 'node:dgram';
import { networkInterfaces } from 'node:os';

/**
 * LAN discovery beacon. Devices on the local network that are not on the
 * tailnet have no way to find the hub — so the hub answers on UDP:
 *
 *   client → broadcast "DECKHAND?" to 255.255.255.255:5959
 *   hub    → replies with the same JSON as GET /api/hub-info, plus its URLs
 *
 * and announces itself unprompted every 30 s for passive listeners. The UDP
 * port is 5959 regardless of which HTTP port the hub walked to (the reply
 * says which); a second hub on the same machine walks the UDP port up too.
 * HUB_BEACON=0 disables it.
 */

const ANNOUNCE_MS = 30_000;
const QUERY = /^DECKHAND\??\s*$/i;

export interface BeaconIdentity {
  /** a getter: the fleet name is only known once the first tailnet sweep completes */
  machine: () => string;
  instanceId: string;
  version: string;
  build: number;
  port: number;
}

function lanInterfaces() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i): i is NonNullable<typeof i> => !!i && i.family === 'IPv4' && !i.internal);
}

/** Directed broadcast address of an interface (address | ~netmask). */
function broadcastOf(address: string, netmask: string): string {
  const a = address.split('.').map(Number);
  const m = netmask.split('.').map(Number);
  return a.map((o, i) => (o | (~m[i] & 255)) & 255).join('.');
}

export function startBeacon(id: BeaconIdentity): Socket | null {
  if (process.env.HUB_BEACON === '0') return null;
  const basePort = Number(process.env.HUB_BEACON_PORT) || 5959;

  const payload = () =>
    JSON.stringify({
      hub: 'deckhand',
      machine: id.machine(),
      instanceId: id.instanceId,
      version: id.version,
      build: id.build,
      port: id.port,
      urls: lanInterfaces().map((i) => `http://${i.address}:${id.port}`),
      auth: 'token',
    });

  const sock = createSocket({ type: 'udp4', reuseAddr: true });
  let announce: ReturnType<typeof setInterval> | null = null;
  let port = basePort;

  sock.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && port < basePort + 10) {
      port++;
      sock.bind(port);
      return;
    }
    console.warn(`[beacon] disabled: ${err.message}`);
    if (announce) clearInterval(announce);
    try {
      sock.close();
    } catch {
      /* already closed */
    }
  });

  sock.on('message', (msg, rinfo) => {
    if (!QUERY.test(msg.toString('utf8'))) return;
    sock.send(payload(), rinfo.port, rinfo.address);
  });

  sock.on('listening', () => {
    sock.setBroadcast(true);
    console.log(`[beacon] answering DECKHAND? on udp/${port}`);
    const shout = () => {
      const data = payload();
      for (const i of lanInterfaces()) {
        sock.send(data, basePort, broadcastOf(i.address, i.netmask), () => {
          /* a down interface just drops it */
        });
      }
    };
    shout();
    announce = setInterval(shout, ANNOUNCE_MS);
    announce.unref();
  });

  sock.bind(port);
  return sock;
}
