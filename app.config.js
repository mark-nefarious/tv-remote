// Extends app.json. CI sets VERSION_CODE (the workflow run number) so every build
// installs as a newer version. Local builds fall back to 1.
module.exports = ({ config }) => ({
  ...config,
  android: {
    ...config.android,
    versionCode: Number(process.env.VERSION_CODE) || 1,
  },
});
