import * as Application from 'expo-application';

// Each GitHub release is tagged build-N, where N is also the APK's versionCode.
const LATEST = 'https://api.github.com/repos/mark-nefarious/tv-remote/releases/latest';

export type Update = { build: number; url: string };

export async function checkForUpdate(): Promise<Update | null> {
  const current = Number(Application.nativeBuildVersion);
  if (!current) return null;
  try {
    const res = await fetch(LATEST, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) return null;
    const json = await res.json();
    const build = Number(String(json.tag_name ?? '').replace(/^build-/, ''));
    const apk = (json.assets ?? []).find((a: any) => String(a.name).endsWith('.apk'));
    if (!build || !apk || build <= current) return null;
    return { build, url: apk.browser_download_url };
  } catch {
    return null;
  }
}
