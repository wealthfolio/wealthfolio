use std::{io, net::SocketAddr, sync::Arc, time::Duration};

use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
};
use tokio_rustls::{rustls, TlsAcceptor};
use wealthfolio_http::client_builder;

// Each fixture has a fresh, deliberately untrusted certificate valid only for
// localhost. No machine certificate store or external network is involved.
struct TlsFixture {
    address: SocketAddr,
    certificate: reqwest::Certificate,
    server: JoinHandle<io::Result<String>>,
}

impl TlsFixture {
    async fn start() -> Self {
        let rcgen::CertifiedKey { cert, signing_key } =
            rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).unwrap();
        let certificate = reqwest::Certificate::from_der(cert.der().as_ref()).unwrap();
        let key = rustls::pki_types::PrivatePkcs8KeyDer::from(signing_key.serialize_der());
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::aws_lc_rs::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![cert.der().clone()], key.into())
        .unwrap();
        let acceptor = TlsAcceptor::from(Arc::new(config));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await?;
            let mut tls = acceptor.accept(socket).await?;
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            loop {
                let count = tls.read(&mut buffer).await?;
                if count == 0 {
                    return Err(io::ErrorKind::UnexpectedEof.into());
                }
                request.extend_from_slice(&buffer[..count]);
                if let Some(header_end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..header_end]);
                    let body_length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if request.len() >= header_end + 4 + body_length {
                        break;
                    }
                }
            }
            tls.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n").await?;
            tls.shutdown().await?;
            Ok(String::from_utf8(request).unwrap())
        });
        Self {
            address,
            certificate,
            server,
        }
    }

    fn builder(&self) -> reqwest::ClientBuilder {
        client_builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .resolve("localhost", self.address)
    }

    fn url(&self) -> String {
        format!("https://localhost:{}/fixture", self.address.port())
    }

    async fn finish(self) -> io::Result<String> {
        tokio::time::timeout(Duration::from_secs(5), self.server)
            .await
            .expect("TLS fixture must finish")
            .unwrap()
    }
}

#[tokio::test]
async fn bundled_policy_rejects_an_untrusted_certificate() {
    let fixture = TlsFixture::start().await;
    let error = fixture
        .builder()
        .build()
        .unwrap()
        .get(fixture.url())
        .send()
        .await
        .unwrap_err();
    assert!(
        error.is_connect(),
        "expected certificate handshake failure: {error:?}"
    );
    assert!(!error.is_timeout());
    assert!(
        fixture.finish().await.is_err(),
        "server must observe a rejected handshake"
    );
}

#[tokio::test]
async fn explicitly_trusted_certificate_supports_query_form_and_chunked_response() {
    let fixture = TlsFixture::start().await;
    // Extend the application's explicit roots. This does not turn off hostname
    // or chain verification and does not select the platform verifier.
    let mut response = fixture
        .builder()
        .tls_certs_merge([fixture.certificate.clone()])
        .build()
        .unwrap()
        .post(fixture.url())
        .query(&[("search", "BTC USD")])
        .form(&[("value", "one & two")])
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.unwrap() {
        body.extend_from_slice(&chunk);
    }
    assert_eq!(body, b"hello world");
    let request = fixture.finish().await.unwrap();
    assert!(request.starts_with("POST /fixture?search=BTC+USD HTTP/1.1\r\n"));
    assert!(request
        .to_ascii_lowercase()
        .contains("content-type: application/x-www-form-urlencoded"));
    assert!(request.ends_with("value=one+%26+two"));
}

#[tokio::test]
async fn trusting_a_certificate_does_not_disable_hostname_verification() {
    let fixture = TlsFixture::start().await;
    let error = fixture
        .builder()
        .tls_certs_merge([fixture.certificate.clone()])
        .build()
        .unwrap()
        // The certificate permits localhost, but not its numeric IP address.
        .get(format!("https://{}/fixture", fixture.address))
        .send()
        .await
        .unwrap_err();
    assert!(
        error.is_connect(),
        "expected hostname handshake failure: {error:?}"
    );
    assert!(!error.is_timeout());
    assert!(
        fixture.finish().await.is_err(),
        "server must observe a rejected handshake"
    );
}
