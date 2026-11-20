import dgram from 'react-native-udp';

// Wake-on-LAN magic packet: 6 x 0xFF then the MAC repeated 16 times.
export function wakeOnLan(mac: string, ip?: string): Promise<void> {
  const hex = mac.replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 12) return Promise.reject(new Error('Invalid MAC address'));
  const macBytes = hex.match(/../g)!.map((h) => parseInt(h, 16));
  const packet: number[] = Array(6).fill(0xff);
  for (let i = 0; i < 16; i++) packet.push(...macBytes);
  const bytes = Uint8Array.from(packet);

  // Global broadcast, subnet broadcast (assumes /24), and unicast to the TV, which still
  // works while the phone's ARP cache remembers the TV (shortly after it was turned off).
  const targets = ['255.255.255.255'];
  if (ip) targets.push(ip.replace(/\.\d+$/, '.255'), ip);

  return new Promise((resolve, reject) => {
    let finished = false;
    let socket: ReturnType<typeof dgram.createSocket> | null = null;
    const finish = (err?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {}
      err ? reject(err) : resolve();
    };
    // Native send callbacks are not guaranteed; never let the caller hang.
    const timer = setTimeout(() => finish(new Error('Wake-on-LAN timed out')), 3000);
    try {
      socket = dgram.createSocket({ type: 'udp4' });
    } catch (e) {
      finish(e as Error);
      return;
    }
    const sock = socket;
    (sock as any).on('error', (e: Error) => finish(e));
    sock.bind(0, () => {
      try {
        sock.setBroadcast(true);
      } catch (e) {
        finish(e as Error);
        return;
      }
      let pending = targets.length * 3;
      let sent = 0;
      let firstErr: Error | undefined;
      const done = (err?: Error) => {
        if (err) firstErr ??= err;
        else sent++;
        // Succeed if any packet went out; the unicast one can fail on its own.
        if (--pending === 0) finish(sent ? undefined : firstErr);
      };
      for (let r = 0; r < 3; r++) {
        for (const t of targets) sock.send(bytes, 0, bytes.length, 9, t, done);
      }
    });
  });
}
