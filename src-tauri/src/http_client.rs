use serde::{Deserialize, Serialize};
use std::time::Instant;

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

/// Make an outbound HTTP/HTTPS request directly from the local machine.
///
/// Blocked destinations:
/// - Cloud instance-metadata services (169.254.169.254, fd00:ec2::254, etc.)
///   which can expose IAM credentials in cloud environments.
/// - The loopback address (127.x.x.x / ::1) is NOT blocked here because
///   the app legitimately contacts Grafana and other localhost services;
///   the caller (frontend) always supplies the user-configured target.
#[tauri::command]
pub fn make_http_request(
    method: String,
    url: String,
    headers: Vec<HttpHeader>,
    body: Option<String>,
) -> Result<HttpResponse, String> {
    // Reject well-known cloud-metadata hostnames/IPs.
    // These endpoints are never a legitimate target for an HTTP testing tool
    // but are prime SSRF exfiltration targets when running inside cloud VMs.
    let url_lower = url.to_lowercase();
    let blocked_hosts: &[&str] = &[
        "169.254.169.254",           // AWS/GCP/Azure IMDS
        "fd00:ec2::254",             // AWS IPv6 IMDS
        "metadata.google.internal",  // GCP alternate
        "100.100.100.200",           // Alibaba Cloud IMDS
        "192.0.0.192",               // Oracle Cloud IMDS
    ];
    for host in blocked_hosts {
        if url_lower.contains(host) {
            return Err(format!(
                "Request to cloud metadata address '{}' is not allowed",
                host
            ));
        }
    }

    let t0 = Instant::now();

    let mut req = ureq::request(&method, &url);
    for h in &headers {
        if !h.name.trim().is_empty() && !h.value.trim().is_empty() {
            req = req.set(&h.name, &h.value);
        }
    }

    let resp = if let Some(b) = body.as_deref().filter(|s| !s.is_empty()) {
        req.send_string(b)
    } else {
        req.call()
    };

    let latency_ms = t0.elapsed().as_millis() as u64;

    match resp {
        Ok(r) => parse_ureq_response(r, latency_ms),
        Err(ureq::Error::Status(code, r)) => parse_ureq_response_with_status(code, r, latency_ms),
        Err(e) => Err(format!("Request failed: {}", e)),
    }
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
    let body = r.into_string().unwrap_or_default();
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
