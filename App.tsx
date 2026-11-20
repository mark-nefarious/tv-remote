import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
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

  useEffect(() => {
    const remote = new SamsungTv(tv.ip, tv.token, {
      onStatus: setStatus,
      onApps: setApps,
      onToken: (token) => onUpdate({ ...tvDataRef.current, token }),
    });
    tvRef.current = remote;
    remote.connect();

    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && !remote.isConnected) remote.connect();
    });
    return () => {
      sub.remove();
      remote.close();
    };
    // Recreate only when the TV address changes; token updates are handled inside the instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tv.ip]);

  const key = useCallback((k: string) => tvRef.current?.sendKey(k), []);

  const power = async () => {
    const remote = tvRef.current;
    if (!remote) return;
    if (remote.isConnected) {
      remote.sendKey('KEY_POWER');
      return;
    }
    if (!tv.mac) {
      remote.connect();
      return;
    }
    setWaking(true);
    try {
      await wakeOnLan(tv.mac, tv.ip);
    } catch {}
    // TV takes a few seconds to boot its network stack.
    for (let i = 0; i < 10 && !remote.isConnected; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      if (!remote.isConnected) remote.connect();
    }
    setWaking(false);
  };

  const sendText = () => {
    if (!text) return;
    tvRef.current?.sendText(text);
    setText('');
  };

  const statusInfo = {
    connected: { color: C.green, label: 'Connected' },
    connecting: { color: C.amber, label: 'Connecting…' },
    'waiting-for-allow': { color: C.amber, label: 'Press Allow on your TV' },
    disconnected: { color: C.red, label: waking ? 'Waking TV…' : 'TV off or unreachable' },
    denied: { color: C.red, label: 'TV blocked this phone' },
  }[status];

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={s.remote} keyboardShouldPersistTaps="handled">
        {/* Header */}
        <View style={s.header}>
          <View style={{ flex: 1 }}>
            <Text style={s.tvName} numberOfLines={1}>
              {tv.name}
            </Text>
            <Pressable onPress={() => tvRef.current?.connect()} style={s.statusRow}>
              <View style={[s.dot, { backgroundColor: statusInfo.color }]} />
              <Text style={s.statusText}>{statusInfo.label}</Text>
            </Pressable>
          </View>
          <Pressable onLongPress={onForget} hitSlop={10}>
            <Text style={s.forget}>Hold to change TV</Text>
          </Pressable>
        </View>

        {status === 'denied' && (
          <Text style={[s.p, { color: C.red }]}>
            On the TV: Settings › Connection › External Device Manager › Device Connection Manager › Device
            List. Allow this phone, then tap the status above.
          </Text>
        )}

        {/* Top row */}
        <View style={s.row}>
          <Btn label={waking ? '…' : '⏻'} onPress={power} color={C.red} big />
          <Btn label="Source" onPress={() => key('KEY_SOURCE')} />
          <Btn label="Mute" onPress={() => key('KEY_MUTE')} />
        </View>

        {/* D-pad */}
        <View style={s.dpad}>
          <Btn label="▲" onPress={() => key('KEY_UP')} repeat style={[s.dBtn, s.dUp]} />
          <View style={s.dMid}>
            <Btn label="◀" onPress={() => key('KEY_LEFT')} repeat style={s.dBtn} />
            <Btn label="OK" onPress={() => key('KEY_ENTER')} style={s.ok} />
            <Btn label="▶" onPress={() => key('KEY_RIGHT')} repeat style={s.dBtn} />
          </View>
          <Btn label="▼" onPress={() => key('KEY_DOWN')} repeat style={[s.dBtn, s.dUp]} />
        </View>

        <View style={s.row}>
          <Btn label="Back" onPress={() => key('KEY_RETURN')} />
          <Btn label="Home" onPress={() => key('KEY_HOME')} />
          <Btn label="⏯" onPress={() => key('KEY_PLAY_BACK')} />
        </View>

        {/* Volume / channel rockers */}
        <View style={s.row}>
          <View style={s.rocker}>
            <Btn label="+" onPress={() => key('KEY_VOLUP')} repeat style={s.rockBtn} />
            <Text style={s.rockLabel}>VOL</Text>
            <Btn label="−" onPress={() => key('KEY_VOLDOWN')} repeat style={s.rockBtn} />
          </View>
          <View style={s.rocker}>
            <Btn label="⏪" onPress={() => key('KEY_REWIND')} style={s.rockBtn} />
            <Btn label="⏩" onPress={() => key('KEY_FF')} style={s.rockBtn} />
          </View>
          <View style={s.rocker}>
            <Btn label="︿" onPress={() => key('KEY_CHUP')} repeat style={s.rockBtn} />
            <Text style={s.rockLabel}>CH</Text>
            <Btn label="﹀" onPress={() => key('KEY_CHDOWN')} repeat style={s.rockBtn} />
          </View>
        </View>

        {/* Apps */}
        {apps.length > 0 && (
          <>
            <Text style={s.section}>Apps</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
              {apps.map((a) => (
                <Pressable
                  key={a.appId}
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    tvRef.current?.launchApp(a);
                  }}
                  style={({ pressed }) => [s.chip, pressed && { backgroundColor: C.btnPressed }]}
                >
                  <Text style={s.chipText}>{a.name}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </>
        )}

        {/* Keyboard */}
        <Text style={s.section}>Type on TV</Text>
        <View style={s.typeRow}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Open a search box on the TV first"
            placeholderTextColor={C.dim}
            style={[s.input, { flex: 1, marginBottom: 0 }]}
            onSubmitEditing={sendText}
            returnKeyType="send"
          />
          <Pressable style={s.send} onPress={sendText}>
            <Text style={s.primaryText}>Send</Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/* ---------------- Button ---------------- */

function Btn({
  label,
  onPress,
  repeat,
  big,
  color,
  style,
}: {
  label: string;
  onPress: () => void;
  repeat?: boolean;
  big?: boolean;
  color?: string;
  style?: any;
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
      onPressIn={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
        if (repeat) delay.current = setTimeout(() => (interval.current = setInterval(onPress, 120)), 400);
      }}
      onPressOut={stop}
      style={({ pressed }) => [s.btn, style, pressed && { backgroundColor: C.btnPressed }]}
    >
      <Text style={[s.btnText, big && { fontSize: 24 }, color && { color }]}>{label}</Text>
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

  remote: { padding: 20, gap: 18 },
  header: { flexDirection: 'row', alignItems: 'center' },
  tvName: { color: C.text, fontSize: 20, fontWeight: '700' },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  statusText: { color: C.dim, fontSize: 13 },
  forget: { color: C.dim, fontSize: 12 },

  row: { flexDirection: 'row', gap: 12, justifyContent: 'space-between' },
  btn: {
    flex: 1,
    backgroundColor: C.btn,
    borderRadius: 14,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnText: { color: C.text, fontSize: 16, fontWeight: '600' },

  dpad: { alignItems: 'center', gap: 8 },
  dMid: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  dBtn: { flex: 0, width: 76, height: 76, borderRadius: 38 },
  dUp: { width: 76 },
  ok: { flex: 0, width: 96, height: 96, borderRadius: 48, backgroundColor: '#262A33' },

  rocker: { flex: 1, backgroundColor: C.btn, borderRadius: 18, alignItems: 'center', paddingVertical: 4 },
  rockBtn: { flex: 0, width: '100%', backgroundColor: 'transparent', height: 52 },
  rockLabel: { color: C.dim, fontSize: 11, fontWeight: '700', letterSpacing: 1 },

  section: { color: C.dim, fontSize: 12, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase' },
  chip: { backgroundColor: C.btn, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10 },
  chipText: { color: C.text, fontSize: 14 },
  typeRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  send: { backgroundColor: C.accent, borderRadius: 12, paddingHorizontal: 18, paddingVertical: 16 },
});
