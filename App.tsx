import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';

import { SamsungTv, TvApp, TvStatus, fetchTvInfo } from './src/samsung';
import { SavedTv, clearTv, loadTv, saveTv } from './src/storage';
import { wakeOnLan } from './src/wol';

const C = {
  bg: '#0E0F12',
  btn: '#1C1E24',
  btnPressed: '#2A2D36',
  text: '#F2F3F5',
  dim: '#8A8F9C',
  accent: '#4C8DFF',
  red: '#E5484D',
  green: '#30A46C',
  amber: '#F5A524',
};

export default function App() {
  const [tv, setTv] = useState<SavedTv | null | undefined>(undefined);

  useEffect(() => {
    loadTv().then(setTv);
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SafeAreaView style={s.root}>
        {tv === undefined ? (
          <ActivityIndicator color={C.accent} style={{ flex: 1 }} />
        ) : tv === null ? (
          <SetupScreen onDone={setTv} />
        ) : (
          <RemoteScreen
            tv={tv}
            onUpdate={(t) => {
              setTv(t);
              saveTv(t);
            }}
            onForget={async () => {
              await clearTv();
              setTv(null);
            }}
          />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

/* ---------------- Setup ---------------- */

function SetupScreen({ onDone }: { onDone: (tv: SavedTv) => void }) {
  const [ip, setIp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const connect = async () => {
    const clean = ip.trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(clean)) {
      setError('Enter an IP address like 192.168.1.42');
      return;
    }
    setBusy(true);
    setError('');
    const info = await fetchTvInfo(clean);
    setBusy(false);
    if (!info) {
      setError("Can't reach a Samsung TV at that address. Check the TV is on and on the same Wi-Fi.");
      return;
    }
    const tv: SavedTv = { ip: clean, mac: info.mac, name: info.name, token: null };
    await saveTv(tv);
    onDone(tv);
  };

  return (
    <KeyboardAvoidingView style={s.setup} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Text style={s.h1}>Connect your TV</Text>
      <Text style={s.p}>
        Find the IP on the TV: Settings › Connection › Network › Network Status › IP Settings.
      </Text>
      <TextInput
        value={ip}
        onChangeText={setIp}
        placeholder="192.168.1.42"
        placeholderTextColor={C.dim}
        keyboardType="decimal-pad"
        style={s.input}
        onSubmitEditing={connect}
      />
      {!!error && <Text style={[s.p, { color: C.red }]}>{error}</Text>}
      <Pressable style={[s.primary, busy && { opacity: 0.6 }]} onPress={connect} disabled={busy}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryText}>Connect</Text>}
      </Pressable>
      <Text style={[s.p, { marginTop: 24 }]}>
        To turn the TV on from your phone, enable: Settings › Connection › Network › Expert Settings › Power
        On with Mobile.
      </Text>
    </KeyboardAvoidingView>
  );
}

/* ---------------- Remote ---------------- */

function RemoteScreen({
  tv,
  onUpdate,
  onForget,
}: {
  tv: SavedTv;
  onUpdate: (tv: SavedTv) => void;
  onForget: () => void;
}) {
  const [status, setStatus] = useState<TvStatus>('disconnected');
  const [apps, setApps] = useState<TvApp[]>([]);
  const [text, setText] = useState('');
  const [waking, setWaking] = useState(false);
  const tvRef = useRef<SamsungTv | null>(null);
  const tvDataRef = useRef(tv);
  tvDataRef.current = tv;
  const onUpdateRef = useRef((next: SavedTv) => {
    tvDataRef.current = next; // visible to callbacks before the re-render lands
    onUpdate(next);
  });
  // Incremented to cancel an in-flight power-on loop (unmount, second tap).
  const wakeRun = useRef(0);

  useEffect(() => {
    // Keep the MAC (needed for Wake-on-LAN) and name current; setup may have missed them.
    const refreshInfo = async () => {
      const info = await fetchTvInfo(tv.ip);
      const cur = tvDataRef.current;
      if (!info || cur.ip !== tv.ip) return;
      const mac = info.mac || cur.mac;
      if (mac !== cur.mac || info.name !== cur.name) onUpdateRef.current({ ...cur, mac, name: info.name });
    };

    const remote = new SamsungTv(tv.ip, tv.token, {
      onStatus: (st) => {
        setStatus(st);
        if (st === 'connected') refreshInfo();
      },
      onApps: setApps,
      onToken: (token) => onUpdateRef.current({ ...tvDataRef.current, token }),
    });
    tvRef.current = remote;
    remote.connect();

    // A socket left open while the phone sleeps goes half-open and silently eats key presses.
    // Drop it in the background and always start fresh on return (token is saved, no prompt).
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') remote.ensureConnected();
      else if (state === 'background') {
        wakeRun.current++;
        setWaking(false);
        remote.stop();
      }
    });
    return () => {
      sub.remove();
      wakeRun.current++;
      remote.stop();
      tvRef.current = null;
    };
    // Recreate only when the TV address changes; token updates are handled inside the instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tv.ip]);

  const key = useCallback((k: string) => {
    const remote = tvRef.current;
    if (!remote) return;
    if (remote.isConnected) remote.sendKey(k);
    else remote.ensureConnected();
  }, []);

  // Samsung has no documented play/pause toggle key; alternate the two.
  const playing = useRef(true);
  const playPause = () => {
    key(playing.current ? 'KEY_PAUSE' : 'KEY_PLAY');
    playing.current = !playing.current;
  };

  const power = async () => {
    const remote = tvRef.current;
    if (!remote || waking) return;
    if (remote.isConnected) {
      remote.sendKey('KEY_POWER');
      return;
    }
    const { mac, ip } = tvDataRef.current;
    if (!mac) {
      remote.connect();
      return;
    }
    const run = ++wakeRun.current;
    const live = () => wakeRun.current === run;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    setWaking(true);
    try {
      // Poll the cheap HTTP endpoint until the TV's network is up, then open the socket once.
      // Reconnecting on a timer would abort a slow TLS handshake to a booting TV.
      for (let i = 0; i < 15 && live(); i++) {
        if (i % 3 === 0) await wakeOnLan(mac, ip).catch(() => {});
        if (!live()) return;
        if (remote.isConnected) return;
        if (await fetchTvInfo(ip, 1500)) {
          if (!live()) return;
          remote.ensureConnected();
          for (let j = 0; j < 20 && live() && remote.currentStatus === 'connecting'; j++) await sleep(500);
          return;
        }
        await sleep(1500);
      }
    } finally {
      if (live()) setWaking(false);
    }
  };

  const forget = () =>
    Alert.alert('Forget this TV?', 'You will need to enter the IP and press Allow on the TV again.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Forget', style: 'destructive', onPress: onForget },
    ]);

  const { width } = useWindowDimensions();
  // Ring + two rockers + gaps must fit the screen width (18 padding each side).
  const ring = Math.max(150, Math.min(196, width - 36 - 2 * 58 - 2 * 8));

  const sendText = () => {
    if (!text) return;
    if (tvRef.current?.sendText(text)) setText('');
    else tvRef.current?.ensureConnected();
  };

  const statusInfo = {
    connected: { color: C.green, label: 'Connected' },
    connecting: { color: C.amber, label: waking ? 'Waking TV…' : 'Connecting…' },
    'waiting-for-allow': { color: C.amber, label: 'Press Allow on your TV' },
    disconnected: { color: C.red, label: waking ? 'Waking TV…' : 'TV off or unreachable. Tap to retry' },
    denied: { color: C.red, label: 'TV blocked this phone' },
  }[status];

  return (
    <View style={s.remote}>
      {/* ---- Top: rarely used ---- */}
      <View style={s.header}>
        <Pressable style={{ flex: 1 }} onPress={() => tvRef.current?.connect()} onLongPress={forget}>
          <Text style={s.tvName} numberOfLines={1}>
            {tv.name}
          </Text>
          <View style={s.statusRow}>
            <View style={[s.dot, { backgroundColor: statusInfo.color }]} />
            <Text style={s.statusText}>{statusInfo.label}</Text>
          </View>
        </Pressable>
        <Btn label={waking ? '…' : '⏻'} onPress={power} strong color={C.red} style={s.power} big />
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 12 }} keyboardShouldPersistTaps="handled">
        {status === 'denied' && (
          <Text style={[s.p, { color: C.red }]}>
            On the TV: Settings › Connection › External Device Manager › Device Connection Manager › Device List.
            Allow this phone, then tap the TV name.
          </Text>
        )}

        <View style={s.row}>
          {SHORTCUTS.map((sc) => {
            const app = apps.find((a) => sc.match.test(a.name)) ?? (sc.id ? { appId: sc.id, appType: 2 } : null);
            return (
              <Btn
                release
                key={sc.label}
                label={sc.label}
                onPress={() => {
                  if (!app) return;
                  if (tvRef.current?.isConnected) tvRef.current.launchApp(app);
                  else tvRef.current?.ensureConnected();
                }}
                style={[s.small, { backgroundColor: sc.colour }, !app && { opacity: 0.4 }]}
              />
            );
          })}
        </View>

        <View style={s.typeRow}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Type on TV…"
            placeholderTextColor={C.dim}
            style={[s.input, { flex: 1, marginBottom: 0, paddingVertical: 10, fontSize: 15 }]}
            onSubmitEditing={sendText}
            returnKeyType="send"
          />
          {!!text && (
            <Pressable style={s.send} onPress={sendText}>
              <Text style={s.primaryText}>Send</Text>
            </Pressable>
          )}
        </View>
      </ScrollView>

      {/* ---- Bottom: thumb zone ---- */}

      <View style={s.thumb}>
        <Rocker
          size={ring}
          up={() => key('KEY_CHUP')}
          down={() => key('KEY_CHDOWN')}
          mid={() => key('KEY_CH_LIST')}
          upLabel="︿"
          downLabel="﹀"
          midLabel="CH"
        />
        <DPad onKey={key} size={ring} />
        <Rocker
          size={ring}
          up={() => key('KEY_VOLUP')}
          down={() => key('KEY_VOLDOWN')}
          mid={() => key('KEY_MUTE')}
          upLabel="+"
          downLabel="−"
          midLabel="VOL"
        />
      </View>

      <View style={s.row}>
        <Btn label="↩" onPress={() => key('KEY_RETURN')} big />
        <Btn label="⌂" onPress={() => key('KEY_HOME')} big />
        <Btn label="⏯" onPress={playPause} big />
        <Btn label="🔇" onPress={() => key('KEY_MUTE')} big />
      </View>
    </View>
  );
}

// Matched against the TV's installed app names, so IDs never need hard-coding.
// `id` is a fallback for firmware that never answers the installed-apps request.
const SHORTCUTS: { label: string; match: RegExp; colour: string; id?: string }[] = [
  { label: 'Netflix', match: /netflix/i, colour: '#B20710', id: '3201907018807' },
  { label: 'TVNZ+', match: /tvnz/i, colour: '#1E3A8A' },
  { label: 'Stremio', match: /stremio/i, colour: '#5B3FA8' },
];

/* ---------------- D-pad ---------------- */

function DPad({ onKey, size }: { onKey: (k: string) => void; size: number }) {
  const z = Math.round(size * 0.35);
  const ok = Math.round(size * 0.47);
  const zone = (k: string, label: string, pos: object) => (
    <Btn
      label={label}
      onPress={() => onKey(k)}
      repeat
      style={[s.dZone, { width: z, height: z, borderRadius: z / 2 }, pos]}
      textStyle={{ color: C.dim }}
    />
  );
  return (
    <View style={[s.ring, { width: size, height: size, borderRadius: size / 2 }]}>
      {zone('KEY_UP', '▲', { top: 0, left: size / 2 - z / 2 })}
      {zone('KEY_DOWN', '▼', { bottom: 0, left: size / 2 - z / 2 })}
      {zone('KEY_LEFT', '◀', { left: 0, top: size / 2 - z / 2 })}
      {zone('KEY_RIGHT', '▶', { right: 0, top: size / 2 - z / 2 })}
      <Btn
        label="OK"
        onPress={() => onKey('KEY_ENTER')}
        style={[s.ok, { width: ok, height: ok, borderRadius: ok / 2, top: size / 2 - ok / 2, left: size / 2 - ok / 2 }]}
      />
    </View>
  );
}

/* ---------------- Rocker ---------------- */

function Rocker(p: {
  size: number;
  up: () => void;
  down: () => void;
  mid: () => void;
  upLabel: string;
  downLabel: string;
  midLabel: string;
}) {
  return (
    <View style={[s.rocker, { height: p.size }]}>
      <Btn label={p.upLabel} onPress={p.up} repeat style={s.rockBtn} big />
      <Btn label={p.midLabel} onPress={p.mid} style={s.rockMid} textStyle={s.rockLabel} />
      <Btn label={p.downLabel} onPress={p.down} repeat style={s.rockBtn} big />
    </View>
  );
}
/* ---------------- Haptics ---------------- */

// Android's native key haptics feel crisper than the generic impact styles.
function buzz(kind: 'press' | 'tick' | 'strong') {
  if (Platform.OS === 'android') {
    const type =
      kind === 'strong'
        ? Haptics.AndroidHaptics.Long_Press
        : kind === 'tick'
          ? Haptics.AndroidHaptics.Keyboard_Tap
          : Haptics.AndroidHaptics.Virtual_Key;
    Haptics.performAndroidHapticsAsync(type).catch(() => {});
  } else {
    const style =
      kind === 'strong'
        ? Haptics.ImpactFeedbackStyle.Heavy
        : kind === 'tick'
          ? Haptics.ImpactFeedbackStyle.Light
          : Haptics.ImpactFeedbackStyle.Medium;
    Haptics.impactAsync(style).catch(() => {});
  }
}

/* ---------------- Button ---------------- */

function Btn({
  label,
  onPress,
  release,
  repeat,
  strong,
  big,
  color,
  style,
  textStyle,
}: {
  label: string;
  onPress: () => void;
  // Fire on release instead of touch-down. Used inside the ScrollView so a scroll
  // gesture that starts on a button doesn't send a key.
  release?: boolean;
  repeat?: boolean;
  strong?: boolean;
  big?: boolean;
  color?: string;
  style?: any;
  textStyle?: any;
}) {
  const delay = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interval = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = () => {
    if (delay.current) clearTimeout(delay.current);
    if (interval.current) clearInterval(interval.current);
    delay.current = interval.current = null;
  };
  useEffect(() => stop, []);

  return (
    <Pressable
      onPress={
        release
          ? () => {
              buzz(strong ? 'strong' : 'press');
              onPress();
            }
          : undefined
      }
      onPressIn={() => {
        if (release) return;
        buzz(strong ? 'strong' : 'press');
        onPress();
        if (repeat)
          delay.current = setTimeout(
            () =>
              (interval.current = setInterval(() => {
                buzz('tick');
                onPress();
              }, 120)),
            400,
          );
      }}
      onPressOut={stop}
      style={({ pressed }) => [s.btn, style, pressed && { backgroundColor: C.btnPressed }]}
    >
      <Text style={[s.btnText, big && { fontSize: 24 }, color && { color }, textStyle]}>{label}</Text>
    </Pressable>
  );
}

/* ---------------- Styles ---------------- */

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  setup: { flex: 1, padding: 24, justifyContent: 'center' },
  h1: { color: C.text, fontSize: 28, fontWeight: '700', marginBottom: 12 },
  p: { color: C.dim, fontSize: 14, lineHeight: 20, marginBottom: 12 },
  input: {
    backgroundColor: C.btn,
    color: C.text,
    fontSize: 18,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 12,
  },
  primary: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 16, alignItems: 'center' },
  primaryText: { color: '#fff', fontSize: 16, fontWeight: '600' },

  remote: { flex: 1, paddingHorizontal: 18, paddingTop: 12, paddingBottom: 16, gap: 12 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  tvName: { color: C.text, fontSize: 18, fontWeight: '700' },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  statusText: { color: C.dim, fontSize: 13 },
  power: { flex: 0, width: 48, height: 48, borderRadius: 24 },
  small: { height: 40, borderRadius: 12 },

  row: { flexDirection: 'row', gap: 10, justifyContent: 'space-between' },
  btn: {
    flex: 1,
    backgroundColor: C.btn,
    borderRadius: 14,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnText: { color: C.text, fontSize: 15, fontWeight: '600' },

  thumb: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  ring: { backgroundColor: C.btn },
  dZone: { position: 'absolute', flex: 0, backgroundColor: 'transparent' },
  ok: { position: 'absolute', flex: 0, backgroundColor: '#2A2D36' },

  rocker: { width: 58, backgroundColor: '#3A3D45', borderRadius: 18, overflow: 'hidden' },
  rockBtn: { flex: 1, backgroundColor: 'transparent', borderRadius: 0 },
  rockMid: { flex: 0, height: 34, backgroundColor: 'transparent', borderRadius: 0 },
  rockLabel: { color: C.dim, fontSize: 11, fontWeight: '700', letterSpacing: 1 },

  section: { color: C.dim, fontSize: 12, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase' },
  typeRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  send: { backgroundColor: C.accent, borderRadius: 12, paddingHorizontal: 18, paddingVertical: 16 },
});
