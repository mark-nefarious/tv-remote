// Samsung TVs serve the remote-control socket (port 8002) with a self-signed
// self-signed certificate issued by "SmartViewSDK". Android rejects that by default,
// so this plugin installs an OkHttp factory that accepts a self-signed cert ONLY when
// the peer is a private LAN address AND (it is port 8002 or the issuer is SmartViewSDK).
// Everything else keeps normal TLS validation.
const fs = require('fs');
const path = require('path');
const { withDangerousMod, withMainApplication } = require('expo/config-plugins');

const kotlin = (pkg) => `package ${pkg}

import com.facebook.react.modules.network.OkHttpClientFactory
import com.facebook.react.modules.network.OkHttpClientProvider
import java.net.InetAddress
import java.net.Socket
import java.security.KeyStore
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509ExtendedTrustManager
import javax.net.ssl.X509TrustManager
import okhttp3.OkHttpClient
import okhttp3.internal.tls.OkHostnameVerifier

// RN's WebSocketModule builds its client from OkHttpClientProvider.getOkHttpClient(),
// so this factory covers both fetch and WebSocket.
class SamsungTvClientFactory : OkHttpClientFactory {
  private fun isPrivate(addr: InetAddress?) =
    addr != null && (addr.isSiteLocalAddress || addr.isLinkLocalAddress)

  override fun createNewNetworkModuleClient(): OkHttpClient {
    val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
    tmf.init(null as KeyStore?)
    val system = tmf.trustManagers.first { it is X509TrustManager } as X509TrustManager

    // Extended trust manager so the self-signed exception can check WHO we are talking
    // to. The plain 2-arg check has no peer info and would trust a "SmartViewSDK"
    // cert for any host on the internet.
    val trust = object : X509ExtendedTrustManager() {
      private fun tvCert(chain: Array<X509Certificate>, port: Int): Boolean {
        val issuer = chain.firstOrNull()?.issuerX500Principal?.name ?: ""
        return port == 8002 || issuer.contains("SmartViewSDK")
      }

      private fun check(chain: Array<X509Certificate>, authType: String, addr: InetAddress?, port: Int) {
        try {
          system.checkServerTrusted(chain, authType)
        } catch (e: CertificateException) {
          if (!isPrivate(addr) || !tvCert(chain, port)) throw e
        }
      }

      override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String, socket: Socket) =
        check(chain, authType, socket.inetAddress, socket.port)

      override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String, engine: SSLEngine) =
        check(chain, authType, runCatching { InetAddress.getByName(engine.peerHost) }.getOrNull(), engine.peerPort)

      override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) =
        system.checkServerTrusted(chain, authType)

      override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String, socket: Socket) =
        system.checkClientTrusted(chain, authType)

      override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String, engine: SSLEngine) =
        system.checkClientTrusted(chain, authType)

      override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) =
        system.checkClientTrusted(chain, authType)

      override fun getAcceptedIssuers(): Array<X509Certificate> = system.acceptedIssuers
    }

    val ssl = SSLContext.getInstance("TLS")
    ssl.init(null, arrayOf(trust), null)

    // The TV cert has no SAN for its IP. Skip the hostname check only for literal
    // private IPv4 addresses; everything else gets normal verification.
    val privateIp = Regex("^(10\\\\.|192\\\\.168\\\\.|172\\\\.(1[6-9]|2\\\\d|3[01])\\\\.)[0-9.]+$")
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
