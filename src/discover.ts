import { fetchTvInfo } from './samsung';

const norm = (mac: string) => mac.replace(/[^0-9a-f]/gi, '').toLowerCase();

/** Find the TV on the /24 around `nearIp` by its MAC address. Returns its IP, or null. */
export async function findTvByMac(nearIp: string, mac: string): Promise<string | null> {
  const want = norm(mac);
  if (!want) return null;
  const prefix = nearIp.replace(/\.\d+$/, '.');
  const hosts = Array.from({ length: 254 }, (_, i) => prefix + (i + 1)).filter((h) => h !== nearIp);
  for (let i = 0; i < hosts.length; i += 32) {
    const batch = hosts.slice(i, i + 32);
    const infos = await Promise.all(batch.map((h) => fetchTvInfo(h, 1200)));
    const hit = infos.findIndex((info) => info && norm(info.mac) === want);
    if (hit >= 0) return batch[hit];
  }
  return null;
}
