# TV Remote (Samsung, Android)

A phone remote for Samsung Tizen TVs (2016 and newer), controlled over your home Wi-Fi.

## Branches

- **main**: the working remote. Every push builds and publishes a release; both phones get the "Update available" banner.
- **dev**: work in progress. Every push builds a pre-release called `dev-N` for testing. It never triggers the banner. Merge dev into main when a change is tested.

## Build the APK (from your phone)

Every push to `main` builds the APK on GitHub Actions (about 10 minutes) and publishes it as a Release.

1. Open the repo on GitHub, go to Releases, and pick the latest one.
2. Download `tv-remote.apk` and install it. Android will ask you to allow installs from your browser.

To rebuild without changing code: Actions › Build APK › Run workflow.

Pull requests also build. Open the PR's workflow run and download the APK from **Artifacts** to test before merging. Each build's versionCode is the workflow run number, so new builds install over old ones.

## First use

1. On the TV, enable **Power On with Mobile**: Settings › General › Network › Expert Settings on 2020 models (Settings › Connection › Network › Expert Settings on newer ones).
2. Find the TV's IP in Settings › General › Network › Network Status › IP Settings (2020) or Settings › Connection › Network on newer models.
3. Open the app, enter the IP and tap Connect.
4. Press **Allow** on the TV. The app saves the token, so you only do this once.

Tip: reserve the TV's IP in your router (DHCP reservation) so it never changes.

## How it works

- `src/samsung.ts`: the WebSocket connection to the TV on port 8002. It sends key codes and text.
- `src/wol.ts`: Wake-on-LAN packet to turn the TV on.
- `plugins/withSamsungTls.js`: lets Android accept the TV's self-signed certificate, only for SmartViewSDK certificates on private LAN IPs.
- `App.tsx`: the setup and remote screens.

## Troubleshooting

- **"TV blocked this phone"**: go to Settings › General › External Device Manager › Device Connection Manager › Device List and allow it.
- **Power on does nothing**: check Power On with Mobile is enabled. Some models only wake over Wi-Fi within a few hours of being turned off.
- **Typing does nothing**: select a text box on the TV first so its on-screen keyboard opens. The app's text field turns green when the TV reports its keyboard is open. Apps with their own keyboard (YouTube, Netflix) don't accept typed text.
