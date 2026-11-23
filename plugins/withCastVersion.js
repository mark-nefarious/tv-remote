// Pin Google's Cast framework. The library defaults to the newest ('+'), and
// play-services-cast-framework 23.x is compiled with Kotlin 2.4, newer than this
// project's Kotlin 2.2, which fails the build.
//
// The root build.gradle applies React Native's root-project plugin, which evaluates
// subprojects early, so an `ext` value appended at the end arrives too late. Force the
// version in the app's dependency resolution instead, and also set ext at the top.
const { withAppBuildGradle, withProjectBuildGradle } = require('expo/config-plugins');

const VERSION = '22.1.0';
const ARTIFACT = 'com.google.android.gms:play-services-cast-framework';

module.exports = function withCastVersion(config) {
  config = withProjectBuildGradle(config, (cfg) => {
    if (!cfg.modResults.contents.includes('castFrameworkVersion')) {
      cfg.modResults.contents = `ext.castFrameworkVersion = "${VERSION}"\n` + cfg.modResults.contents;
    }
    return cfg;
  });
  config = withAppBuildGradle(config, (cfg) => {
    if (!cfg.modResults.contents.includes(ARTIFACT)) {
      cfg.modResults.contents += `
configurations.all {
    resolutionStrategy.force "${ARTIFACT}:${VERSION}"
}
`;
    }
    return cfg;
  });
  return config;
};
