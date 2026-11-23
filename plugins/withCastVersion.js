// Pin Google's Cast framework. The library defaults to the newest ('+'), and
// play-services-cast-framework 23.x is compiled with Kotlin 2.4, newer than this
// project's Kotlin 2.2, which fails the build.
const { withProjectBuildGradle } = require('expo/config-plugins');

const VERSION = '22.1.0';

module.exports = function withCastVersion(config) {
  return withProjectBuildGradle(config, (cfg) => {
    if (!cfg.modResults.contents.includes('castFrameworkVersion')) {
      cfg.modResults.contents += `\next.castFrameworkVersion = "${VERSION}"\n`;
    }
    return cfg;
  });
};
