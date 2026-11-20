# TV Remote (Samsung, Android)

A phone remote for Samsung Tizen TVs (2016 and newer), controlled over your home Wi-Fi.

## Build the APK (from your phone)

Every push to `main` builds the APK on GitHub Actions (about 10 minutes) and publishes it as a Release.

1. Open the repo on GitHub, go to Releases, and pick the latest one.
2. Download `tv-remote.apk` and install it. Android will ask you to allow installs from your browser.

To rebuild without changing code: Actions › Build APK › Run workflow.

## First use

1. On the TV, enable Settings › Connection › Network › Expert Settings › **Power On with Mobile**.
2. Find the TV's IP in Settings › Connection › Network › Network Status › IP Settings.
3. Open the app, enter the IP and tap Connect.
4. Press **Allow** on the TV. The app saves the token, so you only do this once.

Tip: reserve the TV's IP in your router (DHCP reservation) so it never changes.

## How it works

- `src/samsung.ts`: the WebSocket connection to the TV on port 8002. It sends key codes, text and app launches.
- `src/wol.ts`: Wake-on-LAN packet to turn the TV on.
- `plugins/withSamsungTls.js`: lets Android accept the TV's self-signed certificate, only for SmartViewSDK certificates on private LAN IPs.
- `App.tsx`: the setup and remote screens.

## Troubleshooting

- **"TV blocked this phone"**: go to Settings › Connection › External Device Manager › Device Connection Manager › Device List and allow it.
- **Power on does nothing**: check Power On with Mobile is enabled. Some models only wake over Wi-Fi within a few hours of being turned off.
- **Typing does nothing**: a text field must be open on the TV first.
