use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

// ── Shared types (also used by ssh.rs tunnel command) ─────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HttpHeader {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Serialize)]
pub struct HttpResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<HttpHeader>,
    pub body: String,
    pub latency_ms: u64,
    pub tunneled: bool,
}

// ── Regular HTTP request ───────────────────────────────────────────────────────

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const IO_TIMEOUT: Duration = Duration::from_secs(30);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_REDIRECTS: usize = 5;
/// Response bodies beyond this are truncated (the UI renders text, not files)
pub const MAX_BODY_BYTES: u64 = 10 * 1024 * 1024;

/// Cloud instance-metadata endpoints — never a legitimate target for a device
/// HTTP client, prime targets for credential theft. Checked against RESOLVED
/// addresses on every hop (substring checks were bypassable via decimal/hex
/// IPs, DNS names and redirects).
const BLOCKED_IPS: &[&str] = &["169.254.169.254", "fd00:ec2::254", "100.100.100.200", "192.0.0.192"];
const BLOCKED_HOSTS: &[&str] = &["metadata.google.internal", "metadata.goog"];

fn is_blocked_ip(ip: &std::net::IpAddr) -> bool {
    let ip = match ip {
        // ::ffff:169.254.169.254 → check the embedded IPv4 too
        std::net::IpAddr::V6(v6) => v6.to_ipv4_mapped().map(std::net::IpAddr::V4).unwrap_or(*ip),
        v4 => *v4,
    };
    BLOCKED_IPS.iter().any(|b| b.parse::<std::net::IpAddr>().map(|b| b == ip).unwrap_or(false))
}

/// Refuse cloud-metadata destinations. `resolve` is injectable for tests.
fn check_destination(
    u: &url::Url,
    resolve: &dyn Fn(&str, u16) -> Vec<std::net::IpAddr>,
) -> Result<(), String> {
    let host = match u.host() {
        Some(url::Host::Ipv4(ip)) => return if is_blocked_ip(&ip.into()) { Err(blocked(&ip.to_string())) } else { Ok(()) },
        Some(url::Host::Ipv6(ip)) => return if is_blocked_ip(&ip.into()) { Err(blocked(&ip.to_string())) } else { Ok(()) },
        Some(url::Host::Domain(d)) => d.trim_end_matches('.').to_lowercase(),
        None => return Err("URL has no host".to_string()),
    };
    if BLOCKED_HOSTS.contains(&host.as_str()) {
        return Err(blocked(&host));
    }
    let port = u.port_or_known_default().unwrap_or(80);
    if let Some(ip) = resolve(&host, port).iter().find(|ip| is_blocked_ip(ip)) {
        return Err(blocked(&format!("{} ({})", host, ip)));
    }
    Ok(())
}

fn blocked(what: &str) -> String {
    format!("Request to cloud metadata address {} is not allowed", what)
}

fn system_resolve(host: &str, port: u16) -> Vec<std::net::IpAddr> {
    use std::net::ToSocketAddrs;
    (host, port).to_socket_addrs().map(|a| a.map(|s| s.ip()).collect()).unwrap_or_default()
}

fn agent() -> ureq::Agent {
    static AGENT: std::sync::OnceLock<ureq::Agent> = std::sync::OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::AgentBuilder::new()
            .timeout_connect(CONNECT_TIMEOUT)
            .timeout_read(IO_TIMEOUT)
            .timeout_write(IO_TIMEOUT)
            .timeout(TOTAL_TIMEOUT)
            .redirects(0) // followed manually so every hop is checked
            .build()
    }).clone()
}

/// Make an outbound HTTP/HTTPS request from the local machine.
/// Runs off the main thread with connect/read/total deadlines and a body-size
/// cap (audit PERF-001) — a stalled server can no longer freeze the app.
#[tauri::command]
pub async fn make_http_request(
    method: String,
    url: String,
    headers: Vec<HttpHeader>,
    body: Option<String>,
) -> Result<HttpResponse, String> {
    tauri::async_runtime::spawn_blocking(move || do_request(method, url, headers, body))
        .await
        .map_err(|e| e.to_string())?
}

fn do_request(method: String, url: String, headers: Vec<HttpHeader>, body: Option<String>) -> Result<HttpResponse, String> {
    let t0 = Instant::now();
    let mut current = url::Url::parse(&url).map_err(|e| format!("Invalid URL: {}", e))?;
    let mut method = method;
    let mut body = body;

    for hop in 0..=MAX_REDIRECTS {
        if !matches!(current.scheme(), "http" | "https") {
            return Err(format!("Unsupported URL scheme: {}", current.scheme()));
        }
        check_destination(&current, &system_resolve)?;

        let mut req = agent().request(&method, current.as_str());
        for h in &headers {
            if !h.name.trim().is_empty() && !h.value.trim().is_empty() {
                req = req.set(&h.name, &h.value);
            }
        }
        let resp = match body.as_deref().filter(|s| !s.is_empty()) {
            Some(b) => req.send_string(b),
            None => req.call(),
        };
        let r = match resp {
            Ok(r) => r,
            Err(ureq::Error::Status(_, r)) => r,
            Err(e) => return Err(format!("Request failed: {}", e)),
        };

        let status = r.status();
        if (300..400).contains(&status) && status != 304 {
            if let Some(loc) = r.header("location") {
                if hop == MAX_REDIRECTS {
                    return Err(format!("Too many redirects (>{})", MAX_REDIRECTS));
                }
                current = current.join(loc).map_err(|e| format!("Bad redirect: {}", e))?;
                // 303 (and legacy 301/302 after POST) switch to GET without a body
                if status == 303 || ((status == 301 || status == 302) && method.eq_ignore_ascii_case("POST")) {
                    method = "GET".to_string();
                    body = None;
                }
                continue;
            }
        }
        return parse_ureq_response_with_status(status, r, t0.elapsed().as_millis() as u64);
    }
    Err(format!("Too many redirects (>{})", MAX_REDIRECTS))
}

fn parse_ureq_response(r: ureq::Response, latency_ms: u64) -> Result<HttpResponse, String> {
    let status = r.status();
    parse_ureq_response_with_status(status, r, latency_ms)
}

fn parse_ureq_response_with_status(
    status: u16,
    r: ureq::Response,
    latency_ms: u64,
) -> Result<HttpResponse, String> {
    let status_text = r.status_text().to_string();
    let mut headers = Vec::new();
    for name in r.headers_names() {
        if let Some(val) = r.header(&name) {
            headers.push(HttpHeader { name: name.clone(), value: val.to_string() });
        }
    }
    use std::io::Read as _;
    let mut raw = Vec::new();
    r.into_reader().take(MAX_BODY_BYTES + 1).read_to_end(&mut raw).map_err(|e| format!("Reading response: {}", e))?;
    let truncated = raw.len() as u64 > MAX_BODY_BYTES;
    raw.truncate(MAX_BODY_BYTES as usize);
    let mut body = String::from_utf8_lossy(&raw).into_owned();
    if truncated {
        body.push_str(&format!("\n\n[… response truncated at {} MB]", MAX_BODY_BYTES / 1024 / 1024));
    }
    Ok(HttpResponse { status, status_text, headers, body, latency_ms, tunneled: false })
}

// ── Raw HTTP response parser — used by ssh.rs tunnel command ─────────────────

pub fn parse_raw_http_response(raw: &[u8], latency_ms: u64) -> Result<HttpResponse, String> {
    let sep = b"\r\n\r\n";
    let (head, body_bytes) = if let Some(pos) = raw.windows(4).position(|w| w == sep) {
        (&raw[..pos], &raw[pos + 4..])
    } else {
        (raw, &b""[..])
    };

    let head_str = String::from_utf8_lossy(head);
    let mut lines = head_str.lines();

    let status_line = lines.next().unwrap_or("");
    let mut parts = status_line.splitn(3, ' ');
    parts.next(); // HTTP/x.x
    let status: u16 = parts.next().unwrap_or("0").parse().unwrap_or(0);
    let status_text = parts.next().unwrap_or("").to_string();

    let mut headers = Vec::new();
    let mut chunked = false;
    for line in lines {
        if line.is_empty() { break; }
        if let Some(colon) = line.find(':') {
            let name = line[..colon].trim().to_string();
            let value = line[colon + 1..].trim().to_string();
            if name.eq_ignore_ascii_case("transfer-encoding") && value.eq_ignore_ascii_case("chunked") {
                chunked = true;
            }
            headers.push(HttpHeader { name, value });
        }
    }

    let body = if chunked {
        decode_chunked(body_bytes)
            .unwrap_or_else(|_| String::from_utf8_lossy(body_bytes).into_owned())
    } else {
        String::from_utf8_lossy(body_bytes).into_owned()
    };

    Ok(HttpResponse { status, status_text, headers, body, latency_ms, tunneled: true })
}

pub fn decode_chunked(data: &[u8]) -> Result<String, ()> {
    let mut out = Vec::new();
    let mut pos = 0;
    loop {
        let end = data[pos..].windows(2).position(|w| w == b"\r\n").ok_or(())?;
        let size_str = std::str::from_utf8(&data[pos..pos + end]).map_err(|_| ())?;
        let size = usize::from_str_radix(size_str.trim(), 16).map_err(|_| ())?;
        pos += end + 2;
        if size == 0 { break; }
        if pos + size > data.len() { return Err(()); }
        out.extend_from_slice(&data[pos..pos + size]);
        pos += size + 2;
        if pos >= data.len() { break; }
    }
    String::from_utf8(out).map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_dns(_: &str, _: u16) -> Vec<std::net::IpAddr> { vec![] }

    #[test]
    fn blocks_metadata_in_every_spelling() {
        for u in [
            "http://169.254.169.254/latest/meta-data/",
            "http://2852039166/",           // decimal
            "http://0xa9fea9fe/",           // hex
            "http://169.254.43518/",        // mixed
            "http://[::ffff:169.254.169.254]/",
            "http://[fd00:ec2::254]/",
            "http://metadata.google.internal/computeMetadata/v1/",
            "http://METADATA.GOOGLE.INTERNAL./",
        ] {
            assert!(check_destination(&url::Url::parse(u).unwrap(), &no_dns).is_err(), "should block {}", u);
        }
    }

    #[test]
    fn blocks_dns_names_resolving_to_metadata() {
        let evil = |_: &str, _: u16| vec!["169.254.169.254".parse().unwrap()];
        assert!(check_destination(&url::Url::parse("http://innocent.example/").unwrap(), &evil).is_err());
    }

    #[test]
    fn allows_normal_and_link_local_devices() {
        let lan = |_: &str, _: u16| vec!["192.168.1.20".parse().unwrap()];
        for u in ["http://10.0.0.5:8080/api", "http://169.254.10.20/", "http://localhost:3000/", "http://drone.local/"] {
            assert!(check_destination(&url::Url::parse(u).unwrap(), &lan).is_ok(), "should allow {}", u);
        }
    }

    /// Tiny one-shot HTTP server on localhost returning `resp` to each request.
    fn serve(resps: Vec<&'static str>) -> u16 {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            for r in resps {
                if let Ok((mut c, _)) = l.accept() {
                    let mut buf = [0u8; 2048];
                    let _ = c.read(&mut buf);
                    let _ = c.write_all(r.as_bytes());
                }
            }
        });
        port
    }

    #[test]
    fn redirect_to_metadata_is_blocked_mid_chain() {
        let port = serve(vec!["HTTP/1.1 302 Found\r\nLocation: http://169.254.169.254/latest/meta-data/\r\nContent-Length: 0\r\n\r\n"]);
        let err = do_request("GET".into(), format!("http://127.0.0.1:{}/", port), vec![], None).unwrap_err();
        assert!(err.contains("metadata"), "{}", err);
    }

    #[test]
    fn follows_ordinary_redirects_and_303_switches_to_get() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            let mut seen = Vec::new();
            for i in 0..2 {
                let (mut c, _) = l.accept().unwrap();
                let mut buf = [0u8; 2048];
                let n = c.read(&mut buf).unwrap();
                seen.push(String::from_utf8_lossy(&buf[..n]).lines().next().unwrap_or("").to_string());
                let r = if i == 0 {
                    "HTTP/1.1 303 See Other\r\nLocation: /done\r\nContent-Length: 0\r\n\r\n".to_string()
                } else {
                    format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}", seen[1].len(), seen[1])
                };
                c.write_all(r.as_bytes()).unwrap();
            }
        });
        let r = do_request("POST".into(), format!("http://127.0.0.1:{}/start", port), vec![], Some("x=1".into())).unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.body, "GET /done HTTP/1.1");
    }
}
