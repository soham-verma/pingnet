// ── Speedtest (Cloudflare-backed) ──────────────────────────────────────────────
//
// A speed test — download, upload, latency/jitter — run entirely with `curl`,
// no extra binary required. The core logic here is generic over how a shell
// command's stdout gets captured, so the exact same test can run either over
// an existing SSH session (see ssh::run_speedtest, for a remote host) or as a
// local subprocess on this machine (see run_local_speedtest below). Optionally
// bound to one network interface (via curl's `--interface`) so a dual-homed
// host (e.g. WiFi + LTE) can be tested per link instead of whatever the
// kernel's default route happens to pick.

use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SpeedtestResult {
    pub interface:       Option<String>, // NIC the test was bound to, or null for the default route
    pub connectivity_ok: bool,
    pub download_mbps:   f64,
    pub upload_mbps:     f64,
    pub latency_ms:      f64,
    pub jitter_ms:       f64,
    pub server:          String,
    pub error:           Option<String>,
}

/// Runs the test using `exec` to capture each shell command's stdout.
/// `exec` is the only thing that differs between the SSH and local variants.
pub fn run_core(
    exec: &dyn Fn(&str) -> Result<String, String>,
    iface: Option<&str>,
    force: bool,
) -> SpeedtestResult {
    let iface_owned = iface.map(|s| s.to_string());

    let fail = |connectivity_ok: bool, msg: String| SpeedtestResult {
        interface: iface_owned.clone(), connectivity_ok,
        download_mbps: 0.0, upload_mbps: 0.0, latency_ms: 0.0, jitter_ms: 0.0,
        server: String::new(), error: Some(msg),
    };

    // Build curl's --interface flag once. Validated defensively since it's
    // interpolated into a shell command string below.
    let bind: String = match iface {
        Some(i) if !i.is_empty() => {
            if !i.chars().all(|c| c.is_alphanumeric() || c == '.' || c == '-' || c == '_') {
                return fail(false, "Invalid interface name".to_string());
            }
            format!("--interface {} ", i)
        }
        _ => String::new(),
    };

    // Pre-flight connectivity check — a quick, tiny request to Cloudflare on
    // the chosen interface. Mirrors the "Checking connectivity…" step of
    // dedicated speedtest tools before committing to a full download/upload.
    let conn_cmd = format!(
        r#"curl -s -o /dev/null -w "%{{http_code}}" --max-time 5 --connect-timeout 3 {bind}"https://speed.cloudflare.com/__down?bytes=0" 2>/dev/null || echo "000""#
    );
    let connectivity_ok = exec(&conn_cmd)
        .map(|out| { let c = out.trim(); c.starts_with('2') || c.starts_with('3') })
        .unwrap_or(false);

    if !connectivity_ok && !force {
        return fail(false, format!(
            "No internet connectivity{} — retry with Force to test anyway",
            iface_owned.as_ref().map(|i| format!(" on {}", i)).unwrap_or_default()
        ));
    }

    // Phase 1: latency — 5 tiny HTTP round-trips
    let lat_script = format!(
        r#"for i in 1 2 3 4 5; do curl -s -o /dev/null -w "%{{time_total}}\n" --max-time 3 {bind}"https://speed.cloudflare.com/__down?measId=0&bytes=0" 2>/dev/null || echo "0"; done"#
    );
    let lat_raw = match exec(&lat_script) {
        Err(e) => return fail(connectivity_ok, format!("curl unavailable: {}", e)),
        Ok(s) => s,
    };

    let times: Vec<f64> = lat_raw.lines()
        .filter_map(|l| l.trim().parse::<f64>().ok())
        .filter(|&t| t > 0.0)
        .collect();

    if times.is_empty() {
        return fail(connectivity_ok, "curl not available".to_string());
    }

    let latency_ms = times.iter().sum::<f64>() / times.len() as f64 * 1000.0;
    let jitter_ms = if times.len() > 1 {
        let mean = times.iter().sum::<f64>() / times.len() as f64;
        let var  = times.iter().map(|t| (t - mean).powi(2)).sum::<f64>() / times.len() as f64;
        var.sqrt() * 1000.0
    } else { 0.0 };

    // Phase 2: download 10 MB
    let dl_cmd = format!(
        r#"curl -s -o /dev/null -w "%{{speed_download}}" --max-time 15 {bind}"https://speed.cloudflare.com/__down?measId=0&bytes=10000000" 2>/dev/null || echo "0""#
    );
    let dl_bps: f64 = exec(&dl_cmd).unwrap_or_default().trim().parse().unwrap_or(0.0);

    // Phase 3: upload 2 MB
    let ul_cmd = format!(
        r#"dd if=/dev/zero bs=1M count=2 2>/dev/null | curl -s -X POST --data-binary @- -o /dev/null -w "%{{speed_upload}}" --max-time 15 {bind}"https://speed.cloudflare.com/__up?measId=0" 2>/dev/null || echo "0""#
    );
    let ul_bps: f64 = exec(&ul_cmd).unwrap_or_default().trim().parse().unwrap_or(0.0);

    SpeedtestResult {
        interface: iface_owned,
        connectivity_ok,
        download_mbps: dl_bps / 1_000_000.0 * 8.0,
        upload_mbps:   ul_bps / 1_000_000.0 * 8.0,
        latency_ms,
        jitter_ms,
        server: "speed.cloudflare.com".to_string(),
        error: None,
    }
}

// ── Local (non-SSH) variant — tests this machine's own connection ─────────────

fn local_exec(cmd: &str) -> Result<String, String> {
    let output = Command::new("sh")
        .arg("-c")
        .arg(cmd)
        .output()
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Speed test for the machine Pingnet itself is running on (no SSH session
/// involved). Currently macOS/Linux only — shells out to `sh -c`, same as the
/// SSH variant does on the remote host. Windows doesn't have a POSIX shell,
/// `dd`, or `curl --interface` guaranteed available in the same shape, so we
/// report that plainly rather than silently returning wrong numbers.
#[tauri::command]
pub async fn run_local_speedtest(iface: Option<String>, force: bool) -> Result<SpeedtestResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if cfg!(target_os = "windows") {
            return SpeedtestResult {
                interface: iface, connectivity_ok: false,
                download_mbps: 0.0, upload_mbps: 0.0, latency_ms: 0.0, jitter_ms: 0.0,
                server: String::new(),
                error: Some("Local speed test isn't supported on Windows yet — SSH into a Linux/macOS host to test from there instead".to_string()),
            };
        }
        run_core(&local_exec, iface.as_deref(), force)
    })
    .await
    .map_err(|e| e.to_string())
}
