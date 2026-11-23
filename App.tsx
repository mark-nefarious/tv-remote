import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Alert,
  AppState,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  Vibration,
  View,
  useWindowDimensions,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { SamsungTv, TvStatus, fetchTvInfo } from './src/samsung';
import { SavedTv, clearTv, loadTv, saveTv } from './src/storage';
import { wakeOnLan } from './src/wol';
import { Update, checkForUpdate } from './src/update';
import { CastTarget, discoverCastDevices, startCastSession } from './src/cast';
import { findTvByMac } from './src/discover';

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
        To turn the TV on from your phone, enable: Settings › General › Network › Expert Settings › Power On
        with Mobile (on newer TVs: Settings › Connection › Network › Expert Settings).
      </Text>
    </KeyboardAvoidingView>
  );
}

/* ---------------- Remote ---------------- */

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

// Keep the socket through short trips out of the app (notification shade, a quick
// app switch). Reconnecting means a full TLS handshake to a slow TV.
const BACKGROUND_GRACE_MS = 30000;

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
  const [diag, setDiag] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [update, setUpdate] = useState<Update | null>(null);
  const [waking, setWaking] = useState(false);
  const [wakeMsg, setWakeMsg] = useState('');
  const tvRef = useRef<SamsungTv | null>(null);
  const tvDataRef = useRef(tv);
  tvDataRef.current = tv;
  const onUpdateRef = useRef((next: SavedTv) => {
    tvDataRef.current = next; // visible to callbacks before the re-render lands
    onUpdate(next);
  });
  // Incremented to cancel an in-flight power-on loop (unmount, second tap).
  const wakeRun = useRef(0);
  const [castPicker, setCastPicker] = useState<CastTarget[] | null>(null);
  const [castMsg, setCastMsg] = useState('');
  const tvScanDone = useRef(false);

  // Pick this TV's Chromecast: the saved one (by name), else the only one on the Wi-Fi.
  const resolveCast = async (
    interactive: boolean,
    say: (m: string) => void,
  ): Promise<CastTarget | 'picker' | 'multiple' | null> => {
    say('Looking for the Chromecast…');
    const found = await discoverCastDevices();
    const saved = tvDataRef.current.castName;
    const pick = (saved && found.find((d) => d.name === saved)) || (found.length === 1 ? found[0] : undefined);
    if (pick) {
      if (pick.name !== saved) onUpdateRef.current({ ...tvDataRef.current, castName: pick.name });
      return pick;
    }
    if (found.length > 1) {
      if (!interactive) return 'multiple';
      setCastPicker(found);
      return 'picker';
    }
    return null;
  };

  const castTo = async (target: CastTarget, say: (m: string) => void): Promise<string> => {
    say(`Starting cast on ${target.name}…`);
    try {
      await startCastSession(target.deviceId);
      return 'ok';
    } catch (e: any) {
      return String(e?.message ?? e);
    }
  };

  // Wake/switch via the Chromecast, using Google's Cast SDK.
  const castWake = async (
    interactive: boolean,
    say: (m: string) => void,
    live: () => boolean = () => true,
  ): Promise<string> => {
    const target = await resolveCast(interactive, say);
    if (!live()) return 'cancelled';
    if (target === 'picker' || target === 'multiple') return target;
    if (!target) return 'none';
    return castTo(target, say);
  };

  const reportCast = (r: string) => {
    if (r === 'ok') {
      setCastMsg('Chromecast accepted. TV switching to HDMI 1…');
      setTimeout(() => setCastMsg((m) => (m.startsWith('Chromecast accepted') ? '' : m)), 5000);
    } else if (r === 'none') setCastMsg("Couldn't find a Chromecast on your Wi-Fi.");
    else if (r !== 'picker') setCastMsg(`Chromecast didn't respond (${r}).`);
  };

  const chromecastButton = async () => reportCast(await castWake(true, setCastMsg));

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
      onDiag: setDiag,
      onToken: (token) => onUpdateRef.current({ ...tvDataRef.current, token }),
    });
    tvRef.current = remote;
    remote.connect();

    let bgTimer: ReturnType<typeof setTimeout> | null = null;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        if (bgTimer) clearTimeout(bgTimer);
        bgTimer = null;
        // Connected: verify it's really alive (the phone may have slept). Anything else
        // (including an attempt stuck mid-handshake): start fresh now.
        if (remote.isConnected) remote.ping();
        else if (remote.currentStatus !== 'waiting-for-allow' && remote.currentStatus !== 'denied') remote.connect();
      } else if (state === 'background' && !bgTimer) {
        bgTimer = setTimeout(() => {
          bgTimer = null;
          wakeRun.current++;
          setWaking(false);
          remote.stop();
        }, BACKGROUND_GRACE_MS);
      }
    });
    return () => {
      sub.remove();
      if (bgTimer) clearTimeout(bgTimer);
      wakeRun.current++;
      remote.stop();
      tvRef.current = null;
    };
    // Recreate only when the TV address changes; token updates are handled inside the instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tv.ip]);

  // Fires on press-in. Never queued: if the socket isn't up the press is dropped,
  // the phone double-buzzes, and a reconnect starts.
  const key = useCallback((k: string) => {
    const remote = tvRef.current;
    if (remote?.sendKey(k)) return true;
    remote?.ensureConnected();
    return false;
  }, []);

  // Samsung has no documented play/pause toggle key; alternate the two.
  const playing = useRef(true);
  const playPause = () => {
    const sent = key(playing.current ? 'KEY_PAUSE' : 'KEY_PLAY');
    if (sent) playing.current = !playing.current;
    return sent;
  };

  const power = async () => {
    const remote = tvRef.current;
    if (!remote) return false;
    if (remote.isConnected) {
      setWakeMsg('');
      return remote.sendKey('KEY_POWER');
    }
    if (waking) return true;
    const { mac, ip } = tvDataRef.current;
    if (!mac) {
      setWakeMsg("Can't wake: the TV's network address isn't saved. Turn the TV on, open the app once, then try again.");
      remote.connect();
      return false;
    }
    const run = ++wakeRun.current;
    const live = () => wakeRun.current === run;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const started = Date.now();
    const secs = () => Math.round((Date.now() - started) / 1000);
    setWaking(true);
    setCastMsg('');
    setWakeMsg(`Sending wake signal to ${mac}…`);

    // Main wake path: ask the Chromecast to wake the TV over HDMI-CEC. Works from deep standby.
    const cast = { state: 'pending' as 'pending' | 'ok' | 'none' | 'failed', step: 'Looking for the Chromecast…', err: '' };
    (async () => {
      const r = await castWake(false, (m) => (cast.step = m), live).catch((e) => String(e?.message ?? e));
      if (!live()) return;
      if (r === 'ok') cast.state = 'ok';
      else if (r === 'none' || r === 'picker' || r === 'multiple') cast.state = 'none';
      else {
        cast.err = r;
        cast.state = 'failed';
      }
    })();
    let rescanned = false;

    // Wake-on-LAN burst: every 700 ms for the first 10 s, then every 2 s.
    let wolOk = false;
    let wolErr = '';
    (async () => {
      while (live() && !remote.isConnected && Date.now() - started < 40000) {
        await wakeOnLan(mac, ip).then(
          () => (wolOk = true),
          (e) => (wolErr = String(e?.message ?? e)),
        );
        await sleep(Date.now() - started < 10000 ? 700 : 2000);
      }
    })();

    try {
      // Poll the TV's HTTP endpoint fast; connect the moment it answers.
      let answered = false;
      while (live() && !remote.isConnected && Date.now() - started < 40000) {
        if (!answered) {
          setWakeMsg(
            cast.state === 'ok'
              ? `Chromecast accepted. TV waking… ${secs()}s`
              : cast.state === 'pending'
              ? `${cast.step} ${secs()}s`
              : wolOk
              ? `Wake signal sent to ${mac}. Waiting for TV… ${secs()}s`
              : wolErr
                ? `Wake signal failed: ${wolErr}`
                : `Sending wake signal to ${mac}…`,
          );
          // TV should be up by now; if it isn't answering, its address may have changed.
          if (!rescanned && cast.state === 'ok' && Date.now() - started > 15000) {
            rescanned = true;
            setWakeMsg('TV not answering at its usual address. Searching the network…');
            const newIp = await findTvByMac(ip, mac);
            if (!live()) return true;
            if (newIp) {
              setWakeMsg(`Found the TV at ${newIp}. Connecting…`);
              onUpdateRef.current({ ...tvDataRef.current, ip: newIp }); // reconnects at the new address
              return true;
            }
          }
          const t0 = Date.now();
          const info = await fetchTvInfo(ip, 900);
          if (!live()) return true;
          if (info) {
            answered = true;
            setWakeMsg(`TV is up. Connecting… ${secs()}s`);
            // Force a fresh attempt: any earlier one was aimed at a TV that was off.
            remote.connect();
          } else await sleep(Math.max(0, 400 - (Date.now() - t0)));
        } else {
          // TV answered; keep the socket attempt going until it lands.
          remote.ensureConnected();
          await sleep(250);
        }
      }
      if (!live()) return true;
      if (remote.isConnected) {
        setWakeMsg('');
        // Network standby answers but leaves the screen off; KEY_POWER turns it on.
        const info = await fetchTvInfo(ip, 1500);
        if (live() && info?.powerState === 'standby') remote.sendKey('KEY_POWER');
      } else if (!answered) {
        setWakeMsg(
          cast.state === 'none'
            ? "TV didn't respond, and no Chromecast was found to wake it. Tap Chromecast once to set it up."
            : cast.state === 'failed'
              ? `TV didn't respond. Chromecast error: ${cast.err}`
              : `Sent to ${mac} but the TV didn't respond.`,
        );
      } else {
        setWakeMsg("The TV answered but the remote connection didn't open. Tap the TV name to retry.");
      }
    } finally {
      if (live()) setWaking(false);
    }
    return true;
  };

  const forget = () =>
    Alert.alert('Forget this TV?', 'You will need to enter the IP and press Allow on the TV again.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Forget', style: 'destructive', onPress: onForget },
    ]);

  const { width } = useWindowDimensions();
  // Ring + two rockers + gaps must fit the screen width (18 padding each side).
  // Keep at least 20px of breathing room between each rocker and the wheel.
  const ring = Math.max(140, Math.min(184, width - 36 - 2 * 54 - 2 * 20));

  useEffect(() => {
    checkForUpdate().then(setUpdate);
  }, []);

  const displayName = tv.customName || tv.name;
  const startRename = () => {
    setNameDraft(displayName);
    setEditingName(true);
  };
  const saveName = () => {
    setEditingName(false);
    const n = nameDraft.trim();
    if (n && n !== displayName) onUpdate({ ...tvDataRef.current, customName: n });
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
        <Pressable
          style={{ flex: 1 }}
          onPress={() => (tvRef.current?.isConnected ? tvRef.current.ping() : tvRef.current?.connect())}
          onLongPress={forget}
        >
          {editingName ? (
            <TextInput
              value={nameDraft}
              onChangeText={setNameDraft}
              onSubmitEditing={saveName}
              onBlur={saveName}
              autoFocus
              selectTextOnFocus
              returnKeyType="done"
              style={[s.tvName, s.nameInput]}
            />
          ) : (
            <View style={s.nameRow}>
              <Text style={[s.tvName, { flexShrink: 1 }]} numberOfLines={1}>
                {displayName}
              </Text>
              <Pressable onPress={startRename} hitSlop={12}>
                <MaterialCommunityIcons name="pencil-outline" size={18} color={C.dim} />
              </Pressable>
            </View>
          )}
          <View style={s.statusRow}>
            <View style={[s.dot, { backgroundColor: statusInfo.color }]} />
            <Text style={s.statusText}>{statusInfo.label}</Text>
          </View>
          {!!diag && status !== 'connected' && (
            <Text style={s.diagText} numberOfLines={2}>
              {diag}
            </Text>
          )}
        </Pressable>
        {waking ? (
          <View style={[s.btn, s.power]}>
            <ActivityIndicator color={C.red} />
          </View>
        ) : (
          <Btn icon="power" onPress={power} strong color={C.red} style={s.power} />
        )}
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 12 }} keyboardShouldPersistTaps="handled">
        {update && (
          <Pressable style={s.update} onPress={() => Linking.openURL(update.url)}>
            <MaterialCommunityIcons name="download" size={20} color="#fff" />
            <Text style={s.updateText}>Update available. Tap to download, then open it to install.</Text>
          </Pressable>
        )}

        <Pressable
          onPress={() => {
            buzz('press');
            chromecastButton();
          }}
          style={({ pressed }) => [s.btn, s.castBtn, pressed && { backgroundColor: C.btnPressed }]}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <MaterialCommunityIcons name="cast" size={22} color={C.text} />
            <Text style={s.btnText}>Chromecast</Text>
          </View>
        </Pressable>
        {!!castMsg && <Text style={[s.p, { color: C.amber }]}>{castMsg}</Text>}

        {!!wakeMsg && status !== 'connected' && <Text style={[s.p, { color: C.amber }]}>{wakeMsg}</Text>}

        {status === 'denied' && (
          <Text style={[s.p, { color: C.red }]}>
            On the TV: Settings › General › External Device Manager › Device Connection Manager › Device List.
            Allow this phone, then tap the TV name.
          </Text>
        )}

      </ScrollView>

      <Modal visible={!!castPicker} transparent animationType="fade" onRequestClose={() => setCastPicker(null)}>
        <View style={s.modalBg}>
          <View style={s.modal}>
            <Text style={s.tvName}>Which Chromecast is on this TV?</Text>
            {castPicker?.map((d) => (
              <Pressable
                key={d.deviceId}
                style={s.pickRow}
                onPress={() => {
                  setCastPicker(null);
                  onUpdateRef.current({ ...tvDataRef.current, castName: d.name });
                  castTo(d, setCastMsg).then(reportCast);
                }}
              >
                <Text style={s.btnText}>{d.name}</Text>
              </Pressable>
            ))}
            <Pressable onPress={() => setCastPicker(null)} style={{ alignSelf: 'flex-end', padding: 8 }}>
              <Text style={s.statusText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* ---- Bottom: thumb zone ---- */}

      <View style={s.thumb}>
        <Rocker
          size={ring}
          up={() => key('KEY_CHUP')}
          down={() => key('KEY_CHDOWN')}
          mid={() => key('KEY_CH_LIST')}
          upIcon="chevron-up"
          downIcon="chevron-down"
          midLabel="CH"
        />
        <DPad onKey={key} size={ring} />
        <Rocker
          size={ring}
          up={() => key('KEY_VOLUP')}
          down={() => key('KEY_VOLDOWN')}
          mid={() => key('KEY_MUTE')}
          upIcon="plus"
          downIcon="minus"
          midLabel="VOL"
        />
      </View>

      <View style={s.row}>
        <Btn icon="arrow-u-left-top" onPress={() => key('KEY_RETURN')} />
        <Btn icon="home-outline" onPress={() => key('KEY_HOME')} />
        <Btn icon="play-pause" onPress={playPause} />
        <Btn icon="volume-off" onPress={() => key('KEY_MUTE')} />
      </View>
    </View>
  );
}

/* ---------------- D-pad ---------------- */

function DPad({ onKey, size }: { onKey: (k: string) => boolean; size: number }) {
  const z = Math.round(size * 0.35);
  const ok = Math.round(size * 0.47);
  const zone = (k: string, icon: IconName, pos: object) => (
    <Btn
      icon={icon}
      onPress={() => onKey(k)}
      repeat
      color={C.dim}
      style={[s.dZone, { width: z, height: z, borderRadius: z / 2 }, pos]}
    />
  );
  return (
    <View style={[s.ring, { width: size, height: size, borderRadius: size / 2 }]}>
      {zone('KEY_UP', 'chevron-up', { top: 0, left: size / 2 - z / 2 })}
      {zone('KEY_DOWN', 'chevron-down', { bottom: 0, left: size / 2 - z / 2 })}
      {zone('KEY_LEFT', 'chevron-left', { left: 0, top: size / 2 - z / 2 })}
      {zone('KEY_RIGHT', 'chevron-right', { right: 0, top: size / 2 - z / 2 })}
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
  up: () => boolean;
  down: () => boolean;
  mid: () => boolean;
  upIcon: IconName;
  downIcon: IconName;
  midLabel: string;
}) {
  return (
    <View style={[s.rocker, { height: p.size }]}>
      <Btn icon={p.upIcon} onPress={p.up} repeat style={s.rockBtn} />
      <Btn label={p.midLabel} onPress={p.mid} style={s.rockMid} textStyle={s.rockLabel} />
      <Btn icon={p.downIcon} onPress={p.down} repeat style={s.rockBtn} />
    </View>
  );
}

/* ---------------- Haptics ---------------- */

// Drives the Vibrator directly (one-shot at default amplitude). Samsung ignores
// View.performHapticFeedback when its touch-feedback setting is off or low, and
// expo-haptics' impact waveforms run at 12-27% amplitude, which is barely felt.
function buzz(kind: 'press' | 'tick' | 'strong' | 'missed') {
  if (kind === 'missed') Vibration.vibrate([0, 15, 70, 15]);
  else Vibration.vibrate(kind === 'strong' ? 40 : kind === 'tick' ? 12 : 20);
}

/* ---------------- Button ---------------- */

function Btn({
  label,
  icon,
  onPress,
  repeat,
  strong,
  color,
  style,
  textStyle,
}: {
  label?: string;
  icon?: IconName;
  // Returns false if the key couldn't be sent, for a "missed" buzz.
  onPress: () => boolean | void | Promise<boolean | void>;
  repeat?: boolean;
  strong?: boolean;
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

  const fire = (kind: 'press' | 'tick' | 'strong') => {
    const r = onPress(); // send first, then buzz
    buzz(r === false ? 'missed' : kind);
  };

  return (
    <Pressable
      onPressIn={() => {
        fire(strong ? 'strong' : 'press');
        if (repeat) delay.current = setTimeout(() => (interval.current = setInterval(() => fire('tick'), 120)), 400);
      }}
      onPressOut={stop}
      style={({ pressed }) => [s.btn, style, pressed && { backgroundColor: C.btnPressed }]}
    >
      {icon && label ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <MaterialCommunityIcons name={icon} size={22} color={color ?? C.text} />
          <Text style={[s.btnText, color && { color }, textStyle]}>{label}</Text>
        </View>
      ) : icon ? (
        <MaterialCommunityIcons name={icon} size={26} color={color ?? C.text} />
      ) : (
        <Text style={[s.btnText, color && { color }, textStyle]}>{label}</Text>
      )}
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

  remote: { flex: 1, paddingHorizontal: 18, paddingTop: 12, paddingBottom: 32, gap: 12 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  tvName: { color: C.text, fontSize: 18, fontWeight: '700' },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  statusText: { color: C.dim, fontSize: 13 },
  diagText: { color: C.dim, fontSize: 11, marginTop: 2 },
  power: { flex: 0, width: 48, height: 48, borderRadius: 24 },
  castBtn: { flex: 0, height: 48, borderRadius: 12 },
  modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 24 },
  modal: { backgroundColor: C.bg, borderRadius: 16, padding: 20, gap: 10 },
  pickRow: { backgroundColor: C.btn, borderRadius: 12, padding: 14, gap: 2 },

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

  // marginBottom lifts the block clear of the bottom row (on top of the 12px gap).
  thumb: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 20, marginBottom: 20 },
  ring: { backgroundColor: C.btn },
  dZone: { position: 'absolute', flex: 0, backgroundColor: 'transparent' },
  ok: { position: 'absolute', flex: 0, backgroundColor: '#2A2D36' },

  rocker: { width: 54, backgroundColor: '#3A3D45', borderRadius: 18, overflow: 'hidden' },
  rockBtn: { flex: 1, backgroundColor: 'transparent', borderRadius: 0 },
  rockMid: { flex: 0, height: 34, backgroundColor: 'transparent', borderRadius: 0 },
  rockLabel: { color: C.dim, fontSize: 11, fontWeight: '700', letterSpacing: 1 },

  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  nameInput: { borderBottomWidth: 1, borderBottomColor: C.accent, paddingVertical: 2 },
  update: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.accent, borderRadius: 12, padding: 14 },
  updateText: { color: '#fff', fontSize: 14, fontWeight: '600', flex: 1 },
});
