import dgram from 'react-native-udp';

// Wake-on-LAN magic packet: 6 x 0xFF then the MAC repeated 16 times.
export function wakeOnLan(mac: string, ip?: string): Promise<void> {
  const hex = mac.replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 12) return Promise.reject(new Error('Invalid MAC address'));
  const macBytes = hex.match(/../g)!.map((h) => parseInt(h, 16));
  const packet: number[] = Array(6).fill(0xff);
  for (let i = 0; i < 16; i++) packet.push(...macBytes);
  const bytes = Uint8Array.from(packet);

  // Send to global broadcast and the subnet broadcast (assumes /24).
  const targets = ['255.255.255.255'];
  if (ip) targets.push(ip.replace(/\.\d+$/, '.255'));

  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: 'udp4' });
    (socket as any).on('error', (e: Error) => {
      socket.close();
      reject(e);
    });
    socket.bind(0, () => {
      socket.setBroadcast(true);
      let pending = targets.length * 3;
      const done = () => {
        if (--pending === 0) {
          socket.close();
          resolve();
        }
      };
      for (let r = 0; r < 3; r++) {
        for (const t of targets) socket.send(bytes, 0, bytes.length, 9, t, done);
      }
    });
  });
}
