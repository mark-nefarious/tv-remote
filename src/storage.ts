import AsyncStorage from '@react-native-async-storage/async-storage';

// `customName` is the user's own label; `name` is what the TV reports.
export type SavedTv = { ip: string; mac: string; name: string; customName?: string; token: string | null };

const KEY = 'tv-remote:tv';

export async function loadTv(): Promise<SavedTv | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as SavedTv) : null;
  } catch {
    return null;
  }
}

export async function saveTv(tv: SavedTv) {
  await AsyncStorage.setItem(KEY, JSON.stringify(tv));
}

export async function clearTv() {
  await AsyncStorage.removeItem(KEY);
}
