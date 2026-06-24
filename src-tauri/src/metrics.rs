use serde::{Deserialize, Serialize};
use ssh2::Session;
use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, Mutex};

// ── SSH exec helper ───────────────────────────────────────────────────────────

fn exec(session: &Session, cmd: &str) -> Result<String, String> {
    let mut ch = session
        .channel_session()
        .map_err(|e| format!("channel_session: {}", e))?;
    ch.exec(cmd).map_err(|e| format!("exec: {}", e))?;
    let mut out = String::new();
    ch.read_to_string(&mut out).map_err(|e| e.to_string())?;
    let _ = ch.close();
    Ok(out)
}

/// Run a command, return empty string on any error (non-fatal).
fn try_exec(session: &Session, cmd: &str) -> String {
    exec(session, cmd).unwrap_or_default()
}

// ── Capabilities ──────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct Capabilities {
    // Architecture / platform
    pub arch: String,
    pub kernel: String,
    pub model: String,        // device-tree model (RPi, Jetson, etc.)
    pub is_jetson: bool,
    pub is_rpi: bool,

    // /proc availability
    pub proc_stat: bool,
    pub proc_meminfo: bool,
    pub proc_net_dev: bool,
    pub proc_diskstats: bool,
    pub proc_loadavg: bool,
    pub proc_uptime: bool,

    // Standard tools
    pub free_format: String,  // "modern" | "busybox" | "none"
    pub has_top: bool,
    pub has_ps: bool,
    pub has_df: bool,

    // GPU tools
    pub has_nvidia_smi: bool,
    pub has_tegrastats: bool,   // Jetson
    pub has_jetson_gpu_load: bool,  // /sys/devices/gpu.0/load
    pub has_vcgencmd: bool,     // Raspberry Pi VideoCore
    pub has_rocm_smi: bool,     // AMD

    // Thermal
    pub thermal_zone_count: u32,
    pub has_sensors: bool,
}

/// Run once on first metrics fetch. One SSH exec, parses key=value output.
pub fn probe(session: &Session) -> Capabilities {
    // One large script — all output is key=value lines
    let script = r#"
echo "arch=$(uname -m)"
echo "kernel=$(uname -r)"
MODEL=$(cat /proc/device-tree/model 2>/dev/null | tr -d '\0')
echo "model=$MODEL"
[ -f /proc/stat ]       && echo "proc_stat=1"       || echo "proc_stat=0"
[ -f /proc/meminfo ]    && echo "proc_meminfo=1"    || echo "proc_meminfo=0"
[ -f /proc/net/dev ]    && echo "proc_net_dev=1"    || echo "proc_net_dev=0"
[ -f /proc/diskstats ]  && echo "proc_diskstats=1"  || echo "proc_diskstats=0"
[ -f /proc/loadavg ]    && echo "proc_loadavg=1"    || echo "proc_loadavg=0"
[ -f /proc/uptime ]     && echo "proc_uptime=1"     || echo "proc_uptime=0"
if command -v free >/dev/null 2>&1; then
  free -m 2>/dev/null | head -1 | grep -q "available" && echo "free_format=modern" || echo "free_format=busybox"
else
  echo "free_format=none"
fi
command -v top      >/dev/null 2>&1 && echo "has_top=1"         || echo "has_top=0"
command -v ps       >/dev/null 2>&1 && echo "has_ps=1"          || echo "has_ps=0"
command -v df       >/dev/null 2>&1 && echo "has_df=1"          || echo "has_df=0"
command -v nvidia-smi  >/dev/null 2>&1 && echo "has_nvidia_smi=1"  || echo "has_nvidia_smi=0"
command -v tegrastats  >/dev/null 2>&1 && echo "has_tegrastats=1"  || echo "has_tegrastats=0"
[ -f /sys/devices/gpu.0/load ] && echo "has_jetson_gpu_load=1" || echo "has_jetson_gpu_load=0"
command -v vcgencmd >/dev/null 2>&1 && echo "has_vcgencmd=1"   || echo "has_vcgencmd=0"
command -v rocm-smi >/dev/null 2>&1 && echo "has_rocm_smi=1"   || echo "has_rocm_smi=0"
command -v sensors  >/dev/null 2>&1 && echo "has_sensors=1"    || echo "has_sensors=0"
TZ=$(ls /sys/class/thermal/thermal_zone*/temp 2>/dev/null | wc -l)
echo "thermal_zone_count=$TZ"
"#;

    let raw = try_exec(session, script);
    let mut cap = Capabilities::default();

    for line in raw.lines() {
        if let Some((k, v)) = line.split_once('=') {
            match k.trim() {
                "arch"     => cap.arch   = v.trim().to_string(),
                "kernel"   => cap.kernel = v.trim().to_string(),
                "model"    => cap.model  = v.trim().to_string(),
                "proc_stat"          => cap.proc_stat          = v == "1",
                "proc_meminfo"       => cap.proc_meminfo       = v == "1",
                "proc_net_dev"       => cap.proc_net_dev       = v == "1",
                "proc_diskstats"     => cap.proc_diskstats     = v == "1",
                "proc_loadavg"       => cap.proc_loadavg       = v == "1",
                "proc_uptime"        => cap.proc_uptime        = v == "1",
                "free_format"        => cap.free_format        = v.trim().to_string(),
                "has_top"            => cap.has_top            = v == "1",
                "has_ps"             => cap.has_ps             = v == "1",
                "has_df"             => cap.has_df             = v == "1",
                "has_nvidia_smi"     => cap.has_nvidia_smi     = v == "1",
                "has_tegrastats"     => cap.has_tegrastats     = v == "1",
                "has_jetson_gpu_load"=> cap.has_jetson_gpu_load= v == "1",
                "has_vcgencmd"       => cap.has_vcgencmd       = v == "1",
                "has_rocm_smi"       => cap.has_rocm_smi       = v == "1",
                "has_sensors"        => cap.has_sensors        = v == "1",
                "thermal_zone_count" => {
                    cap.thermal_zone_count = v.trim().parse().unwrap_or(0);
                }
                _ => {}
            }
        }
    }

    // Derive platform flags
    let model_lower = cap.model.to_lowercase();
    cap.is_jetson = model_lower.contains("jetson") || cap.has_tegrastats || cap.has_jetson_gpu_load;
    cap.is_rpi    = model_lower.contains("raspberry pi") || cap.has_vcgencmd;

    cap
}

// ── Previous sample storage ───────────────────────────────────────────────────

#[derive(Clone, Default)]
pub struct PrevSamples {
    pub cpu_total: u64,
    pub cpu_idle: u64,
    pub cpu_cores: Vec<(u64, u64)>,  // (total, idle) per core
    pub net_rx: HashMap<String, u64>,
    pub net_tx: HashMap<String, u64>,
    pub net_ts: u64,
    pub disk_reads: HashMap<String, u64>,
    pub disk_writes: HashMap<String, u64>,
    pub disk_ts: u64,
}

pub struct MetricsState {
    pub caps:    Mutex<HashMap<String, Capabilities>>,
    pub samples: Mutex<HashMap<String, PrevSamples>>,
}

impl MetricsState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            caps:    Mutex::new(HashMap::new()),
            samples: Mutex::new(HashMap::new()),
        })
    }
}

// ── Snapshot returned to frontend ─────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CoreStat {
    pub index: u32,
    pub percent: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NetIface {
    pub name: String,
    pub rx_kbps: f64,
    pub tx_kbps: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DiskIo {
    pub name: String,
    pub read_kbps: f64,
    pub write_kbps: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ThermalZone {
    pub name: String,    // "cpu-thermal", "gpu-thermal", etc. (or "zone0" fallback)
    pub temp_c: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GpuStat {
    pub vendor: String,  // "nvidia" | "jetson" | "rpi" | "amd"
    pub name: String,
    pub util_pct: Option<f64>,
    pub mem_used_mb: Option<u64>,
    pub mem_total_mb: Option<u64>,
    pub temp_c: Option<f64>,
    pub power_w: Option<f64>,
    pub note: Option<String>,  // e.g. "temperature via tegrastats"
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProcessEntry {
    pub pid: u32,
    pub user: String,
    pub cpu_pct: f64,
    pub mem_pct: f64,
    pub command: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MetricsSnapshot {
    // Summary (always present — null = not available on this system)
    pub cpu_percent: Option<f64>,
    pub cpu_unavailable_reason: Option<String>,

    pub mem_used_mb: Option<u64>,
    pub mem_total_mb: Option<u64>,
    pub mem_unavailable_reason: Option<String>,

    pub disk_used_pct: Option<u64>,
    pub disk_used_gb: Option<f64>,
    pub disk_total_gb: Option<f64>,
    pub disk_unavailable_reason: Option<String>,

    pub load_avg_1: Option<f64>,
    pub load_avg_5: Option<f64>,
    pub load_avg_15: Option<f64>,
    pub uptime_seconds: Option<u64>,

    // Advanced
    pub cores: Vec<CoreStat>,
    pub net_ifaces: Vec<NetIface>,
    pub disk_io: Vec<DiskIo>,
    pub thermal: Vec<ThermalZone>,
    pub gpus: Vec<GpuStat>,
    pub processes: Vec<ProcessEntry>,

    // Platform info (from cached caps)
    pub arch: String,
    pub kernel: String,
    pub model: String,
    pub is_first_poll: bool,  // true on first call — CPU/net/disk deltas will be 0
}

// ── Parsers ───────────────────────────────────────────────────────────────────

fn parse_proc_stat(raw: &str) -> (Option<(u64, u64)>, Vec<(u64, u64)>) {
    let mut overall: Option<(u64, u64)> = None;
    let mut cores: Vec<(u64, u64)> = Vec::new();

    for line in raw.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.is_empty() { continue; }
        let label = parts[0];
        let nums: Vec<u64> = parts[1..].iter().filter_map(|s| s.parse().ok()).collect();
        if nums.len() < 4 { continue; }
        let idle = nums[3] + nums.get(4).copied().unwrap_or(0);
        let total: u64 = nums.iter().sum();
        if label == "cpu" {
            overall = Some((total, idle));
        } else if label.starts_with("cpu") {
            cores.push((total, idle));
        }
    }
    (overall, cores)
}

fn cpu_pct(prev_total: u64, prev_idle: u64, cur_total: u64, cur_idle: u64) -> f64 {
    let dt = cur_total.saturating_sub(prev_total);
    let di = cur_idle.saturating_sub(prev_idle);
    if dt == 0 { return 0.0; }
    let pct = (dt.saturating_sub(di) as f64 / dt as f64) * 100.0;
    (pct * 10.0).round() / 10.0
}

fn parse_proc_meminfo(raw: &str) -> Option<(u64, u64)> {
    let mut total: Option<u64> = None;
    let mut available: Option<u64> = None;
    for line in raw.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 2 { continue; }
        match parts[0] {
            "MemTotal:"     => { total = parts[1].parse().ok(); }
            "MemAvailable:" => { available = parts[1].parse().ok(); }
            _ => {}
        }
    }
    match (total, available) {
        (Some(t), Some(a)) => Some((t / 1024, (t - a) / 1024)), // MB: (total, used)
        _ => None,
    }
}

fn parse_free_modern(raw: &str) -> Option<(u64, u64)> {
    // "Mem:  total used free shared buff/cache available"
    for line in raw.lines() {
        if line.starts_with("Mem:") {
            let nums: Vec<u64> = line.split_whitespace().skip(1)
                .filter_map(|s| s.parse().ok()).collect();
            if nums.len() >= 2 { return Some((nums[0], nums[1])); }
        }
    }
    None
}

fn parse_free_busybox(raw: &str) -> Option<(u64, u64)> {
    // "Mem:  total used free ..."  (no headers row / different columns)
    for line in raw.lines() {
        if line.starts_with("Mem:") {
            let nums: Vec<u64> = line.split_whitespace().skip(1)
                .filter_map(|s| s.parse().ok()).collect();
            if nums.len() >= 2 { return Some((nums[0] / 1024, nums[1] / 1024)); }
        }
    }
    None
}

fn parse_df(raw: &str) -> Option<(u64, f64, f64)> {
    // Second line: "filesystem 1K-blocks used available use% mount"
    raw.lines().nth(1).and_then(|l| {
        let parts: Vec<&str> = l.split_whitespace().collect();
        if parts.len() < 5 { return None; }
        let pct: u64 = parts[4].trim_end_matches('%').parse().ok()?;
        let total_kb: f64 = parts[1].parse().ok()?;
        let used_kb: f64 = parts[2].parse().ok()?;
        Some((pct, used_kb / 1_048_576.0, total_kb / 1_048_576.0))
    })
}

fn parse_loadavg(raw: &str) -> (Option<f64>, Option<f64>, Option<f64>) {
    let parts: Vec<f64> = raw.split_whitespace()
        .take(3).filter_map(|s| s.parse().ok()).collect();
    (parts.get(0).copied(), parts.get(1).copied(), parts.get(2).copied())
}

fn parse_uptime(raw: &str) -> Option<u64> {
    raw.split_whitespace().next()?.parse::<f64>().ok().map(|f| f as u64)
}

fn parse_proc_net_dev(raw: &str) -> HashMap<String, (u64, u64)> {
    // Returns map: iface -> (rx_bytes, tx_bytes)
    let mut map = HashMap::new();
    for line in raw.lines().skip(2) {
        let line = line.trim();
        if let Some((iface, rest)) = line.split_once(':') {
            let iface = iface.trim().to_string();
            if iface == "lo" { continue; }
            let nums: Vec<u64> = rest.split_whitespace()
                .filter_map(|s| s.parse().ok()).collect();
            if nums.len() >= 9 {
                map.insert(iface, (nums[0], nums[8]));
            }
        }
    }
    map
}

fn parse_proc_diskstats(raw: &str) -> HashMap<String, (u64, u64)> {
    // Returns map: device -> (sectors_read, sectors_written)
    let mut map = HashMap::new();
    for line in raw.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 10 { continue; }
        let name = parts[2].to_string();
        // Skip partitions (sda1, nvme0n1p1, etc.) — keep only whole disks
        if name.chars().last().map(|c| c.is_ascii_digit()).unwrap_or(false)
            && !name.starts_with("nvme") {
            continue;
        }
        let sectors_read:    u64 = parts[5].parse().unwrap_or(0);
        let sectors_written: u64 = parts[9].parse().unwrap_or(0);
        map.insert(name, (sectors_read, sectors_written));
    }
    map
}

fn parse_thermal_zones(temps_raw: &str, types_raw: &str) -> Vec<ThermalZone> {
    let temps: Vec<f64> = temps_raw.lines()
        .filter_map(|l| l.trim().parse::<i64>().ok())
        .map(|t| t as f64 / 1000.0)
        .collect();
    let types: Vec<&str> = types_raw.lines().collect();
    temps.into_iter().enumerate().map(|(i, temp_c)| {
        let name = types.get(i).map(|s| s.trim().to_string())
            .unwrap_or_else(|| format!("zone{}", i));
        ThermalZone { name, temp_c }
    }).collect()
}

fn parse_nvidia_smi(raw: &str) -> Vec<GpuStat> {
    // "index, name, util%, mem_used, mem_total, temp, power"
    raw.lines().filter(|l| !l.trim().is_empty()).map(|line| {
        let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
        GpuStat {
            vendor: "nvidia".to_string(),
            name: parts.get(1).unwrap_or(&"NVIDIA GPU").to_string(),
            util_pct:     parts.get(2).and_then(|s| s.parse().ok()),
            mem_used_mb:  parts.get(3).and_then(|s| s.parse().ok()),
            mem_total_mb: parts.get(4).and_then(|s| s.parse().ok()),
            temp_c:       parts.get(5).and_then(|s| s.parse().ok()),
            power_w:      parts.get(6).and_then(|s| s.trim_end_matches(" W").parse().ok()),
            note: None,
        }
    }).collect()
}

fn parse_jetson_gpu(load_raw: &str, tegrastats_raw: &str) -> Option<GpuStat> {
    // Try /sys/devices/gpu.0/load first (0-1000)
    let util_pct = load_raw.trim().parse::<u64>().ok()
        .map(|v| v as f64 / 10.0);

    // Try to extract GPU@temp from tegrastats
    let temp_c = tegrastats_raw.find("GPU@")
        .and_then(|i| {
            let rest = &tegrastats_raw[i+4..];
            rest.split('C').next()?.trim().parse::<f64>().ok()
        });

    // GR3D_FREQ from tegrastats is another source of GPU util
    let util_from_tegra = tegrastats_raw.find("GR3D_FREQ ")
        .and_then(|i| {
            let rest = &tegrastats_raw[i+10..];
            rest.split('%').next()?.trim().parse::<f64>().ok()
        });

    let final_util = util_pct.or(util_from_tegra);

    Some(GpuStat {
        vendor:       "jetson".to_string(),
        name:         "Tegra GPU".to_string(),
        util_pct:     final_util,
        mem_used_mb:  None,
        mem_total_mb: None,
        temp_c,
        power_w:      None,
        note:         if util_pct.is_none() && final_util.is_none() {
            Some("GPU load path not available on this Jetson firmware".to_string())
        } else { None },
    })
}

fn parse_rpi_gpu(vcgencmd_temp: &str) -> Option<GpuStat> {
    // "temp=47.2'C"
    let temp_c = vcgencmd_temp.find("temp=")
        .and_then(|i| vcgencmd_temp[i+5..].split('\'').next()?.parse::<f64>().ok());
    Some(GpuStat {
        vendor:       "rpi".to_string(),
        name:         "VideoCore GPU".to_string(),
        util_pct:     None,
        mem_used_mb:  None,
        mem_total_mb: None,
        temp_c,
        power_w:      None,
        note:         Some("RPi GPU utilisation not exposed by vcgencmd".to_string()),
    })
}

fn parse_rocm_smi(raw: &str) -> Vec<GpuStat> {
    // rocm-smi --showuse --showmemuse --showtemp --csv
    // CSV: device, GPU use%, GPU memory use%, temp
    raw.lines().skip(1).filter(|l| !l.trim().is_empty()).map(|line| {
        let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
        GpuStat {
            vendor:       "amd".to_string(),
            name:         parts.first().map(|s| format!("AMD GPU {}", s)).unwrap_or_default(),
            util_pct:     parts.get(1).and_then(|s| s.trim_end_matches('%').parse().ok()),
            mem_used_mb:  None,
            mem_total_mb: None,
            temp_c:       parts.get(3).and_then(|s| s.parse().ok()),
            power_w:      None,
            note:         None,
        }
    }).collect()
}

fn parse_processes(raw: &str) -> Vec<ProcessEntry> {
    raw.lines().skip(1).take(15).filter_map(|line| {
        let parts: Vec<&str> = line.splitn(11, ' ')
            .filter(|s| !s.is_empty()).collect();
        if parts.len() < 11 { return None; }
        Some(ProcessEntry {
            pid:     parts[1].parse().unwrap_or(0),
            user:    parts[0].to_string(),
            cpu_pct: parts[2].parse().unwrap_or(0.0),
            mem_pct: parts[3].parse().unwrap_or(0.0),
            command: parts[10].chars().take(60).collect(),
        })
    }).collect()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// ── Main collection ───────────────────────────────────────────────────────────

pub fn collect(
    session: &Session,
    session_id: &str,
    state: &Arc<MetricsState>,
) -> Result<MetricsSnapshot, String> {
    session.set_blocking(true);

    // ── Get or probe capabilities ─────────────────────────────────────────────
    let caps = {
        let mut caps_map = state.caps.lock().unwrap();
        if !caps_map.contains_key(session_id) {
            let c = probe(session);
            caps_map.insert(session_id.to_string(), c);
        }
        caps_map.get(session_id).unwrap().clone()
    };

    // ── Gather raw data in one batch (minimise round-trips) ──────────────────
    let stat_raw  = if caps.proc_stat    { try_exec(session, "cat /proc/stat") }    else { String::new() };
    let mem_raw   = if caps.proc_meminfo { try_exec(session, "cat /proc/meminfo") } else { String::new() };
    let free_raw  = if caps.free_format != "none" && !caps.proc_meminfo {
        try_exec(session, "free -m")
    } else { String::new() };
    let df_raw    = if caps.has_df { try_exec(session, "df / 2>/dev/null || df -k / 2>/dev/null") } else { String::new() };
    let load_raw  = if caps.proc_loadavg { try_exec(session, "cat /proc/loadavg") } else { String::new() };
    let uptime_raw= if caps.proc_uptime  { try_exec(session, "cat /proc/uptime") }  else { String::new() };
    let net_raw   = if caps.proc_net_dev { try_exec(session, "cat /proc/net/dev") } else { String::new() };
    let disk_raw  = if caps.proc_diskstats { try_exec(session, "cat /proc/diskstats") } else { String::new() };

    // Thermal
    let (temps_raw, types_raw) = if caps.thermal_zone_count > 0 {
        (
            try_exec(session, "cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null"),
            try_exec(session, "cat /sys/class/thermal/thermal_zone*/type 2>/dev/null"),
        )
    } else {
        (String::new(), String::new())
    };

    // GPU
    let nvidia_raw = if caps.has_nvidia_smi {
        try_exec(session,
            "nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw \
             --format=csv,noheader,nounits 2>/dev/null")
    } else { String::new() };

    let jetson_load_raw = if caps.has_jetson_gpu_load {
        try_exec(session, "cat /sys/devices/gpu.0/load 2>/dev/null")
    } else { String::new() };

    // tegrastats: get one line non-interactively
    let tegrastats_raw = if caps.has_tegrastats {
        try_exec(session, "timeout 2 tegrastats 2>/dev/null | head -1")
    } else { String::new() };

    let vcgencmd_raw = if caps.has_vcgencmd {
        try_exec(session, "vcgencmd measure_temp 2>/dev/null")
    } else { String::new() };

    let rocm_raw = if caps.has_rocm_smi {
        try_exec(session, "rocm-smi --showuse --showmemuse --showtemp --csv 2>/dev/null")
    } else { String::new() };

    // Processes
    let ps_raw = if caps.has_ps {
        try_exec(session, "ps aux --sort=-%cpu 2>/dev/null || ps aux 2>/dev/null | sort -k3 -rn")
    } else { String::new() };

    // ── Get prev samples ──────────────────────────────────────────────────────
    let ts = now_ms();
    let prev = {
        let map = state.samples.lock().unwrap();
        map.get(session_id).cloned().unwrap_or_default()
    };
    let is_first_poll = prev.cpu_total == 0;

    // ── CPU ───────────────────────────────────────────────────────────────────
    let (cpu_percent, cpu_unavailable_reason, cores, new_cpu_total, new_cpu_idle, new_cores) =
        if !stat_raw.is_empty() {
            let (overall, core_stats) = parse_proc_stat(&stat_raw);
            if let Some((total, idle)) = overall {
                let pct = if !is_first_poll {
                    cpu_pct(prev.cpu_total, prev.cpu_idle, total, idle)
                } else { 0.0 };

                let cores: Vec<CoreStat> = core_stats.iter().enumerate()
                    .map(|(i, &(ctotal, cidle))| {
                        let cpct = if !is_first_poll && i < prev.cpu_cores.len() {
                            cpu_pct(prev.cpu_cores[i].0, prev.cpu_cores[i].1, ctotal, cidle)
                        } else { 0.0 };
                        CoreStat { index: i as u32, percent: cpct }
                    }).collect();

                (Some(pct), None, cores, total, idle, core_stats)
            } else {
                (None, Some("/proc/stat parse failed".to_string()), vec![], 0, 0, vec![])
            }
        } else {
            (None, Some("/proc/stat not available on this system".to_string()), vec![], 0, 0, vec![])
        };

    // ── Memory ────────────────────────────────────────────────────────────────
    let (mem_total_mb, mem_used_mb, mem_unavailable_reason) =
        if !mem_raw.is_empty() {
            match parse_proc_meminfo(&mem_raw) {
                Some((total, used)) => (Some(total), Some(used), None),
                None => (None, None, Some("/proc/meminfo parse failed".to_string())),
            }
        } else if caps.free_format == "modern" {
            match parse_free_modern(&free_raw) {
                Some((total, used)) => (Some(total), Some(used), None),
                None => (None, None, Some("free -m parse failed".to_string())),
            }
        } else if caps.free_format == "busybox" {
            match parse_free_busybox(&free_raw) {
                Some((total, used)) => (Some(total), Some(used), None),
                None => (None, None, Some("busybox free parse failed".to_string())),
            }
        } else {
            (None, None, Some("No memory tool available (try installing procps)".to_string()))
        };

    // ── Disk ──────────────────────────────────────────────────────────────────
    let (disk_used_pct, disk_used_gb, disk_total_gb, disk_unavailable_reason) =
        if !df_raw.is_empty() {
            match parse_df(&df_raw) {
                Some((pct, used, total)) => (Some(pct), Some(used), Some(total), None),
                None => (None, None, None, Some("df parse failed".to_string())),
            }
        } else {
            (None, None, None, Some("df not available".to_string()))
        };

    // ── Load / uptime ─────────────────────────────────────────────────────────
    let (load_avg_1, load_avg_5, load_avg_15) = parse_loadavg(&load_raw);
    let uptime_seconds = parse_uptime(&uptime_raw);

    // ── Network I/O ───────────────────────────────────────────────────────────
    let (net_ifaces, new_net_rx, new_net_tx) = if !net_raw.is_empty() {
        let cur = parse_proc_net_dev(&net_raw);
        let dt_s = if prev.net_ts > 0 { (ts - prev.net_ts) as f64 / 1000.0 } else { 1.0 };
        let ifaces: Vec<NetIface> = cur.iter().map(|(name, &(rx, tx))| {
            let prev_rx = prev.net_rx.get(name).copied().unwrap_or(rx);
            let prev_tx = prev.net_tx.get(name).copied().unwrap_or(tx);
            let rx_kbps = if !is_first_poll {
                rx.saturating_sub(prev_rx) as f64 / 1024.0 / dt_s
            } else { 0.0 };
            let tx_kbps = if !is_first_poll {
                tx.saturating_sub(prev_tx) as f64 / 1024.0 / dt_s
            } else { 0.0 };
            NetIface { name: name.clone(), rx_kbps, tx_kbps }
        }).filter(|i| i.rx_kbps > 0.0 || i.tx_kbps > 0.0 || !is_first_poll).collect();

        let new_rx: HashMap<String, u64> = cur.iter().map(|(k, &(rx, _))| (k.clone(), rx)).collect();
        let new_tx: HashMap<String, u64> = cur.iter().map(|(k, &(_, tx))| (k.clone(), tx)).collect();
        (ifaces, new_rx, new_tx)
    } else {
        (vec![], HashMap::new(), HashMap::new())
    };

    // ── Disk I/O ──────────────────────────────────────────────────────────────
    let (disk_io, new_disk_reads, new_disk_writes) = if !disk_raw.is_empty() {
        let cur = parse_proc_diskstats(&disk_raw);
        let dt_s = if prev.disk_ts > 0 { (ts - prev.disk_ts) as f64 / 1000.0 } else { 1.0 };
        let io: Vec<DiskIo> = cur.iter().map(|(name, &(reads, writes))| {
            let pr = prev.disk_reads.get(name).copied().unwrap_or(reads);
            let pw = prev.disk_writes.get(name).copied().unwrap_or(writes);
            // Sectors are 512 bytes → KB = sectors * 512 / 1024
            let r_kbps = if !is_first_poll {
                reads.saturating_sub(pr) as f64 * 0.5 / dt_s
            } else { 0.0 };
            let w_kbps = if !is_first_poll {
                writes.saturating_sub(pw) as f64 * 0.5 / dt_s
            } else { 0.0 };
            DiskIo { name: name.clone(), read_kbps: r_kbps, write_kbps: w_kbps }
        }).collect();

        let new_r: HashMap<String, u64> = cur.iter().map(|(k, &(r, _))| (k.clone(), r)).collect();
        let new_w: HashMap<String, u64> = cur.iter().map(|(k, &(_, w))| (k.clone(), w)).collect();
        (io, new_r, new_w)
    } else {
        (vec![], HashMap::new(), HashMap::new())
    };

    // ── Thermal ───────────────────────────────────────────────────────────────
    let thermal = if !temps_raw.is_empty() {
        parse_thermal_zones(&temps_raw, &types_raw)
    } else { vec![] };

    // ── GPUs ──────────────────────────────────────────────────────────────────
    let mut gpus: Vec<GpuStat> = Vec::new();

    if caps.has_nvidia_smi && !nvidia_raw.is_empty() {
        gpus.extend(parse_nvidia_smi(&nvidia_raw));
    }
    if caps.is_jetson && (caps.has_jetson_gpu_load || caps.has_tegrastats) {
        if let Some(g) = parse_jetson_gpu(&jetson_load_raw, &tegrastats_raw) {
            gpus.push(g);
        }
    }
    if caps.has_vcgencmd && !vcgencmd_raw.is_empty() {
        if let Some(g) = parse_rpi_gpu(&vcgencmd_raw) {
            gpus.push(g);
        }
    }
    if caps.has_rocm_smi && !rocm_raw.is_empty() {
        gpus.extend(parse_rocm_smi(&rocm_raw));
    }

    // ── Processes ─────────────────────────────────────────────────────────────
    let processes = if !ps_raw.is_empty() {
        parse_processes(&ps_raw)
    } else { vec![] };

    // ── Store new samples ─────────────────────────────────────────────────────
    {
        let mut map = state.samples.lock().unwrap();
        map.insert(session_id.to_string(), PrevSamples {
            cpu_total: new_cpu_total,
            cpu_idle:  new_cpu_idle,
            cpu_cores: new_cores,
            net_rx:    new_net_rx,
            net_tx:    new_net_tx,
            net_ts:    ts,
            disk_reads: new_disk_reads,
            disk_writes: new_disk_writes,
            disk_ts: ts,
        });
    }

    Ok(MetricsSnapshot {
        cpu_percent,
        cpu_unavailable_reason,
        mem_used_mb,
        mem_total_mb,
        mem_unavailable_reason,
        disk_used_pct,
        disk_used_gb,
        disk_total_gb,
        disk_unavailable_reason,
        load_avg_1,
        load_avg_5,
        load_avg_15,
        uptime_seconds,
        cores,
        net_ifaces,
        disk_io,
        thermal,
        gpus,
        processes,
        arch:   caps.arch.clone(),
        kernel: caps.kernel.clone(),
        model:  caps.model.clone(),
        is_first_poll,
    })
}

/// Force a re-probe on the next collect() call (e.g. after reconnect).
pub fn invalidate_caps(session_id: &str, state: &Arc<MetricsState>) {
    state.caps.lock().unwrap().remove(session_id);
    state.samples.lock().unwrap().remove(session_id);
}
