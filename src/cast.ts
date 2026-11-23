// Wake the TV through the Chromecast using Google's official Cast SDK (the same code
// YouTube uses). Starting a Cast session launches the receiver app on the Chromecast,
// which sends HDMI-CEC "one touch play": the TV turns on (even from deep standby)
// and switches to the Chromecast's input.

import GoogleCast from 'react-native-google-cast';
import type { Device } from 'react-native-google-cast';

export type CastTarget = { deviceId: string; name: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Discover Cast devices, waiting up to `timeoutMs` for at least one to appear. */
export async function discoverCastDevices(timeoutMs = 8000): Promise<CastTarget[]> {
  const dm = GoogleCast.getDiscoveryManager();
  await dm.startDiscovery().catch(() => {});
  const start = Date.now();
  let devices: Device[] = [];
  while (Date.now() - start < timeoutMs) {
    devices = await dm.getDevices().catch(() => []);
    if (devices.length) break;
    await sleep(400);
  }
  // Give stragglers a moment so the list is complete when several exist.
  if (devices.length) {
    await sleep(800);
    devices = await dm.getDevices().catch(() => devices);
  }
  return devices.map((d) => ({ deviceId: d.deviceId, name: d.friendlyName }));
}

/** Start a Cast session on the device. Resolves when the Chromecast confirms, rejects on failure/timeout. */
export async function startCastSession(deviceId: string, timeoutMs = 20000): Promise<void> {
  const sm = GoogleCast.getSessionManager();
  // Drop any session this app left open, so the receiver relaunches and CEC fires again.
  await sm.endCurrentSession(true).catch(() => {});

  await new Promise<void>((resolve, reject) => {
    let done = false;
    const subs: { remove: () => void }[] = [];
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      subs.forEach((s) => s.remove());
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(() => finish(new Error('Chromecast did not confirm within 20s')), timeoutMs);
    subs.push(sm.onSessionStarted(() => finish()));
    subs.push(sm.onSessionResumed(() => finish()));
    subs.push(sm.onSessionStartFailed((_s, error) => finish(new Error(`session failed: ${error}`))));
    sm.startSession(deviceId).then(
      (ok) => !ok && finish(new Error('Chromecast refused the session')),
      (e) => finish(new Error(String(e?.message ?? e))),
    );
  });

  // The TV is awake now; disconnect without stopping the receiver.
  setTimeout(() => sm.endCurrentSession(false).catch(() => {}), 3000);
}
