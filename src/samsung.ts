// Samsung Tizen (2016+) local remote control API.
// Remote channel: wss://<ip>:8002/api/v2/channels/samsung.remote.control
// Device info:    http://<ip>:8001/api/v2/

import { base64 } from './base64';

export type TvApp = { appId: string; name: string; appType: number };
export type TvInfo = { name: string; model: string; mac: string; powerState?: string };
export type TvStatus = 'disconnected' | 'connecting' | 'waiting-for-allow' | 'connected' | 'denied';

type Listener = {
  onStatus?: (s: TvStatus) => void;
  onToken?: (token: string) => void;
  onApps?: (apps: TvApp[]) => void;
};

const CLIENT_NAME = base64('Mark Remote');

export async function fetchTvInfo(ip: string, timeoutMs = 3000): Promise<TvInfo | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${ip}:8001/api/v2/`, { signal: ctrl.signal });
    const json = await res.json();
    const d = json.device ?? {};
    return {
      name: d.name ?? json.name ?? 'Samsung TV',
      model: d.modelName ?? '',
      mac: d.wifiMac ?? '',
      powerState: d.PowerState,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export class SamsungTv {
  private ws: WebSocket | null = null;
  private status: TvStatus = 'disconnected';
  // True while the app wants a live connection (foreground). Drives auto-reconnect.
  private wanted = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 1000;

  constructor(
    public ip: string,
    private token: string | null,
    private listener: Listener,
  ) {}

  get isConnected() {
    return this.status === 'connected';
  }

  get currentStatus() {
    return this.status;
  }

  // Reconnect only if nothing is in flight, so hold-to-repeat can't spam connects.
  ensureConnected() {
    if (this.status === 'disconnected') this.connect();
  }

  private scheduleRetry() {
    if (!this.wanted || this.retryTimer) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(delay * 2, 30000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.wanted && this.status === 'disconnected') this.connect();
    }, delay);
  }

  private clearRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private setStatus(s: TvStatus) {
    this.status = s;
    this.listener.onStatus?.(s);
  }

  connect() {
    this.close();
    this.wanted = true;
    this.setStatus('connecting');
    let url = `wss://${this.ip}:8002/api/v2/channels/samsung.remote.control?name=${CLIENT_NAME}`;
    if (this.token) url += `&token=${this.token}`;

    const ws = new WebSocket(url);
    this.ws = ws;

    // The TV shows an "Allow" prompt before replying when there is no token, or when the
    // saved token is no longer valid (TV reset, device list cleared).
    const promptTimer = setTimeout(
      () => {
        if (this.ws === ws && this.status === 'connecting') this.setStatus('waiting-for-allow');
      },
      this.token ? 4000 : 1500,
    );

    ws.onmessage = (e) => {
      let msg: any;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      switch (msg.event) {
        case 'ms.channel.connect': {
          clearTimeout(promptTimer);
          const token = msg.data?.token;
          if (token && token !== this.token) {
            this.token = String(token);
            this.listener.onToken?.(this.token);
          }
          this.retryDelay = 1000;
          this.setStatus('connected');
          this.requestApps();
          break;
        }
        case 'ms.channel.unauthorized':
          clearTimeout(promptTimer);
          this.wanted = false;
          this.setStatus('denied');
          break;
        case 'ms.channel.timeOut':
          // Allow prompt ignored. Don't auto-retry or the TV re-prompts forever.
          clearTimeout(promptTimer);
          this.wanted = false;
          this.setStatus('disconnected');
          break;
        case 'ed.installedApp.get': {
          const list: any[] = msg.data?.data ?? [];
          this.listener.onApps?.(
            list
              .map((a) => ({ appId: String(a.appId), name: String(a.name), appType: Number(a.app_type) }))
              .sort((a, b) => a.name.localeCompare(b.name)),
          );
          break;
        }
      }
    };

    const dropped = () => {
      clearTimeout(promptTimer);
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.status !== 'denied') {
        this.setStatus('disconnected');
        this.scheduleRetry();
      }
    };
    ws.onerror = dropped;
    ws.onclose = dropped;
  }

  // Stop: close the socket and disable auto-reconnect (app backgrounded or unmounted).
  stop() {
    this.wanted = false;
    this.close();
    if (this.status !== 'denied') this.setStatus('disconnected');
  }

  close() {
    this.clearRetry();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onclose = ws.onerror = ws.onmessage = null;
      try {
        ws.close();
      } catch {}
    }
  }

  private send(payload: object) {
    if (!this.ws || this.status !== 'connected') return false;
    try {
      this.ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  sendKey(key: string, cmd: 'Click' | 'Press' | 'Release' = 'Click') {
    this.send({
      method: 'ms.remote.control',
      params: { Cmd: cmd, DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' },
    });
  }

  // Works when a text field / on-screen keyboard is open on the TV.
  sendText(text: string): boolean {
    const ok = this.send({
      method: 'ms.remote.control',
      params: { Cmd: base64(text), DataOfCmd: 'base64', TypeOfRemote: 'SendInputString' },
    });
    if (ok) this.send({ method: 'ms.remote.control', params: { TypeOfRemote: 'SendInputEnd' } });
    return ok;
  }

  requestApps() {
    this.send({ method: 'ms.channel.emit', params: { event: 'ed.installedApp.get', to: 'host' } });
  }

  // app_type 2 = web app (DEEP_LINK), 4 = native (NATIVE_LAUNCH). DEEP_LINK is the
  // default for IDs not taken from the TV's own list.
  launchApp(app: Pick<TvApp, 'appId' | 'appType'>) {
    this.send({
      method: 'ms.channel.emit',
      params: {
        event: 'ed.apps.launch',
        to: 'host',
        data: { appId: app.appId, action_type: app.appType === 4 ? 'NATIVE_LAUNCH' : 'DEEP_LINK' },
      },
    });
  }
}
