//! TLS client over an arbitrary byte stream (an SSH direct-tcpip channel),
//! with normal certificate + hostname verification against the web PKI.

use std::io::{ErrorKind, Read, Write};
use std::sync::{Arc, OnceLock};

fn client_config() -> Arc<rustls::ClientConfig> {
    static CFG: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    CFG.get_or_init(|| {
        let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        Arc::new(
            rustls::ClientConfig::builder_with_provider(provider)
                .with_safe_default_protocol_versions()
                .expect("rustls protocol versions")
                .with_root_certificates(roots)
                .with_no_client_auth(),
        )
    })
    .clone()
}

/// Start a verified TLS session to `host` over `stream`.
pub fn connect<S: Read + Write>(host: &str, stream: S) -> Result<rustls::StreamOwned<rustls::ClientConnection, S>, String> {
    let name = rustls::pki_types::ServerName::try_from(host.to_string())
        .map_err(|_| format!("Invalid TLS server name: {}", host))?;
    let conn = rustls::ClientConnection::new(client_config(), name)
        .map_err(|e| format!("TLS setup failed: {}", e))?;
    Ok(rustls::StreamOwned::new(conn, stream))
}

/// Read until the server closes. Many servers close the TCP stream without a
/// TLS close_notify after `Connection: close`; that's treated as end-of-body
/// once some response bytes have arrived. Certificate/handshake failures
/// surface as errors with the rustls reason.
pub fn read_response<R: Read>(r: &mut R) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    loop {
        match r.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                // Cap like direct requests (headers + 10 MB body)
                if buf.len() as u64 > crate::http_client::MAX_BODY_BYTES + 64 * 1024 {
                    break;
                }
            }
            Err(e) if e.kind() == ErrorKind::UnexpectedEof && !buf.is_empty() => break,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) => return Err(format!("TLS: {}", e)),
        }
    }
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_server_name() {
        let s = std::io::Cursor::new(Vec::<u8>::new());
        assert!(connect("bad name!", s).is_err());
    }

    #[test]
    fn accepts_ip_and_dns_names() {
        assert!(connect("10.0.0.5", std::io::Cursor::new(Vec::<u8>::new())).is_ok());
        assert!(connect("grafana.internal", std::io::Cursor::new(Vec::<u8>::new())).is_ok());
    }

    #[test]
    fn eof_after_data_ends_response() {
        struct R(u8);
        impl Read for R {
            fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
                self.0 += 1;
                if self.0 == 1 { b[..2].copy_from_slice(b"ok"); Ok(2) }
                else { Err(std::io::Error::new(ErrorKind::UnexpectedEof, "no close_notify")) }
            }
        }
        assert_eq!(read_response(&mut R(0)).unwrap(), b"ok");
    }
}

