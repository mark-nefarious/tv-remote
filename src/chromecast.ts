// Minimal Google Cast (CASTV2) client: just enough to launch an app on a Chromecast.
// Launching an app makes the Chromecast send HDMI-CEC "one touch play", which turns the TV on
// (even from deep standby, when the TV's own Wi-Fi is asleep) and switches it to the Chromecast's input.

import TcpSocket from 'react-native-tcp-socket';
import { Buffer } from 'buffer';

// The YouTube receiver: launching it is exactly what casting from the YouTube app does,
// and on this TV it sends both "turn on" and "switch to me" over HDMI-CEC.
const YOUTUBE_RECEIVER = '233637DE';
const NS_CONNECTION = 'urn:x-cast:com.google.cast.tp.connection';
const NS_RECEIVER = 'urn:x-cast:com.google.cast.receiver';

export type CastDevice = { ip: string; name: string };

/* ---------- protobuf CastMessage encode/decode ---------- */

function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
}

function stringField(field: number, value: string): number[] {
  const bytes = Array.from(Buffer.from(value, 'utf8'));
  return [(field << 3) | 2, ...varint(bytes.length), ...bytes];
}

export function encodeCastMessage(namespace: string, payload: object): Buffer {
  const body = [
    (1 << 3) | 0, 0, // protocol_version = CASTV2_1_0
    ...stringField(2, 'sender-0'),
    ...stringField(3, 'receiver-0'),
    ...stringField(4, namespace),
    (5 << 3) | 0, 0, // payload_type = STRING
    ...stringField(6, JSON.stringify(payload)),
  ];
  const len = body.length;
  return Buffer.from([(len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff, ...body]);
}

function decodeCastMessage(buf: Buffer): { namespace: string; payload: string } {
  let i = 0;
  let namespace = '';
  let payload = '';
  const readVarint = () => {
    let result = 0;
    let shift = 0;
    while (i < buf.length) {
      const b = buf[i++];
      result += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    return result;
  };
  while (i < buf.length) {
    const key = readVarint();
    const field = key >>> 3;
    const wire = key & 7;
    if (wire === 0) readVarint();
    else if (wire === 2) {
      const len = readVarint();
      const s = Buffer.from(buf.slice(i, i + len)).toString('utf8');
      i += len;
      if (field === 4) namespace = s;
      if (field === 6) payload = s;
    } else break;
  }
  return { namespace, payload };
}

/* ---------- launch (wake + switch input) ---------- */

function launchOnce(ip: string, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    let pending = Buffer.alloc(0);
    const socket = TcpSocket.connectTLS(
      // The Chromecast uses a device certificate that won't validate against public CAs.
      { host: ip, port: 8009, tlsCheckValidity: false, connectTimeout: 5000 } as any,
      () => {
        socket.write(encodeCastMessage(NS_CONNECTION, { type: 'CONNECT' }));
        socket.write(encodeCastMessage(NS_RECEIVER, { type: 'LAUNCH', appId: YOUTUBE_RECEIVER, requestId: 1 }));
      },
    );
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {}
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(() => finish(new Error('Chromecast did not confirm in time')), timeoutMs);
    socket.on('data', (chunk: any) => {
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      while (pending.length >= 4) {
        const len = pending.readUInt32BE(0);
        if (pending.length < 4 + len) break;
        const msg = decodeCastMessage(Buffer.from(pending.slice(4, 4 + len)));
        pending = Buffer.from(pending.slice(4 + len));
        if (msg.namespace !== NS_RECEIVER) continue;
        try {
          const p = JSON.parse(msg.payload);
          if (p.type === 'LAUNCH_ERROR') finish(new Error(`Chromecast refused: ${p.reason ?? 'unknown'}`));
          const apps: any[] = p.status?.applications ?? [];
          if (p.type === 'RECEIVER_STATUS' && apps.some((a) => a.appId === YOUTUBE_RECEIVER)) finish();
        } catch {}
      }
    });
    socket.on('error', (e: any) => finish(new Error(`socket error: ${e?.message ?? JSON.stringify(e)}`)));
    socket.on('timeout', () => finish(new Error('connect timed out')));
    socket.on('close', () => finish(new Error('Chromecast closed the connection')));
  });
}

export type CastStep = 'connecting' | 'sent' | 'retrying' | 'done';

/** Launch YouTube on the Chromecast, retrying for up to `totalMs` if it's slow to answer. */
export async function wakeViaChromecast(
  ip: string,
  onStep: (step: CastStep, attempt: number) => void = () => {},
  isLive: () => boolean = () => true,
  totalMs = 20000,
): Promise<void> {
  const start = Date.now();
  let attempt = 0;
  let lastErr: unknown;
  while (isLive() && Date.now() - start < totalMs) {
    attempt++;
    onStep(attempt === 1 ? 'connecting' : 'retrying', attempt);
    try {
      await launchOnce(ip);
      onStep('done', attempt);
      return;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Chromecast did not respond');
}

/* ---------- discovery ---------- */

function portOpen(ip: string, port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const end = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {}
      resolve(ok);
    };
    const sock = TcpSocket.createConnection({ host: ip, port, connectTimeout: timeoutMs }, () => end(true));
    const timer = setTimeout(() => end(false), timeoutMs + 200);
    sock.on('error', () => end(false));
  });
}

async function castName(ip: string): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 1500);
  try {
    const res = await fetch(`http://${ip}:8008/setup/eureka_info?params=name`, { signal: ctrl.signal });
    const json = await res.json();
    return String(json.name ?? '');
  } catch {
    return '';
  } finally {
    clearTimeout(t);
  }
}

export function isCastReachable(ip: string) {
  return portOpen(ip, 8009, 3000);
}

/** Scan the /24 around `nearIp` for Cast devices (port 8009). */
export async function findCastDevices(nearIp: string, exclude: string[] = []): Promise<CastDevice[]> {
  const prefix = nearIp.replace(/\.\d+$/, '.');
  const hosts = Array.from({ length: 254 }, (_, i) => prefix + (i + 1)).filter((h) => !exclude.includes(h));
  const found: string[] = [];
  for (let i = 0; i < hosts.length; i += 64) {
    const batch = hosts.slice(i, i + 64);
    const open = await Promise.all(batch.map((h) => portOpen(h, 8009)));
    batch.forEach((h, j) => open[j] && found.push(h));
  }
  return Promise.all(found.map(async (ip) => ({ ip, name: (await castName(ip)) || `Cast device ${ip}` })));
}
