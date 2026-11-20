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

  constructor(
    public ip: string,
    private token: string | null,
    private listener: Listener,
  ) {}

  get isConnected() {
    return this.status === 'connected';
  }

  private setStatus(s: TvStatus) {
    this.status = s;
    this.listener.onStatus?.(s);
  }

  connect() {
    this.close();
    this.setStatus('connecting');
    let url = `wss://${this.ip}:8002/api/v2/channels/samsung.remote.control?name=${CLIENT_NAME}`;
    if (this.token) url += `&token=${this.token}`;

    const ws = new WebSocket(url);
    this.ws = ws;

    // Without a saved token the TV shows an "Allow" prompt before replying.
    const promptTimer = setTimeout(() => {
      if (this.status === 'connecting' && !this.token) this.setStatus('waiting-for-allow');
    }, 1500);

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
          this.setStatus('connected');
          this.requestApps();
          break;
        }
        case 'ms.channel.unauthorized':
          clearTimeout(promptTimer);
          this.setStatus('denied');
          break;
        case 'ms.channel.timeOut':
          clearTimeout(promptTimer);
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

    ws.onerror = () => {
      clearTimeout(promptTimer);
      if (this.ws === ws) this.setStatus('disconnected');
    };
    ws.onclose = () => {
      clearTimeout(promptTimer);
      if (this.ws === ws && this.status !== 'denied') this.setStatus('disconnected');
    };
  }

  close() {
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
    if (this.ws && this.status === 'connected') this.ws.send(JSON.stringify(payload));
  }

  sendKey(key: string, cmd: 'Click' | 'Press' | 'Release' = 'Click') {
    this.send({
      method: 'ms.remote.control',
      params: { Cmd: cmd, DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' },
    });
  }

  // Works when a text field / on-screen keyboard is open on the TV.
  sendText(text: string) {
    this.send({
      method: 'ms.remote.control',
      params: { Cmd: base64(text), DataOfCmd: 'base64', TypeOfRemote: 'SendInputString' },
    });
    this.send({ method: 'ms.remote.control', params: { TypeOfRemote: 'SendInputEnd' } });
  }

  requestApps() {
    this.send({ method: 'ms.channel.emit', params: { event: 'ed.installedApp.get', to: 'host' } });
  }

  launchApp(app: TvApp) {
    this.send({
      method: 'ms.channel.emit',
      params: {
        event: 'ed.apps.launch',
        to: 'host',
        data: { appId: app.appId, action_type: app.appType === 2 ? 'DEEP_LINK' : 'NATIVE_LAUNCH' },
      },
    });
  }
}
