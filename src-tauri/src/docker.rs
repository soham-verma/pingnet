use serde::{Deserialize, Serialize};
use std::io::Read;
use crate::ssh::{SshState, get_conn};

// ── Public types sent over IPC ────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct DockerContainer {
    pub id: String,
    pub names: String,
    pub image: String,
    /// Raw docker state: "running" | "exited" | "paused" | "created" | "restarting" | "dead" | "removing"
    pub state: String,
    /// Human-readable status, e.g. "Up 2 hours", "Exited (0) 3 minutes ago"
    pub status: String,
    pub ports: String,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DockerComposeProject {
    pub name: String,
    pub status: String,
    pub config_files: String,
    pub services: Vec<DockerService>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct DockerService {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: String,
    pub status: String,
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/// Wrap a docker command with `printf '%s\n' '<pw>' | sudo -S` when a sudo password is provided.
/// When `sudo_password` is None the original command is returned unchanged.
fn with_sudo(cmd: &str, sudo_password: &Option<String>) -> String {
    match sudo_password {
        Some(pw) => format!("printf '%s\\n' {} | sudo -S {}", shell_quote(pw), cmd),
        None => cmd.to_string(),
    }
}

/// Detect whether stderr / combined output indicates a Docker permission error.
/// Returns true for the common "permission denied" message produced when the
/// user is not in the `docker` group and sudo is required.
fn is_permission_denied(output: &str) -> bool {
    let lower = output.to_lowercase();
    lower.contains("permission denied")
        || lower.contains("got permission denied while trying to connect")
        || lower.contains("connect: permission denied")
}

/// Strip sudo's interactive password prompt from captured output.
/// When running `echo pw | sudo -S cmd 2>&1`, sudo writes
/// "[sudo] password for <user>: " to stderr before executing.
/// After redirection that line appears in stdout — remove it so the
/// caller only sees the real command output.
fn strip_sudo_prompt(s: &str) -> String {
    s.lines()
        .filter(|line| !line.trim_start().starts_with("[sudo] password for"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Run a command over SSH, returning (stdout, stderr, exit_code).
fn exec_cmd(session: &ssh2::Session, cmd: &str) -> Result<(String, String, i32), String> {
    let mut ch = session.channel_session().map_err(|e| e.to_string())?;
    ch.exec(cmd).map_err(|e| e.to_string())?;
    let mut stdout = String::new();
    ch.read_to_string(&mut stdout).map_err(|e| e.to_string())?;
    let mut stderr = String::new();
    ch.stderr().read_to_string(&mut stderr).ok();
    let _ = ch.close();
    let exit = ch.exit_status().unwrap_or(-1);
    Ok((stdout, stderr, exit))
}

/// Wrap a string in single quotes for safe shell embedding.
/// Single quotes in the value are escaped using the 'foo'"'"'bar' technique.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Validate a container/service/project identifier.
/// Only allows chars safe to embed in a shell command after shell_quote.
/// (shell_quote handles escaping, but we still reject suspicious inputs.)
fn validate_id(s: &str, label: &str) -> Result<String, String> {
    if s.is_empty() || s.len() > 256 {
        return Err(format!("{}: must be 1–256 characters", label));
    }
    // Allow alphanumeric, dash, underscore, dot — typical for container/service/project names
    if s.chars().all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.')) {
        Ok(s.to_string())
    } else {
        Err(format!("{}: contains invalid characters (allowed: a-z, A-Z, 0-9, -, _, .)", label))
    }
}

/// Validate an absolute filesystem path.
fn validate_path(s: &str, label: &str) -> Result<String, String> {
    if s.is_empty() || s.len() > 4096 {
        return Err(format!("{}: must be 1–4096 characters", label));
    }
    if !s.starts_with('/') {
        return Err(format!("{}: must be an absolute path", label));
    }
    if s.chars().all(|c| c.is_alphanumeric() || matches!(c, '/' | '.' | '-' | '_')) {
        Ok(s.to_string())
    } else {
        Err(format!("{}: contains invalid characters", label))
    }
}

// ── docker ps ────────────────────────────────────────────────────────────────

#[derive(Deserialize, Default)]
struct RawDockerPs {
    #[serde(rename = "ID", default)]
    id: String,
    #[serde(rename = "Names", default)]
    names: String,
    #[serde(rename = "Image", default)]
    image: String,
    #[serde(rename = "State", default)]
    state: String,
    #[serde(rename = "Status", default)]
    status: String,
    #[serde(rename = "Ports", default)]
    ports: String,
    #[serde(rename = "CreatedAt", default)]
    created_at: String,
}

/// List all Docker containers (running and stopped).
#[tauri::command]
pub async fn docker_list_containers(
    state: tauri::State<'_, SshState>,
    session_id: String,
    sudo_password: Option<String>,
) -> Result<Vec<DockerContainer>, String> {
    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap();
        let cmd = with_sudo("docker ps -a --format '{{json .}}' 2>/dev/null", &sudo_password);
        let (stdout, stderr, exit) = exec_cmd(&session, &cmd)?;
        if exit != 0 && is_permission_denied(&stderr) {
            return Err("PERMISSION_DENIED".to_string());
        }
        let stdout = strip_sudo_prompt(&stdout);
        let mut containers = Vec::new();
        for line in stdout.lines() {
            let line = line.trim();
            if line.is_empty() { continue; }
            if let Ok(raw) = serde_json::from_str::<RawDockerPs>(line) {
                containers.push(DockerContainer {
                    id: raw.id,
                    names: raw.names,
                    image: raw.image,
                    state: raw.state,
                    status: raw.status,
                    ports: raw.ports,
                    created_at: raw.created_at,
                });
            }
        }
        Ok(containers)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── docker <action> <container> ───────────────────────────────────────────────

/// Perform a lifecycle action on a single container.
/// Allowed actions: "start" | "stop" | "restart" | "pause" | "unpause" | "remove"
#[tauri::command]
pub async fn docker_container_action(
    state: tauri::State<'_, SshState>,
    session_id: String,
    container_id: String,
    action: String,
    sudo_password: Option<String>,
) -> Result<String, String> {
    let container_id = validate_id(&container_id, "container_id")?;

    // Map action to docker CLI subcommand — never pass raw action string to shell.
    let base_cmd = match action.as_str() {
        "start"   => format!("docker start {}", shell_quote(&container_id)),
        "stop"    => format!("docker stop {}", shell_quote(&container_id)),
        "restart" => format!("docker restart {}", shell_quote(&container_id)),
        "pause"   => format!("docker pause {}", shell_quote(&container_id)),
        "unpause" => format!("docker unpause {}", shell_quote(&container_id)),
        "remove"  => format!("docker rm -f {}", shell_quote(&container_id)),
        other     => return Err(format!("Unknown container action: {}", other)),
    };
    let docker_cmd = with_sudo(&base_cmd, &sudo_password);

    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap();
        let (stdout, stderr, exit) = exec_cmd(&session, &docker_cmd)?;
        let stdout = strip_sudo_prompt(&stdout);
        let output = if stdout.trim().is_empty() { stderr.clone() } else { stdout };
        if exit != 0 {
            if is_permission_denied(&output) || is_permission_denied(&stderr) {
                return Err("PERMISSION_DENIED".to_string());
            }
            Err(output.trim().to_string())
        } else {
            Ok(output.trim().to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── docker logs ───────────────────────────────────────────────────────────────

/// Fetch the last `lines` lines of logs for a container.
/// `since_secs`: if > 0, only return logs since that many seconds ago.
#[tauri::command]
pub async fn docker_logs_tail(
    state: tauri::State<'_, SshState>,
    session_id: String,
    container_id: String,
    lines: u32,
    since_secs: u32,
    sudo_password: Option<String>,
) -> Result<String, String> {
    let container_id = validate_id(&container_id, "container_id")?;
    // Cap lines to avoid huge payloads
    let lines = lines.min(5000);

    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap();
        let since_flag = if since_secs > 0 {
            format!("--since {}s ", since_secs)
        } else {
            String::new()
        };
        let tail_flag = if lines == 0 { "all".to_string() } else { lines.to_string() };
        let base_cmd = format!(
            "docker logs --tail {} {}--timestamps {} 2>&1",
            tail_flag,
            since_flag,
            shell_quote(&container_id)
        );
        let cmd = with_sudo(&base_cmd, &sudo_password);
        let (stdout, stderr, exit) = exec_cmd(&session, &cmd)?;
        if exit != 0 && is_permission_denied(&stderr) {
            return Err("PERMISSION_DENIED".to_string());
        }
        Ok(strip_sudo_prompt(&stdout))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── docker compose ls ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct RawComposeProject {
    #[serde(rename = "Name", default)]
    name: String,
    #[serde(rename = "Status", default)]
    status: String,
    #[serde(rename = "ConfigFiles", default)]
    config_files: String,
}

#[derive(Deserialize, Default)]
struct RawComposeService {
    #[serde(rename = "ID", default)]
    id: String,
    #[serde(rename = "Name", default)]
    name: String,
    #[serde(rename = "Image", default)]
    image: String,
    #[serde(rename = "State", default)]
    state: String,
    #[serde(rename = "Status", default)]
    status: String,
}

/// List all Docker Compose projects and their services.
/// Requires Docker Compose v2 (`docker compose` plugin).
#[tauri::command]
pub async fn docker_compose_list(
    state: tauri::State<'_, SshState>,
    session_id: String,
    sudo_password: Option<String>,
) -> Result<Vec<DockerComposeProject>, String> {
    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap();

        // List compose projects
        let ls_base = "docker compose ls --format json --all 2>/dev/null";
        let (ls_out_raw, ls_err, exit) = exec_cmd(&session, &with_sudo(ls_base, &sudo_password))?;
        if exit != 0 {
            if is_permission_denied(&ls_err) {
                return Err("PERMISSION_DENIED".to_string());
            }
            // docker compose not available or no projects
            return Ok(Vec::new());
        }
        let ls_out = strip_sudo_prompt(&ls_out_raw);
        if ls_out.trim().is_empty() {
            return Ok(Vec::new());
        }

        let raw_projects: Vec<RawComposeProject> =
            serde_json::from_str(ls_out.trim()).unwrap_or_default();

        let mut projects = Vec::new();
        for rp in raw_projects {
            // Validate the project name before embedding in a command
            let safe_name = match validate_id(&rp.name, "project name") {
                Ok(n) => n,
                Err(_) => continue,
            };

            // Get services for this project
            let svc_base = format!(
                "docker compose -p {} ps --format '{{{{json .}}}}' --all 2>/dev/null",
                shell_quote(&safe_name)
            );
            let svc_cmd = with_sudo(&svc_base, &sudo_password);
            let (svc_out_raw, _, _) = exec_cmd(&session, &svc_cmd)
                .unwrap_or_else(|_| (String::new(), String::new(), 1));
            let svc_out = strip_sudo_prompt(&svc_out_raw);

            let mut services = Vec::new();
            for line in svc_out.lines() {
                let line = line.trim();
                if line.is_empty() { continue; }
                if let Ok(raw) = serde_json::from_str::<RawComposeService>(line) {
                    services.push(DockerService {
                        id: raw.id,
                        name: raw.name,
                        image: raw.image,
                        state: raw.state,
                        status: raw.status,
                    });
                }
            }

            projects.push(DockerComposeProject {
                name: rp.name,
                status: rp.status,
                config_files: rp.config_files,
                services,
            });
        }
        Ok(projects)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── docker compose <action> ───────────────────────────────────────────────────

/// Run a Docker Compose action on a project (identified by name or compose file).
///
/// `project_name`: the compose project name (for `-p` flag). Takes priority if non-empty.
/// `compose_file`: absolute path to compose file (for `-f` flag). Used if project_name is empty.
/// `service`: optional service name to scope the action. Empty = all services.
/// `action`: one of the allowed action strings mapped below.
#[tauri::command]
pub async fn docker_compose_action(
    state: tauri::State<'_, SshState>,
    session_id: String,
    project_name: String,
    compose_file: String,
    service: String,
    action: String,
    sudo_password: Option<String>,
) -> Result<String, String> {
    // Build the "docker compose <selector>" prefix
    let selector = if !project_name.is_empty() {
        let safe = validate_id(&project_name, "project_name")?;
        format!("docker compose -p {}", shell_quote(&safe))
    } else if !compose_file.is_empty() {
        let safe = validate_path(&compose_file, "compose_file")?;
        format!("docker compose -f {}", shell_quote(&safe))
    } else {
        return Err("Either project_name or compose_file must be provided".to_string());
    };

    // Optional service scope
    let service_arg = if !service.is_empty() {
        let safe = validate_id(&service, "service")?;
        format!(" {}", shell_quote(&safe))
    } else {
        String::new()
    };

    // Map action to safe compose subcommands
    let subcommand = match action.as_str() {
        "up"              => format!("up -d{}", service_arg),
        "up-build"        => format!("up -d --build{}", service_arg),
        "down"            => "down".to_string(),
        "down-volumes"    => "down -v".to_string(),
        "start"           => format!("start{}", service_arg),
        "stop"            => format!("stop{}", service_arg),
        "restart"         => format!("restart{}", service_arg),
        "build"           => format!("build{}", service_arg),
        "build-no-cache"  => format!("build --no-cache{}", service_arg),
        "rebuild"         => format!("up -d --force-recreate --build{}", service_arg),
        "pull"            => format!("pull{}", service_arg),
        "logs"            => format!("logs --tail=200{}", service_arg),
        other             => return Err(format!("Unknown compose action: {}", other)),
    };

    let base_cmd = format!("{} {} 2>&1", selector, subcommand);

    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap();
        let cmd = with_sudo(&base_cmd, &sudo_password);
        let (stdout_raw, stderr, exit) = exec_cmd(&session, &cmd)?;
        let stdout = strip_sudo_prompt(&stdout_raw);
        if exit != 0 {
            if is_permission_denied(&stdout) || is_permission_denied(&stderr) {
                return Err("PERMISSION_DENIED".to_string());
            }
            // Combine stdout + stderr so the full error is visible to the user
            let combined = format!("{}\n{}", stdout.trim(), stderr.trim()).trim().to_string();
            return Err(if combined.is_empty() {
                format!("Command exited with status {}", exit)
            } else {
                combined
            });
        }
        Ok(stdout)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── docker prune ─────────────────────────────────────────────────────────────

/// Prune Docker resources.
/// `target`: "containers" | "images" | "images-all" | "volumes" | "networks" | "build-cache" | "system" | "system-volumes"
#[tauri::command]
pub async fn docker_prune(
    state: tauri::State<'_, SshState>,
    session_id: String,
    target: String,
    sudo_password: Option<String>,
) -> Result<String, String> {
    let base = match target.as_str() {
        "containers"     => "docker container prune -f",
        "images"         => "docker image prune -f",
        "images-all"     => "docker image prune -a -f",
        "volumes"        => "docker volume prune -f",
        "networks"       => "docker network prune -f",
        "build-cache"    => "docker builder prune -f",
        "system"         => "docker system prune -f",
        "system-volumes" => "docker system prune -f --volumes",
        other            => return Err(format!("Unknown prune target: {}", other)),
    };
    let base_full = format!("{} 2>&1", base);

    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap();
        let cmd = with_sudo(&base_full, &sudo_password);
        let (stdout_raw, stderr, exit) = exec_cmd(&session, &cmd)?;
        if exit != 0 && (is_permission_denied(&stdout_raw) || is_permission_denied(&stderr)) {
            return Err("PERMISSION_DENIED".to_string());
        }
        Ok(strip_sudo_prompt(&stdout_raw))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── docker system df ─────────────────────────────────────────────────────────

/// Return `docker system df` output (disk usage summary).
#[tauri::command]
pub async fn docker_system_df(
    state: tauri::State<'_, SshState>,
    session_id: String,
    sudo_password: Option<String>,
) -> Result<String, String> {
    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap();
        let cmd = with_sudo("docker system df 2>&1", &sudo_password);
        let (stdout_raw, stderr, exit) = exec_cmd(&session, &cmd)?;
        if exit != 0 && (is_permission_denied(&stdout_raw) || is_permission_denied(&stderr)) {
            return Err("PERMISSION_DENIED".to_string());
        }
        let stdout = strip_sudo_prompt(&stdout_raw);
        let out = if stdout.trim().is_empty() { stderr } else { stdout };
        if exit != 0 && out.trim().is_empty() {
            Err("docker system df failed or docker is not available".to_string())
        } else {
            Ok(out)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Shared exec helper ────────────────────────────────────────────────────────

/// Run a docker command and return stdout on success, or a permission / error string.
fn run_docker(session: &ssh2::Session, base_cmd: &str, sudo_password: &Option<String>) -> Result<String, String> {
    let cmd = with_sudo(&format!("{} 2>&1", base_cmd), sudo_password);
    let (stdout_raw, stderr, exit) = exec_cmd(session, &cmd)?;
    let stdout = strip_sudo_prompt(&stdout_raw);
    if exit != 0 {
        if is_permission_denied(&stdout) || is_permission_denied(&stderr) {
            return Err("PERMISSION_DENIED".to_string());
        }
        let combined = format!("{}\n{}", stdout.trim(), stderr.trim()).trim().to_string();
        return Err(if combined.is_empty() {
            format!("Command exited with status {}", exit)
        } else {
            combined
        });
    }
    Ok(stdout)
}

/// Validate a Docker image reference (repo:tag, digest, or ID prefix).
fn validate_image_ref(s: &str, label: &str) -> Result<String, String> {
    if s.is_empty() || s.len() > 512 {
        return Err(format!("{}: must be 1–512 characters", label));
    }
    if s.chars().all(|c| {
        c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | ':' | '@')
    }) {
        Ok(s.to_string())
    } else {
        Err(format!("{}: contains invalid characters", label))
    }
}

// ── Volumes ───────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct DockerVolume {
    pub name: String,
    pub driver: String,
    pub mountpoint: String,
}

#[derive(Deserialize, Default)]
struct RawDockerVolume {
    #[serde(rename = "Name", default)]
    name: String,
    #[serde(rename = "Driver", default)]
    driver: String,
    #[serde(rename = "Mountpoint", default)]
    mountpoint: String,
}

#[tauri::command]
pub async fn docker_list_volumes(
    state: tauri::State<'_, SshState>,
    session_id: String,
    sudo_password: Option<String>,
) -> Result<Vec<DockerVolume>, String> {
    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap();
        let out = run_docker(&session, "docker volume ls --format '{{json .}}'", &sudo_password)?;
        let mut volumes = Vec::new();
        for line in out.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Ok(raw) = serde_json::from_str::<RawDockerVolume>(line) {
                volumes.push(DockerVolume {
                    name: raw.name,
                    driver: raw.driver,
                    mountpoint: raw.mountpoint,
                });
            }
        }
        Ok(volumes)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn docker_volume_inspect(
    state: tauri::State<'_, SshState>,
    session_id: String,
    name: String,
    sudo_password: Option<String>,
) -> Result<String, String> {
    let name = validate_id(&name, "volume name")?;
    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap();
        run_docker(
            &session,
            &format!("docker volume inspect {}", shell_quote(&name)),
            &sudo_password,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn docker_volume_create(
    state: tauri::State<'_, SshState>,
    session_id: String,
    name: String,
    driver: String,
    sudo_password: Option<String>,
) -> Result<String, String> {
    let name = validate_id(&name, "volume name")?;
    let base_cmd = if driver.trim().is_empty() {
        format!("docker volume create {}", shell_quote(&name))
    } else {
        let d = validate_id(&driver, "driver")?;
        format!(
            "docker volume create --driver {} {}",
            shell_quote(&d),
            shell_quote(&name)
        )
    };
    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap();
        run_docker(&session, &base_cmd, &sudo_password)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn docker_volume_remove(
    state: tauri::State<'_, SshState>,
    session_id: String,
    name: String,
    sudo_password: Option<String>,
) -> Result<String, String> {
    let name = validate_id(&name, "volume name")?;
    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap();
        run_docker(
            &session,
            &format!("docker volume rm {}", shell_quote(&name)),
            &sudo_password,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Networks ──────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct DockerNetwork {
    pub id: String,
    pub name: String,
    pub driver: String,
    pub scope: String,
}

#[derive(Deserialize, Default)]
struct RawDockerNetwork {
    #[serde(rename = "ID", default)]
    id: String,
    #[serde(rename = "Name", default)]
    name: String,
    #[serde(rename = "Driver", default)]
    driver: String,
    #[serde(rename = "Scope", default)]
    scope: String,
}

#[tauri::command]
pub async fn docker_list_networks(
    state: tauri::State<'_, SshState>,
    session_id: String,
    sudo_password: Option<String>,
) -> Result<Vec<DockerNetwork>, String> {
    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap();
        let out = run_docker(&session, "docker network ls --format '{{json .}}'", &sudo_password)?;
        let mut networks = Vec::new();
        for line in out.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Ok(raw) = serde_json::from_str::<RawDockerNetwork>(line) {
                networks.push(DockerNetwork {
                    id: raw.id,
                    name: raw.name,
                    driver: raw.driver,
                    scope: raw.scope,
                });
            }
        }
        Ok(networks)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn docker_network_inspect(
    state: tauri::State<'_, SshState>,
    session_id: String,
    name: String,
    sudo_password: Option<String>,
) -> Result<String, String> {
    let name = validate_id(&name, "network name")?;
    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap();
        run_docker(
            &session,
            &format!("docker network inspect {}", shell_quote(&name)),
            &sudo_password,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn docker_network_create(
    state: tauri::State<'_, SshState>,
    session_id: String,
    name: String,
    driver: String,
    sudo_password: Option<String>,
) -> Result<String, String> {
    let name = validate_id(&name, "network name")?;
    let base_cmd = if driver.trim().is_empty() {
        format!("docker network create {}", shell_quote(&name))
    } else {
        let d = validate_id(&driver, "driver")?;
        format!(
            "docker network create --driver {} {}",
            shell_quote(&d),
            shell_quote(&name)
        )
    };
    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap();
        run_docker(&session, &base_cmd, &sudo_password)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn docker_network_remove(
    state: tauri::State<'_, SshState>,
    session_id: String,
    name: String,
    sudo_password: Option<String>,
) -> Result<String, String> {
    let name = validate_id(&name, "network name")?;
    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap();
        run_docker(
            &session,
            &format!("docker network rm {}", shell_quote(&name)),
            &sudo_password,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn docker_network_connect(
    state: tauri::State<'_, SshState>,
    session_id: String,
    network: String,
    container_id: String,
    sudo_password: Option<String>,
) -> Result<String, String> {
    let network = validate_id(&network, "network")?;
    let container_id = validate_id(&container_id, "container_id")?;
    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap();
        run_docker(
            &session,
            &format!(
                "docker network connect {} {}",
                shell_quote(&network),
                shell_quote(&container_id)
            ),
            &sudo_password,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn docker_network_disconnect(
    state: tauri::State<'_, SshState>,
    session_id: String,
    network: String,
    container_id: String,
    sudo_password: Option<String>,
) -> Result<String, String> {
    let network = validate_id(&network, "network")?;
    let container_id = validate_id(&container_id, "container_id")?;
    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap();
        run_docker(
            &session,
            &format!(
                "docker network disconnect -f {} {}",
                shell_quote(&network),
                shell_quote(&container_id)
            ),
            &sudo_password,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Images ────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct DockerImage {
    pub id: String,
    pub repository: String,
    pub tag: String,
    pub size: String,
    pub created_at: String,
}

#[derive(Deserialize, Default)]
struct RawDockerImage {
    #[serde(rename = "ID", default)]
    id: String,
    #[serde(rename = "Repository", default)]
    repository: String,
    #[serde(rename = "Tag", default)]
    tag: String,
    #[serde(rename = "Size", default)]
    size: String,
    #[serde(rename = "CreatedAt", default)]
    created_at: String,
}

#[tauri::command]
pub async fn docker_list_images(
    state: tauri::State<'_, SshState>,
    session_id: String,
    sudo_password: Option<String>,
) -> Result<Vec<DockerImage>, String> {
    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap();
        let out = run_docker(&session, "docker images --format '{{json .}}'", &sudo_password)?;
        let mut images = Vec::new();
        for line in out.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Ok(raw) = serde_json::from_str::<RawDockerImage>(line) {
                images.push(DockerImage {
                    id: raw.id,
                    repository: raw.repository,
                    tag: raw.tag,
                    size: raw.size,
                    created_at: raw.created_at,
                });
            }
        }
        Ok(images)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn docker_image_inspect(
    state: tauri::State<'_, SshState>,
    session_id: String,
    image_ref: String,
    sudo_password: Option<String>,
) -> Result<String, String> {
    let image_ref = validate_image_ref(&image_ref, "image")?;
    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap();
        run_docker(
            &session,
            &format!("docker image inspect {}", shell_quote(&image_ref)),
            &sudo_password,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn docker_image_pull(
    state: tauri::State<'_, SshState>,
    session_id: String,
    image_ref: String,
    sudo_password: Option<String>,
) -> Result<String, String> {
    let image_ref = validate_image_ref(&image_ref, "image")?;
    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap();
        run_docker(
            &session,
            &format!("docker pull {}", shell_quote(&image_ref)),
            &sudo_password,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn docker_image_remove(
    state: tauri::State<'_, SshState>,
    session_id: String,
    image_ref: String,
    force: bool,
    sudo_password: Option<String>,
) -> Result<String, String> {
    let image_ref = validate_image_ref(&image_ref, "image")?;
    let force_flag = if force { " -f" } else { "" };
    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap();
        run_docker(
            &session,
            &format!("docker rmi{} {}", force_flag, shell_quote(&image_ref)),
            &sudo_password,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Container rebuild ─────────────────────────────────────────────────────────

/// Build a `docker run -d …` command from `docker inspect` JSON.
pub(crate) fn build_run_from_inspect(v: &serde_json::Value) -> Result<String, String> {
    let config = v.get("Config").ok_or("inspect: missing Config")?;
    let host_config = v.get("HostConfig").ok_or("inspect: missing HostConfig")?;

    let image = config
        .get("Image")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .ok_or("inspect: missing image")?;

    let name = v
        .get("Name")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim_start_matches('/');

    let mut parts = vec!["docker run -d".to_string()];

    if !name.is_empty() {
        parts.push(format!("--name {}", shell_quote(name)));
    }

    if let Some(env_arr) = config.get("Env").and_then(|x| x.as_array()) {
        for e in env_arr {
            if let Some(s) = e.as_str() {
                parts.push(format!("-e {}", shell_quote(s)));
            }
        }
    }

    if let Some(bindings) = host_config.get("PortBindings").and_then(|x| x.as_object()) {
        for (container_port, hosts) in bindings {
            if let Some(arr) = hosts.as_array() {
                for binding in arr {
                    let host_ip = binding.get("HostIp").and_then(|x| x.as_str()).unwrap_or("");
                    let host_port = binding.get("HostPort").and_then(|x| x.as_str()).unwrap_or("");
                    if host_port.is_empty() {
                        continue;
                    }
                    let cp = container_port
                        .trim_end_matches("/tcp")
                        .trim_end_matches("/udp")
                        .trim_end_matches("/sctp");
                    let mapping = if host_ip.is_empty() {
                        format!("{}:{}", host_port, cp)
                    } else {
                        format!("{}:{}:{}", host_ip, host_port, cp)
                    };
                    parts.push(format!("-p {}", shell_quote(&mapping)));
                }
            }
        }
    }

    if let Some(mounts) = v.get("Mounts").and_then(|x| x.as_array()) {
        for m in mounts {
            let typ = m.get("Type").and_then(|x| x.as_str()).unwrap_or("");
            let dest = m.get("Destination").and_then(|x| x.as_str()).unwrap_or("");
            if dest.is_empty() {
                continue;
            }
            match typ {
                "bind" => {
                    if let Some(src) = m.get("Source").and_then(|x| x.as_str()) {
                        let ro = m.get("RW").and_then(|x| x.as_bool()) == Some(false);
                        let spec = if ro {
                            format!("{}:{}:ro", src, dest)
                        } else {
                            format!("{}:{}", src, dest)
                        };
                        parts.push(format!("-v {}", shell_quote(&spec)));
                    }
                }
                "volume" => {
                    if let Some(vol) = m.get("Name").and_then(|x| x.as_str()) {
                        parts.push(format!("-v {}", shell_quote(&format!("{}:{}", vol, dest))));
                    }
                }
                _ => {}
            }
        }
    } else if let Some(binds) = host_config.get("Binds").and_then(|x| x.as_array()) {
        for b in binds {
            if let Some(s) = b.as_str() {
                parts.push(format!("-v {}", shell_quote(s)));
            }
        }
    }

    if let Some(rp) = host_config.get("RestartPolicy") {
        if let Some(rp_name) = rp.get("Name").and_then(|x| x.as_str()) {
            if !rp_name.is_empty() && rp_name != "no" {
                parts.push(format!("--restart {}", shell_quote(rp_name)));
            }
        }
    }

    if let Some(network_mode) = host_config.get("NetworkMode").and_then(|x| x.as_str()) {
        if network_mode != "default"
            && network_mode != "bridge"
            && !network_mode.starts_with("container:")
        {
            parts.push(format!("--network {}", shell_quote(network_mode)));
        }
    }

    if host_config.get("Privileged").and_then(|x| x.as_bool()) == Some(true) {
        parts.push("--privileged".to_string());
    }

    parts.push(shell_quote(image));

    if let Some(cmd) = config.get("Cmd").and_then(|x| x.as_array()) {
        if !cmd.is_empty() {
            for c in cmd {
                if let Some(s) = c.as_str() {
                    parts.push(shell_quote(s));
                }
            }
        }
    }

    Ok(parts.join(" "))
}

/// Detect compose project + service from container inspect labels.
pub(crate) fn compose_labels_from_inspect(v: &serde_json::Value) -> Option<(String, String)> {
    let labels = v.get("Config")?.get("Labels")?.as_object()?;
    let project = labels
        .get("com.docker.compose.project")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())?
        .to_string();
    let service = labels
        .get("com.docker.compose.service")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())?
        .to_string();
    Some((project, service))
}

#[tauri::command]
pub async fn docker_container_rebuild(
    state: tauri::State<'_, SshState>,
    session_id: String,
    container_id: String,
    sudo_password: Option<String>,
) -> Result<String, String> {
    let container_id = validate_id(&container_id, "container_id")?;
    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap();

        let inspect_cmd = format!(
            "docker inspect {} --format '{{{{json .}}}}'",
            shell_quote(&container_id)
        );
        let inspect_out = run_docker(&session, &inspect_cmd, &sudo_password)?;
        let inspect_json: serde_json::Value =
            serde_json::from_str(inspect_out.trim()).map_err(|e| format!("parse inspect: {}", e))?;
        let inspect = inspect_json
            .as_array()
            .and_then(|a| a.first())
            .ok_or("inspect: empty result")?;

        if let Some((project, service)) = compose_labels_from_inspect(inspect) {
            let safe_project = validate_id(&project, "compose project")?;
            let safe_service = validate_id(&service, "compose service")?;
            let cmd = format!(
                "docker compose -p {} up -d --force-recreate --build {}",
                shell_quote(&safe_project),
                shell_quote(&safe_service)
            );
            let out = run_docker(&session, &cmd, &sudo_password)?;
            return Ok(format!(
                "Rebuilt via compose (project={}, service={}):\n{}",
                safe_project, safe_service, out
            ));
        }

        let run_cmd = build_run_from_inspect(inspect)?;
        run_docker(
            &session,
            &format!("docker stop {}", shell_quote(&container_id)),
            &sudo_password,
        )?;
        run_docker(
            &session,
            &format!("docker rm {}", shell_quote(&container_id)),
            &sudo_password,
        )?;
        let out = run_docker(&session, &run_cmd, &sudo_password)?;
        Ok(format!("Rebuilt container:\n{}\n\n{}", run_cmd, out))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod rebuild_tests {
    use super::{build_run_from_inspect, compose_labels_from_inspect};
    use serde_json::json;

    #[test]
    fn build_run_basic_image_and_name() {
        let inspect = json!([{
            "Name": "/myapp",
            "Config": { "Image": "nginx:latest", "Env": ["FOO=bar"], "Cmd": [] },
            "HostConfig": { "RestartPolicy": { "Name": "always" }, "NetworkMode": "bridge" },
            "Mounts": []
        }]);
        let v = inspect.as_array().unwrap().first().unwrap();
        let cmd = build_run_from_inspect(v).unwrap();
        assert!(cmd.contains("docker run -d"));
        assert!(cmd.contains("--name 'myapp'"));
        assert!(cmd.contains("-e 'FOO=bar'"));
        assert!(cmd.contains("--restart 'always'"));
        assert!(cmd.contains("'nginx:latest'"));
    }

    #[test]
    fn compose_labels_detected() {
        let inspect = json!({
            "Config": {
                "Labels": {
                    "com.docker.compose.project": "myproj",
                    "com.docker.compose.service": "web"
                }
            }
        });
        let (p, s) = compose_labels_from_inspect(&inspect).unwrap();
        assert_eq!(p, "myproj");
        assert_eq!(s, "web");
    }
}
