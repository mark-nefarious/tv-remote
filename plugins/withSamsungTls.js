// Samsung TVs serve the remote-control socket (port 8002) with a self-signed
// certificate issued by "SmartViewSDK". Android rejects that by default, so this
// plugin installs an OkHttp factory that accepts it ONLY when the certificate is
// from SmartViewSDK and the host is a private LAN IP. Everything else keeps
// normal TLS validation.
const fs = require('fs');
const path = require('path');
const { withDangerousMod, withMainApplication } = require('expo/config-plugins');

const kotlin = (pkg) => `package ${pkg}

import com.facebook.react.modules.network.OkHttpClientFactory
import com.facebook.react.modules.network.OkHttpClientProvider
import java.security.KeyStore
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import okhttp3.OkHttpClient
import okhttp3.internal.tls.OkHostnameVerifier

class SamsungTvClientFactory : OkHttpClientFactory {
  override fun createNewNetworkModuleClient(): OkHttpClient {
    val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
    tmf.init(null as KeyStore?)
    val system = tmf.trustManagers.first { it is X509TrustManager } as X509TrustManager

    val trust = object : X509TrustManager {
      override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) =
        system.checkClientTrusted(chain, authType)

      override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
        try {
          system.checkServerTrusted(chain, authType)
        } catch (e: CertificateException) {
          val issuer = chain.firstOrNull()?.issuerX500Principal?.name ?: ""
          if (!issuer.contains("SmartViewSDK")) throw e
        }
      }

      override fun getAcceptedIssuers(): Array<X509Certificate> = system.acceptedIssuers
    }

    val ssl = SSLContext.getInstance("TLS")
    ssl.init(null, arrayOf(trust), null)

    val privateIp = Regex("^(10\\\\.|192\\\\.168\\\\.|172\\\\.(1[6-9]|2\\\\d|3[01])\\\\.).*")
    val verifier = HostnameVerifier { host, session ->
      privateIp.matches(host) || OkHostnameVerifier.verify(host, session)
    }

    return OkHttpClientProvider.createClientBuilder()
      .sslSocketFactory(ssl.socketFactory, trust)
      .hostnameVerifier(verifier)
      .build()
  }
}
`;

module.exports = function withSamsungTls(config) {
  const pkg = config.android?.package;
  if (!pkg) throw new Error('withSamsungTls: set expo.android.package in app.json');

  config = withDangerousMod(config, [
    'android',
    async (cfg) => {
      const dir = path.join(cfg.modRequest.platformProjectRoot, 'app/src/main/java', ...pkg.split('.'));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SamsungTvClientFactory.kt'), kotlin(pkg));
      return cfg;
    },
  ]);

  config = withMainApplication(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (!src.includes('SamsungTvClientFactory')) {
      src = src.replace(
        /super\.onCreate\(\)\s*\n/,
        (m) =>
          `${m}    com.facebook.react.modules.network.OkHttpClientProvider.setOkHttpClientFactory(SamsungTvClientFactory())\n`,
      );
    }
    if (!src.includes('SamsungTvClientFactory()')) {
      throw new Error('withSamsungTls: could not patch MainApplication onCreate');
    }
    cfg.modResults.contents = src;
    return cfg;
  });

  return config;
};
