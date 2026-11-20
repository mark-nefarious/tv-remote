// Samsung Tizen (2016+) local remote control API.
// Remote channel: wss://<ip>:8002/api/v2/channels/samsung.remote.control
// Device info:    http://<ip>:8001/api/v2/

import { base64 } from './base64';

export type TvInfo = { name: string; model: string; mac: string; powerState?: string };
export type TvStatus = 'disconnected' | 'connecting' | 'waiting-for-allow' | 'connected' | 'denied';
export type TextResult = 'sent' | 'sent-no-keyboard' | 'not-connected';

type Listener = {
  onStatus?: (s: TvStatus) => void;
  onToken?: (token: string) => void;
  // True while the TV's on-screen keyboard is open (ms.remote.imeStart .. imeEnd).
  onIme?: (open: boolean) => void;
  // Last connection problem, for the status line. Empty when healthy.
  onDiag?: (msg: string) => void;
};

const CLIENT_NAME = base64('Mark Remote');

// RN's WebSocket uses readTimeout(0), so a TCP/TLS handshake that stalls on a busy TV
// never errors. Abort and retry ourselves if the socket hasn't opened by then.
const OPEN_TIMEOUT_MS = 5000;
// Once open, a known token gets ms.channel.connect almost immediately. Any longer
// means the TV is showing its Allow prompt.
const ALLOW_PROMPT_MS = 2500;
// Reconnect delays after a drop. First retry is immediate.
const RETRY_MS = [0, 500, 1000, 2000, 4000, 8000, 15000];
const PING_EVERY_MS = 15000;
const PING_TIMEOUT_MS = 2500;

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
  // True while the app wants a live connection. Drives auto-reconnect.
  private wanted = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];

  // Our client id on the TV's channel, from ms.channel.connect.
  private clientId: string | null = null;
  private imeOpen = false;
  private firstTextSent = false;

  // App-level liveness check: an ms.channel.emit addressed to ourselves comes back as
  // an event. Only trusted once an echo has been seen, so a TV that doesn't relay
  // emits never gets disconnected by it.
  private pingSeen = false;
  private pingPending: ReturnType<typeof setTimeout> | null = null;
  private pingMisses = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

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

  get keyboardOpen() {
    return this.imeOpen;
  }

  // Reconnect only if nothing is in flight, so hold-to-repeat can't spam connects.
  ensureConnected() {
    if (this.status === 'disconnected') this.connect();
  }

  private setStatus(s: TvStatus) {
    if (s === this.status) return;
    this.status = s;
    this.listener.onStatus?.(s);
  }

  private diag(msg: string) {
    this.listener.onDiag?.(msg);
  }

  private setIme(open: boolean) {
    if (open === this.imeOpen) return;
    this.imeOpen = open;
    this.firstTextSent = false;
    this.listener.onIme?.(open);
  }

  private scheduleRetry() {
    if (!this.wanted || this.retryTimer) return;
    const delay = RETRY_MS[Math.min(this.retries, RETRY_MS.length - 1)];
    this.retries++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.wanted && this.status === 'disconnected') this.connect();
    }, delay);
  }

  private clearTimers() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.timers.forEach(clearTimeout);
    this.timers = [];
    if (this.pingPending) clearTimeout(this.pingPending);
    this.pingPending = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  connect() {
    this.close();
    this.wanted = true;
    this.setStatus('connecting');
    let url = `wss://${this.ip}:8002/api/v2/channels/samsung.remote.control?name=${CLIENT_NAME}`;
    if (this.token) url += `&token=${this.token}`;

    const started = Date.now();
    const ws = new WebSocket(url);
    this.ws = ws;
    let opened = false;

    const after = (ms: number, fn: () => void) => {
      this.timers.push(
        setTimeout(() => {
          if (this.ws === ws) fn();
        }, ms),
      );
    };

    after(OPEN_TIMEOUT_MS, () => {
      if (opened) return;
      this.diag(`TV accepted no secure connection within ${OPEN_TIMEOUT_MS / 1000}s. Retrying.`);
      this.drop(ws);
    });

    ws.onopen = () => {
      opened = true;
      after(ALLOW_PROMPT_MS, () => {
        if (this.status === 'connecting') this.setStatus('waiting-for-allow');
      });
    };

    ws.onmessage = (e) => {
      let msg: any;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      switch (msg.event) {
        case 'ms.channel.connect': {
          const token = msg.data?.token;
          if (token && token !== this.token) {
            this.token = String(token);
            this.listener.onToken?.(this.token);
          }
          this.clientId = msg.data?.id ? String(msg.data.id) : null;
          this.retries = 0;
          this.pingMisses = 0;
          this.diag(Date.now() - started > 2500 ? `Slow handshake: ${Date.now() - started} ms` : '');
          this.setStatus('connected');
          this.startHeartbeat();
          break;
        }
        case 'ms.channel.unauthorized':
          this.wanted = false;
          this.setStatus('denied');
          break;
        case 'ms.channel.timeOut':
          // Allow prompt ignored. Don't auto-retry or the TV re-prompts forever.
          this.wanted = false;
          this.diag('The Allow prompt on the TV timed out. Tap the TV name to try again.');
          this.close();
          this.setStatus('disconnected');
          break;
        case 'ms.remote.imeStart':
        case 'ms.remote.imeUpdate':
          this.setIme(true);
          break;
        case 'ms.remote.imeEnd':
        case 'ms.remote.imeDone':
          this.setIme(false);
          break;
        case 'tvremote.ping':
          this.pingSeen = true;
          this.pingMisses = 0;
          if (this.pingPending) clearTimeout(this.pingPending);
          this.pingPending = null;
          break;
      }
    };

    ws.onerror = (e: any) => {
      if (this.ws !== ws) return;
      this.diag(`Connection error${e?.message ? `: ${e.message}` : ''}`);
      this.drop(ws);
    };
    ws.onclose = (e: any) => {
      if (this.ws !== ws) return;
      if (this.status === 'connected') this.diag(`TV closed the connection (code ${e?.code ?? '?'})`);
      this.drop(ws);
    };
  }

  private drop(ws: WebSocket) {
    if (this.ws !== ws) return;
    this.close();
    if (this.status !== 'denied') {
      this.setStatus('disconnected');
      this.scheduleRetry();
    }
  }

  private startHeartbeat() {
    this.heartbeat = setInterval(() => this.ping(), PING_EVERY_MS);
    this.ping();
  }

  // Check the socket is really alive (e.g. after the phone wakes). Reconnects if the TV
  // has echoed pings before and then misses two in a row.
  ping() {
    if (!this.ws || this.status !== 'connected' || !this.clientId || this.pingPending) return;
    const ws = this.ws;
    const ok = this.send({
      method: 'ms.channel.emit',
      params: { event: 'tvremote.ping', to: this.clientId },
    });
    if (!ok) return this.drop(ws);
    this.pingPending = setTimeout(() => {
      this.pingPending = null;
      // Two misses in a row, so one slow reply from a busy TV can't cause a reconnect.
      if (this.ws !== ws || !this.pingSeen) return;
      if (++this.pingMisses >= 2) {
        this.diag('Connection went quiet. Reconnecting.');
        this.drop(ws);
      } else this.ping(); // re-check straight away rather than in 15s
    }, PING_TIMEOUT_MS);
  }

  // Stop: close the socket and disable auto-reconnect (app backgrounded or unmounted).
  stop() {
    this.wanted = false;
    this.close();
    if (this.status !== 'denied') this.setStatus('disconnected');
  }

  close() {
    this.clearTimers();
    this.setIme(false);
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
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

  // Returns false if it couldn't be sent (not connected). Never queued.
  sendKey(key: string, cmd: 'Click' | 'Press' | 'Release' = 'Click') {
    return this.send({
      method: 'ms.remote.control',
      params: { Cmd: cmd, DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' },
    });
  }

  // Text only lands while a TV text field has its on-screen keyboard open; the TV
  // signals that with ms.remote.imeStart. Some TVs need the textReceived broadcast
  // before the first string after the keyboard opens.
  sendText(text: string): TextResult {
    if (!this.isConnected) return 'not-connected';
    if (!this.firstTextSent) {
      this.send({ method: 'ms.channel.emit', params: { event: 'custom.remote.textReceived', to: 'broadcast' } });
      this.firstTextSent = true;
    }
    const ok = this.send({
      method: 'ms.remote.control',
      params: { Cmd: base64(text), DataOfCmd: 'base64', TypeOfRemote: 'SendInputString' },
    });
    if (!ok) return 'not-connected';
    const wasOpen = this.imeOpen;
    this.send({ method: 'ms.remote.control', params: { TypeOfRemote: 'SendInputEnd' } });
    this.firstTextSent = false;
    return wasOpen ? 'sent' : 'sent-no-keyboard';
  }
}
