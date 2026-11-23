// Wake the TV through the Chromecast using Google's official Cast SDK (the same code
// YouTube uses). Starting a Cast session launches the receiver app on the Chromecast,
// which sends HDMI-CEC "one touch play": the TV turns on (even from deep standby)
// and switches to the Chromecast's input.

import GoogleCast from 'react-native-google-cast';
import type { Device } from 'react-native-google-cast';

export type CastTarget = { deviceId: string; name: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Every native call is bounded, so the app can never sit on "Looking…" forever.
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms)),
  ]);
}

const errText = (e: any) => String(e?.message ?? e);

/** Discover Cast devices, waiting up to `timeoutMs` for at least one to appear. Throws on library errors. */
export async function discoverCastDevices(timeoutMs = 8000): Promise<CastTarget[]> {
  let dm;
  try {
    dm = GoogleCast.getDiscoveryManager();
  } catch (e) {
    throw new Error(`Cast library not available: ${errText(e)}`);
  }
  await withTimeout(Promise.resolve().then(() => dm.startDiscovery()), 3000, 'start discovery').catch(() => {});
  const start = Date.now();
  let devices: Device[] = [];
  while (Date.now() - start < timeoutMs) {
    devices = await withTimeout(Promise.resolve().then(() => dm.getDevices()), 3000, 'device list');
    if (devices.length) break;
    await sleep(400);
  }
  if (devices.length) {
    await sleep(800); // let stragglers appear when several exist
    devices = await withTimeout(Promise.resolve().then(() => dm.getDevices()), 3000, 'device list').catch(
      () => devices,
    );
  }
  return devices.map((d) => ({ deviceId: d.deviceId, name: d.friendlyName }));
}

/** Start a Cast session on a known device. Resolves when the Chromecast confirms. */
export async function startCastSession(deviceId: string, timeoutMs = 20000): Promise<void> {
  const sm = GoogleCast.getSessionManager();
  // Drop any session this app left open, so the receiver relaunches and CEC fires again.
  await withTimeout(sm.endCurrentSession(true), 3000, 'end session').catch(() => {});
  await waitForSession(timeoutMs, async () => {
    const ok = await sm.startSession(deviceId);
    if (!ok) throw new Error('Chromecast refused the session');
  });
  disconnectSoon();
}

/** Fallback: open Google's own cast picker. Resolves with the device the user chose. */
export async function pickViaCastDialog(timeoutMs = 60000): Promise<CastTarget> {
  const sm = GoogleCast.getSessionManager();
  await withTimeout(sm.endCurrentSession(true), 3000, 'end session').catch(() => {});
  const session = await waitForSession(timeoutMs, async () => {
    const shown = await GoogleCast.showCastDialog();
    if (!shown) throw new Error("Google's cast picker could not open");
  });
  const dev: Device | null = await withTimeout<Device | null>(session.getCastDevice(), 3000, 'device info').catch(() => null);
  disconnectSoon();
  return { deviceId: dev?.deviceId ?? '', name: dev?.friendlyName ?? '' };
}

function waitForSession(timeoutMs: number, kickoff: () => void | Promise<void>): Promise<any> {
  const sm = GoogleCast.getSessionManager();
  return new Promise((resolve, reject) => {
    let done = false;
    const subs: { remove: () => void }[] = [];
    const finish = (err: Error | null, session?: any) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      subs.forEach((s) => s.remove());
      err ? reject(err) : resolve(session);
    };
    const timer = setTimeout(
      () => finish(new Error(`no Chromecast session within ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs,
    );
    subs.push(sm.onSessionStarted((s) => finish(null, s)));
    subs.push(sm.onSessionResumed((s) => finish(null, s)));
    subs.push(sm.onSessionStartFailed((_s, error) => finish(new Error(`session failed: ${error}`))));
    Promise.resolve()
      .then(kickoff)
      .catch((e) => finish(new Error(errText(e))));
  });
}

// The TV is awake once the session starts; disconnect without stopping the receiver.
function disconnectSoon() {
  setTimeout(() => GoogleCast.getSessionManager().endCurrentSession(false).catch(() => {}), 3000);
}
