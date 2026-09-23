use serde::{Deserialize, Serialize};
use crate::ssh::{SshState, get_conn};
use std::path::Path;
use std::time::Duration;

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

/// Wrap a docker command for sudo; the password travels on stdin (see remote.rs).
fn with_sudo(cmd: &str, sudo_password: &Option<String>) -> RemoteCmd {
    crate::remote::sudo_cmd(cmd, sudo_password)
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
/// When running `sudo -S cmd 2>&1`, older sudo builds may still write
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
fn exec_cmd(session: &ssh2::Session, rc: &RemoteCmd) -> Result<(String, String, i32), String> {
    crate::remote::run(session, rc, false)
}

use crate::remote::{shell_quote, RemoteCmd};

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
    // Always embedded via shell_quote; only reject control characters
    if s.chars().any(|c| c.is_control()) {
        Err(format!("{}: contains invalid characters", label))
    } else {
        Ok(s.to_string())
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
        let session = conn.sftp_session.lock().unwrap_or_else(|e| e.into_inner());
        list_containers(&session, &sudo_password)
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn list_containers(session: &ssh2::Session, sudo_password: &Option<String>) -> Result<Vec<DockerContainer>, String> {
    // stderr is kept (not sent to /dev/null) so permission / daemon errors
    // surface instead of looking like an empty inventory (audit BUG-014)
    let cmd = with_sudo("docker ps -a --format '{{json .}}'", sudo_password);
    let (stdout, stderr, exit) = exec_cmd(session, &cmd)?;
    if exit != 0 {
        if is_permission_denied(&stderr) || is_permission_denied(&stdout) {
            return Err("PERMISSION_DENIED".to_string());
        }
        let msg = strip_sudo_prompt(&stderr).trim().to_string();
        return Err(if msg.is_empty() { format!("docker ps failed (exit status {})", exit) } else { msg });
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
    // Build the "docker compose <selector>" prefix. Named projects get their
    // config files resolved on the host (see resolve_compose_selector) —
    // `-p` alone can't find the files for up/build/pull (audit BUG-008).
    let named_project = if !project_name.is_empty() {
        Some(validate_id(&project_name, "project_name")?)
    } else {
        None
    };
    let selector = if named_project.is_some() {
        String::new() // resolved on the host below
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

    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap_or_else(|e| e.into_inner());
        let selector = match &named_project {
            Some(p) => resolve_compose_selector(&session, p, &sudo_password, &action)?,
            None => selector,
        };
        let base_cmd = format!("{} {} 2>&1", selector, subcommand);
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

/// Actions that need the project's compose file (vs. ones that only act on
/// existing containers by project label).
fn compose_action_needs_files(action: &str) -> bool {
    matches!(action, "up" | "up-build" | "build" | "build-no-cache" | "rebuild" | "pull")
}

/// Build `docker compose -p NAME -f FILE…` for a discovered project by asking
/// the host where its config files live (`docker compose ls --all`).
fn resolve_compose_selector(
    session: &ssh2::Session,
    project: &str,
    sudo_password: &Option<String>,
    action: &str,
) -> Result<String, String> {
    let (out, _, _) = exec_cmd(session, &with_sudo("docker compose ls --all --format json", sudo_password))?;
    let projects: Vec<RawComposeProject> = serde_json::from_str(strip_sudo_prompt(&out).trim()).unwrap_or_default();
    let files: Vec<String> = projects
        .iter()
        .find(|p| p.name == project)
        .map(|p| split_config_files(&p.config_files))
        .unwrap_or_default();
    compose_selector(project, &files, None, compose_action_needs_files(action))
}

/// Compose reports ConfigFiles as a comma-separated list.
fn split_config_files(s: &str) -> Vec<String> {
    s.split(',').map(|f| f.trim().to_string()).filter(|f| !f.is_empty()).collect()
}

/// `docker compose -p P [-f F]… [--project-directory D]`, validating every part.
fn compose_selector(project: &str, files: &[String], project_dir: Option<&str>, needs_files: bool) -> Result<String, String> {
    let project = validate_id(project, "project")?;
    if files.is_empty() && needs_files {
        return Err(format!(
            "Couldn't find the compose file for project '{}' on the host. Use \"custom file\" with its path instead.",
            project
        ));
    }
    let mut sel = format!("docker compose -p {}", shell_quote(&project));
    for f in files {
        sel.push_str(&format!(" -f {}", shell_quote(&validate_path(f, "compose file")?)));
    }
    if let Some(d) = project_dir.filter(|d| !d.is_empty()) {
        sel.push_str(&format!(" --project-directory {}", shell_quote(&validate_path(d, "project directory")?)));
    }
    Ok(sel)
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
//
// Compose-managed containers are recreated through compose (with the project's
// own config files). Standalone containers are recreated from `docker inspect`
// with a backup + rollback so a failed replacement never loses the original
// (audit BUG-007 / BUG-019).

/// `docker inspect --format '{{json .}}'` prints one OBJECT per container;
/// plain `docker inspect` prints an ARRAY. Accept both.
pub(crate) fn first_inspect_object(raw: &str) -> Result<serde_json::Value, String> {
    let v: serde_json::Value = serde_json::from_str(raw.trim()).map_err(|e| format!("parse inspect: {}", e))?;
    match v {
        serde_json::Value::Array(mut a) if !a.is_empty() => Ok(a.swap_remove(0)),
        serde_json::Value::Object(_) => Ok(v),
        _ => Err("inspect: empty result".to_string()),
    }
}

/// Everything needed to recreate a standalone container.
#[derive(Debug, Default)]
pub(crate) struct RecreatePlan {
    pub name: String,
    pub image: String,
    /// Shell-quoted `docker run` options (no env — see env_lines)
    pub run_opts: Vec<String>,
    /// Shell-quoted image args (command) placed after the image
    pub args: Vec<String>,
    /// KEY=value lines for --env-file (kept out of the remote process list)
    pub env_lines: Vec<String>,
    /// Env values that can't go in an env-file (contain newlines) → -e
    pub env_inline: Vec<String>,
    /// Extra networks to connect after start: (network, aliases, ipv4)
    pub extra_networks: Vec<(String, Vec<String>, Option<String>)>,
}

fn s_arr(v: Option<&serde_json::Value>) -> Vec<String> {
    v.and_then(|x| x.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

fn dur_ns(v: Option<&serde_json::Value>) -> Option<String> {
    v.and_then(|x| x.as_i64()).filter(|n| *n > 0).map(|n| format!("{}ms", n / 1_000_000))
}

/// Build a recreation plan from `docker inspect` JSON, refusing settings it
/// can't reproduce faithfully rather than silently dropping them.
pub(crate) fn build_recreate_plan(v: &serde_json::Value) -> Result<RecreatePlan, String> {
    let config = v.get("Config").ok_or("inspect: missing Config")?;
    let hc = v.get("HostConfig").ok_or("inspect: missing HostConfig")?;
    let q = |s: &str| shell_quote(s);
    let mut p = RecreatePlan::default();

    p.image = config.get("Image").and_then(|x| x.as_str()).filter(|s| !s.is_empty())
        .ok_or("inspect: missing image")?.to_string();
    p.name = v.get("Name").and_then(|x| x.as_str()).unwrap_or("").trim_start_matches('/').to_string();
    if p.name.is_empty() {
        return Err("Container has no name — can't recreate it safely".to_string());
    }

    // ── Refuse what we can't reproduce ──
    let mut unsupported = Vec::new();
    if !s_arr(hc.get("VolumesFrom")).is_empty() { unsupported.push("--volumes-from"); }
    if !s_arr(hc.get("Links")).is_empty() { unsupported.push("legacy --link"); }
    if hc.get("DeviceRequests").and_then(|x| x.as_array()).map(|a| !a.is_empty()).unwrap_or(false) { unsupported.push("GPU/device requests"); }
    let net_mode = hc.get("NetworkMode").and_then(|x| x.as_str()).unwrap_or("default").to_string();
    if net_mode.starts_with("container:") { unsupported.push("--network container:…"); }
    if !unsupported.is_empty() {
        return Err(format!(
            "Can't recreate this container safely — it uses {}. Recreate it manually or with compose.",
            unsupported.join(", ")
        ));
    }

    let o = &mut p.run_opts;

    // ── Config ──
    if let Some(h) = config.get("Hostname").and_then(|x| x.as_str()) {
        let id = v.get("Id").and_then(|x| x.as_str()).unwrap_or("");
        // Docker defaults the hostname to the short container id — don't pin that
        if !h.is_empty() && !id.starts_with(h) && net_mode != "host" {
            o.push(format!("--hostname {}", q(h)));
        }
    }
    if let Some(d) = config.get("Domainname").and_then(|x| x.as_str()).filter(|s| !s.is_empty()) { o.push(format!("--domainname {}", q(d))); }
    if let Some(u) = config.get("User").and_then(|x| x.as_str()).filter(|s| !s.is_empty()) { o.push(format!("--user {}", q(u))); }
    if let Some(w) = config.get("WorkingDir").and_then(|x| x.as_str()).filter(|s| !s.is_empty()) { o.push(format!("--workdir {}", q(w))); }
    if let Some(sig) = config.get("StopSignal").and_then(|x| x.as_str()).filter(|s| !s.is_empty()) { o.push(format!("--stop-signal {}", q(sig))); }
    if config.get("Tty").and_then(|x| x.as_bool()) == Some(true) { o.push("-t".into()); }
    if config.get("OpenStdin").and_then(|x| x.as_bool()) == Some(true) { o.push("-i".into()); }
    if let Some(labels) = config.get("Labels").and_then(|x| x.as_object()) {
        let mut keys: Vec<&String> = labels.keys().collect();
        keys.sort();
        for k in keys {
            if let Some(val) = labels[k].as_str() {
                o.push(format!("--label {}", q(&format!("{}={}", k, val))));
            }
        }
    }
    for e in s_arr(config.get("Env")) {
        if e.contains('\n') { p.env_inline.push(e); } else { p.env_lines.push(e); }
    }
    if let Some(hcheck) = config.get("Healthcheck") {
        let test = s_arr(hcheck.get("Test"));
        match test.first().map(String::as_str) {
            Some("NONE") => o.push("--no-healthcheck".into()),
            Some("CMD-SHELL") if test.len() > 1 => o.push(format!("--health-cmd {}", q(&test[1]))),
            Some("CMD") if test.len() > 1 => {
                // CLI only takes a shell string; quote each argv element
                o.push(format!("--health-cmd {}", q(&test[1..].iter().map(|a| shell_quote(a)).collect::<Vec<_>>().join(" "))));
            }
            _ => {}
        }
        if let Some(d) = dur_ns(hcheck.get("Interval")) { o.push(format!("--health-interval {}", d)); }
        if let Some(d) = dur_ns(hcheck.get("Timeout")) { o.push(format!("--health-timeout {}", d)); }
        if let Some(d) = dur_ns(hcheck.get("StartPeriod")) { o.push(format!("--health-start-period {}", d)); }
        if let Some(r) = hcheck.get("Retries").and_then(|x| x.as_i64()).filter(|r| *r > 0) { o.push(format!("--health-retries {}", r)); }
    }

    // Entrypoint: --entrypoint takes one string; the rest precedes Cmd
    let entry = s_arr(config.get("Entrypoint"));
    let cmd = s_arr(config.get("Cmd"));
    if let Some((first, rest)) = entry.split_first() {
        o.push(format!("--entrypoint {}", q(first)));
        p.args.extend(rest.iter().map(|a| q(a)));
    }
    p.args.extend(cmd.iter().map(|a| q(a)));

    // ── HostConfig ──
    if let Some(bindings) = hc.get("PortBindings").and_then(|x| x.as_object()) {
        let mut ports: Vec<&String> = bindings.keys().collect();
        ports.sort();
        for container_port in ports {
            // keep the protocol: "53/udp" → "…:53/udp" (tcp is the default)
            let cp = container_port.trim_end_matches("/tcp");
            for b in bindings[container_port].as_array().cloned().unwrap_or_default() {
                let ip = b.get("HostIp").and_then(|x| x.as_str()).unwrap_or("");
                let hp = b.get("HostPort").and_then(|x| x.as_str()).unwrap_or("");
                let spec = match (ip.is_empty(), hp.is_empty()) {
                    (true, true) => cp.to_string(),
                    (true, false) => format!("{}:{}", hp, cp),
                    (false, _) => format!("{}:{}:{}", ip, hp, cp),
                };
                o.push(format!("-p {}", q(&spec)));
            }
        }
    }
    if hc.get("PublishAllPorts").and_then(|x| x.as_bool()) == Some(true) { o.push("-P".into()); }

    // Volumes: Binds holds the user's exact -v specs (incl. :ro). Mounts that
    // aren't in Binds are --mount'ed or anonymous volumes — reattach those by
    // name so their data isn't replaced with an empty volume.
    let binds = s_arr(hc.get("Binds"));
    let bind_dests: Vec<String> = binds.iter().filter_map(|b| b.split(':').nth(1).map(String::from)).collect();
    for b in &binds { o.push(format!("-v {}", q(b))); }
    for m in v.get("Mounts").and_then(|x| x.as_array()).cloned().unwrap_or_default() {
        let dest = m.get("Destination").and_then(|x| x.as_str()).unwrap_or("");
        if dest.is_empty() || bind_dests.iter().any(|d| d == dest) { continue; }
        let ro = m.get("RW").and_then(|x| x.as_bool()) == Some(false);
        let typ = m.get("Type").and_then(|x| x.as_str()).unwrap_or("");
        let src = match typ {
            "volume" => m.get("Name").and_then(|x| x.as_str()),
            "bind" => m.get("Source").and_then(|x| x.as_str()),
            _ => None,
        };
        match (typ, src) {
            ("volume" | "bind", Some(src)) => {
                o.push(format!("--mount {}", q(&format!(
                    "type={},source={},target={}{}", typ, src, dest, if ro { ",readonly" } else { "" }
                ))));
            }
            ("tmpfs", _) => {} // handled via HostConfig.Tmpfs
            _ => return Err(format!("Can't recreate mount at {} (type {})", dest, typ)),
        }
    }
    if let Some(t) = hc.get("Tmpfs").and_then(|x| x.as_object()) {
        for (path, opts) in t {
            let o2 = opts.as_str().unwrap_or("");
            o.push(format!("--tmpfs {}", q(&if o2.is_empty() { path.clone() } else { format!("{}:{}", path, o2) })));
        }
    }

    if let Some(rp) = hc.get("RestartPolicy") {
        let name = rp.get("Name").and_then(|x| x.as_str()).unwrap_or("");
        let max = rp.get("MaximumRetryCount").and_then(|x| x.as_i64()).unwrap_or(0);
        match name {
            "" | "no" => {}
            "on-failure" if max > 0 => o.push(format!("--restart {}", q(&format!("on-failure:{}", max)))),
            n => o.push(format!("--restart {}", q(n))),
        }
    }
    if hc.get("AutoRemove").and_then(|x| x.as_bool()) == Some(true) { o.push("--rm".into()); }
    if hc.get("Privileged").and_then(|x| x.as_bool()) == Some(true) { o.push("--privileged".into()); }
    if hc.get("ReadonlyRootfs").and_then(|x| x.as_bool()) == Some(true) { o.push("--read-only".into()); }
    if hc.get("Init").and_then(|x| x.as_bool()) == Some(true) { o.push("--init".into()); }
    for c in s_arr(hc.get("CapAdd")) { o.push(format!("--cap-add {}", q(&c))); }
    for c in s_arr(hc.get("CapDrop")) { o.push(format!("--cap-drop {}", q(&c))); }
    for c in s_arr(hc.get("SecurityOpt")) { o.push(format!("--security-opt {}", q(&c))); }
    for c in s_arr(hc.get("ExtraHosts")) { o.push(format!("--add-host {}", q(&c))); }
    for c in s_arr(hc.get("Dns")) { o.push(format!("--dns {}", q(&c))); }
    for c in s_arr(hc.get("DnsSearch")) { o.push(format!("--dns-search {}", q(&c))); }
    for c in s_arr(hc.get("DnsOptions")) { o.push(format!("--dns-option {}", q(&c))); }
    for c in s_arr(hc.get("GroupAdd")) { o.push(format!("--group-add {}", q(&c))); }
    for d in hc.get("Devices").and_then(|x| x.as_array()).cloned().unwrap_or_default() {
        let h = d.get("PathOnHost").and_then(|x| x.as_str()).unwrap_or("");
        let c = d.get("PathInContainer").and_then(|x| x.as_str()).unwrap_or(h);
        let perm = d.get("CgroupPermissions").and_then(|x| x.as_str()).unwrap_or("rwm");
        if !h.is_empty() { o.push(format!("--device {}", q(&format!("{}:{}:{}", h, c, perm)))); }
    }
    if let Some(u) = hc.get("Ulimits").and_then(|x| x.as_array()) {
        for l in u {
            let n = l.get("Name").and_then(|x| x.as_str()).unwrap_or("");
            let soft = l.get("Soft").and_then(|x| x.as_i64()).unwrap_or(0);
            let hard = l.get("Hard").and_then(|x| x.as_i64()).unwrap_or(soft);
            if !n.is_empty() { o.push(format!("--ulimit {}", q(&format!("{}={}:{}", n, soft, hard)))); }
        }
    }
    if let Some(sc) = hc.get("Sysctls").and_then(|x| x.as_object()) {
        for (k, val) in sc { if let Some(val) = val.as_str() { o.push(format!("--sysctl {}", q(&format!("{}={}", k, val)))); } }
    }
    if let Some(lc) = hc.get("LogConfig") {
        let t = lc.get("Type").and_then(|x| x.as_str()).unwrap_or("");
        if !t.is_empty() && t != "json-file" { o.push(format!("--log-driver {}", q(t))); }
        if let Some(cfg) = lc.get("Config").and_then(|x| x.as_object()) {
            for (k, val) in cfg { if let Some(val) = val.as_str() { o.push(format!("--log-opt {}", q(&format!("{}={}", k, val)))); } }
        }
    }
    let num = |k: &str| hc.get(k).and_then(|x| x.as_i64()).filter(|n| *n > 0);
    if let Some(m) = num("Memory") { o.push(format!("--memory {}", m)); }
    if let Some(m) = num("MemorySwap") { o.push(format!("--memory-swap {}", m)); }
    if let Some(m) = num("MemoryReservation") { o.push(format!("--memory-reservation {}", m)); }
    if let Some(c) = num("NanoCpus") { o.push(format!("--cpus {}", c as f64 / 1e9)); }
    if let Some(c) = num("CpuShares") { o.push(format!("--cpu-shares {}", c)); }
    if let Some(c) = hc.get("CpusetCpus").and_then(|x| x.as_str()).filter(|s| !s.is_empty()) { o.push(format!("--cpuset-cpus {}", q(c))); }
    if let Some(sz) = num("ShmSize").filter(|n| *n != 64 * 1024 * 1024) { o.push(format!("--shm-size {}", sz)); }
    if let Some(pl) = num("PidsLimit") { o.push(format!("--pids-limit {}", pl)); }
    for (k, flag) in [("PidMode", "--pid"), ("IpcMode", "--ipc"), ("UTSMode", "--uts"), ("UsernsMode", "--userns"), ("CgroupnsMode", "--cgroupns")] {
        if let Some(val) = hc.get(k).and_then(|x| x.as_str()).filter(|s| !s.is_empty() && *s != "private" && *s != "shareable") {
            o.push(format!("{} {}", flag, q(val)));
        }
    }
    if let Some(rt) = hc.get("Runtime").and_then(|x| x.as_str()).filter(|s| !s.is_empty() && *s != "runc") {
        o.push(format!("--runtime {}", q(rt)));
    }

    // ── Networks ──
    let networks = v.get("NetworkSettings").and_then(|n| n.get("Networks")).and_then(|x| x.as_object()).cloned().unwrap_or_default();
    let endpoint = |name: &str| -> (Vec<String>, Option<String>) {
        let ep = networks.get(name);
        let id = v.get("Id").and_then(|x| x.as_str()).unwrap_or("");
        let aliases = s_arr(ep.and_then(|e| e.get("Aliases")))
            .into_iter()
            // Docker auto-adds the short id as an alias — don't pin it
            .filter(|a| !id.starts_with(a.as_str()) && a != &p.name)
            .collect();
        let ip = ep.and_then(|e| e.get("IPAMConfig")).and_then(|c| c.get("IPv4Address"))
            .and_then(|x| x.as_str()).filter(|s| !s.is_empty()).map(String::from);
        (aliases, ip)
    };
    let primary = if net_mode == "default" { "bridge".to_string() } else { net_mode.clone() };
    if net_mode != "default" && net_mode != "bridge" {
        o.push(format!("--network {}", q(&net_mode)));
    }
    if net_mode != "host" && net_mode != "none" {
        let (aliases, ip) = endpoint(&primary);
        for a in aliases { o.push(format!("--network-alias {}", q(&a))); }
        if let Some(ip) = ip { o.push(format!("--ip {}", q(&ip))); }
        let mut others: Vec<&String> = networks.keys().filter(|n| **n != primary).collect();
        others.sort();
        for n in others {
            let (aliases, ip) = endpoint(n);
            p.extra_networks.push((n.clone(), aliases, ip));
        }
    }
    Ok(p)
}

/// Detect compose project + service (+ files, dir) from container labels.
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

fn compose_label(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get("Config")?.get("Labels")?.get(key)?.as_str().filter(|s| !s.is_empty()).map(String::from)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
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
        let session = conn.sftp_session.lock().unwrap_or_else(|e| e.into_inner());
        rebuild_container(&session, &container_id, &sudo_password)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Recreate one container (compose-aware, with rollback). Blocking; the caller
/// holds the session lock.
pub(crate) fn rebuild_container(session: &ssh2::Session, container_id: &str, sudo_password: &Option<String>) -> Result<String, String> {
        let d = |cmd: &str| run_docker(session, cmd, sudo_password);

        let inspect_out = d(&format!("docker inspect --format '{{{{json .}}}}' {}", shell_quote(container_id)))?;
        let inspect = first_inspect_object(&inspect_out)?;

        // ── Compose-managed: let compose recreate it from its own files ──
        if let Some((project, service)) = compose_labels_from_inspect(&inspect) {
            let service = validate_id(&service, "compose service")?;
            let files = compose_label(&inspect, "com.docker.compose.project.config_files")
                .map(|f| split_config_files(&f)).unwrap_or_default();
            let dir = compose_label(&inspect, "com.docker.compose.project.working_dir");
            let sel = compose_selector(&project, &files, dir.as_deref(), true)?;
            let out = d(&format!("{} up -d --force-recreate --build {}", sel, shell_quote(&service)))?;
            return Ok(format!("Rebuilt via compose (project={}, service={}):\n{}", project, service, out));
        }

        // ── Standalone: plan first (refuses unsupported settings up front) ──
        let plan = build_recreate_plan(&inspect)?;
        let was_running = inspect.get("State").and_then(|s| s.get("Running")).and_then(|x| x.as_bool()) == Some(true);
        let mut log = Vec::new();

        match d(&format!("docker pull {}", shell_quote(&plan.image))) {
            Ok(_) => log.push(format!("Pulled {}", plan.image)),
            Err(e) => log.push(format!("Pull skipped ({}), using local image", e.lines().last().unwrap_or("").trim())),
        }

        // ── Non-destructive preparation first — nothing below may fail with
        //    the original container already moved aside and no rollback. ──

        // Env goes into a 0600 env-file written via stdin (never argv, no SFTP
        // dependency); removed again whatever happens.
        let env_path: Option<String> = if plan.env_lines.is_empty() { None } else {
            let (home, _, code) = crate::remote::run(session, &RemoteCmd::plain("printf %s \"$HOME\""), true)?;
            let home = home.trim().to_string();
            if code != 0 || !home.starts_with('/') {
                return Err("Couldn't determine the remote home directory for the env file".to_string());
            }
            let path = format!("{}/.pingnet-env-{}-{}", home.trim_end_matches('/'), plan.name, now_secs());
            let rc = RemoteCmd {
                cmd: format!("umask 077 && cat > {}", shell_quote(&path)),
                stdin: Some(plan.env_lines.join("\n") + "\n"),
            };
            let (out, _, code) = crate::remote::run(session, &rc, true)?;
            if code != 0 {
                return Err(format!("Couldn't write env file: {}", out.trim()));
            }
            Some(path)
        };
        let remove_env = || {
            if let Some(p) = &env_path {
                let _ = crate::remote::run(session, &RemoteCmd::plain(&format!("rm -f {}", shell_quote(p))), true);
            }
        };

        let mut run = vec!["docker run -d".to_string(), format!("--name {}", shell_quote(&plan.name))];
        if let Some(p) = &env_path { run.push(format!("--env-file {}", shell_quote(p))); }
        for e in &plan.env_inline { run.push(format!("-e {}", shell_quote(e))); }
        run.extend(plan.run_opts.iter().cloned());
        run.push(shell_quote(&plan.image));
        run.extend(plan.args.iter().cloned());
        let run_cmd = run.join(" ");

        // ── Destructive part: move the original aside, then every failure rolls back ──
        let backup = format!("{}-pingnet-backup-{}", plan.name, now_secs());
        if let Err(e) = d(&format!("docker rename {} {}", shell_quote(&plan.name), shell_quote(&backup))) {
            remove_env();
            return Err(e);
        }

        let attempt = (|| -> Result<(), String> {
            let _ = d(&format!("docker stop {}", shell_quote(&backup)));
            d(&run_cmd)?;
            for (net, aliases, ip) in &plan.extra_networks {
                let mut c = vec!["docker network connect".to_string()];
                for a in aliases { c.push(format!("--alias {}", shell_quote(a))); }
                if let Some(ip) = ip { c.push(format!("--ip {}", shell_quote(ip))); }
                c.push(shell_quote(net));
                c.push(shell_quote(&plan.name));
                d(&c.join(" "))?;
            }
            // Give it a moment, then make sure it didn't crash on start
            std::thread::sleep(Duration::from_secs(3));
            let st = d(&format!("docker inspect --format '{{{{.State.Running}}}} {{{{.State.ExitCode}}}}' {}", shell_quote(&plan.name)))?;
            let mut it = st.split_whitespace();
            let running = it.next() == Some("true");
            let code = it.next().unwrap_or("0");
            if !running && code != "0" {
                let logs = d(&format!("docker logs --tail 20 {}", shell_quote(&plan.name))).unwrap_or_default();
                return Err(format!("New container exited with code {}:\n{}", code, logs.trim()));
            }
            Ok(())
        })();
        remove_env();

        match attempt {
            Ok(()) => {
                let _ = d(&format!("docker rm {}", shell_quote(&backup)));
                log.push(format!("Recreated {} (previous container removed)", plan.name));
                Ok(log.join("\n"))
            }
            Err(e) => {
                // Roll back: drop the new container, restore the original
                let _ = d(&format!("docker rm -f {}", shell_quote(&plan.name)));
                let restored = d(&format!("docker rename {} {}", shell_quote(&backup), shell_quote(&plan.name))).is_ok();
                if restored && was_running {
                    let _ = d(&format!("docker start {}", shell_quote(&plan.name)));
                }
                Err(format!(
                    "Rebuild failed: {}\n\n{}",
                    e,
                    if restored { "The original container was restored.".to_string() }
                    else { format!("The original container is kept as '{}'.", backup) }
                ))
            }
        }
}

#[cfg(test)]
mod rebuild_tests {
    use super::*;
    use serde_json::json;

    fn base() -> serde_json::Value {
        json!({
            "Id": "abc123def456",
            "Name": "/myapp",
            "Config": { "Image": "nginx:latest", "Hostname": "abc123def456", "Env": ["FOO=bar", "SECRET=s3cr3t"], "Cmd": ["nginx", "-g", "daemon off;"] },
            "HostConfig": { "RestartPolicy": { "Name": "always" }, "NetworkMode": "bridge" },
            "Mounts": [],
            "State": { "Running": true }
        })
    }

    #[test]
    fn inspect_object_or_array() {
        assert_eq!(first_inspect_object(r#"{"Id":"x"}"#).unwrap()["Id"], "x");
        assert_eq!(first_inspect_object(r#"[{"Id":"y"}]"#).unwrap()["Id"], "y");
        assert!(first_inspect_object("[]").is_err());
    }

    #[test]
    fn basic_plan_keeps_env_out_of_argv() {
        let p = build_recreate_plan(&base()).unwrap();
        let opts = p.run_opts.join(" ");
        assert_eq!(p.name, "myapp");
        assert!(opts.contains("--restart 'always'"));
        assert!(!opts.contains("s3cr3t"));
        assert_eq!(p.env_lines, vec!["FOO=bar", "SECRET=s3cr3t"]);
        assert!(!opts.contains("--hostname"), "default id hostname must not be pinned");
        assert_eq!(p.args, vec!["'nginx'", "'-g'", "'daemon off;'"]);
    }

    #[test]
    fn entrypoint_udp_ports_and_readonly_named_volume_survive() {
        let mut v = base();
        v["Config"]["Entrypoint"] = json!(["/bin/tini", "--"]);
        v["HostConfig"]["PortBindings"] = json!({ "53/udp": [{ "HostIp": "", "HostPort": "5353" }], "80/tcp": [{ "HostIp": "127.0.0.1", "HostPort": "8080" }] });
        v["HostConfig"]["Binds"] = json!(["data:/var/lib/data:ro", "/srv/conf:/etc/app"]);
        v["Mounts"] = json!([
            { "Type": "volume", "Name": "data", "Destination": "/var/lib/data", "RW": false },
            { "Type": "bind", "Source": "/srv/conf", "Destination": "/etc/app", "RW": true },
            { "Type": "volume", "Name": "0f1e2d3c", "Destination": "/cache", "RW": true }
        ]);
        let p = build_recreate_plan(&v).unwrap();
        let o = p.run_opts.join(" ");
        assert!(o.contains("--entrypoint '/bin/tini'"));
        assert_eq!(p.args[0], "'--'");
        assert!(o.contains("-p '5353:53/udp'"), "{}", o);
        assert!(o.contains("-p '127.0.0.1:8080:80'"));
        assert!(o.contains("-v 'data:/var/lib/data:ro'"));
        assert!(o.contains("--mount 'type=volume,source=0f1e2d3c,target=/cache'"), "anonymous volume must be reattached: {}", o);
    }

    #[test]
    fn extra_networks_and_aliases() {
        let mut v = base();
        v["HostConfig"]["NetworkMode"] = json!("appnet");
        v["NetworkSettings"] = json!({ "Networks": {
            "appnet": { "Aliases": ["api", "abc123def456"], "IPAMConfig": { "IPv4Address": "172.20.0.10" } },
            "monitoring": { "Aliases": ["api-metrics"] }
        }});
        let p = build_recreate_plan(&v).unwrap();
        let o = p.run_opts.join(" ");
        assert!(o.contains("--network 'appnet'"));
        assert!(o.contains("--network-alias 'api'"));
        assert!(!o.contains("abc123def456"));
        assert!(o.contains("--ip '172.20.0.10'"));
        assert_eq!(p.extra_networks, vec![("monitoring".to_string(), vec!["api-metrics".to_string()], None)]);
    }

    #[test]
    fn refuses_what_it_cannot_reproduce() {
        let mut v = base();
        v["HostConfig"]["VolumesFrom"] = json!(["other"]);
        assert!(build_recreate_plan(&v).unwrap_err().contains("volumes-from"));
        let mut v = base();
        v["HostConfig"]["NetworkMode"] = json!("container:vpn");
        assert!(build_recreate_plan(&v).is_err());
        let mut v = base();
        v["HostConfig"]["DeviceRequests"] = json!([{ "Driver": "nvidia", "Count": -1 }]);
        assert!(build_recreate_plan(&v).is_err());
    }

    #[test]
    fn generated_run_command_is_valid_sh() {
        let mut v = base();
        v["Config"]["Labels"] = json!({ "com.example.note": "it's fine" });
        v["Config"]["Healthcheck"] = json!({ "Test": ["CMD-SHELL", "curl -f http://localhost/ || exit 1"], "Interval": 30_000_000_000i64, "Retries": 3 });
        let p = build_recreate_plan(&v).unwrap();
        let cmd = format!("docker run -d --name x {} {} {}", p.run_opts.join(" "), shell_quote(&p.image), p.args.join(" "));
        let st = std::process::Command::new("sh").args(["-n", "-c", &cmd]).status().unwrap();
        assert!(st.success(), "{}", cmd);
        assert!(cmd.contains("--health-interval 30000ms"));
    }

    #[test]
    fn compose_selector_uses_files_and_dir() {
        let sel = compose_selector("proj", &split_config_files("/opt/app/docker-compose.yml, /opt/app/override.yml"), Some("/opt/app"), true).unwrap();
        assert_eq!(sel, "docker compose -p 'proj' -f '/opt/app/docker-compose.yml' -f '/opt/app/override.yml' --project-directory '/opt/app'");
        assert!(compose_selector("proj", &[], None, true).is_err());
        assert_eq!(compose_selector("proj", &[], None, false).unwrap(), "docker compose -p 'proj'");
    }

    #[test]
    fn compose_labels_detected() {
        let inspect = json!({ "Config": { "Labels": {
            "com.docker.compose.project": "myproj", "com.docker.compose.service": "web"
        }}});
        let (p, s) = compose_labels_from_inspect(&inspect).unwrap();
        assert_eq!((p.as_str(), s.as_str()), ("myproj", "web"));
    }
}

#[cfg(test)]
mod live_docker_tests {
    //! Opt-in: real sshd + docker daemon on a DISPOSABLE host.
    //!   PINGNET_TEST_SSH="host:port:user:password" PINGNET_TEST_IMAGE=<local image with /bin/sh + sleep> \
    //!   cargo test -- --ignored live_docker --test-threads=1
    //! The SSH user must be able to run docker without sudo.
    use super::*;

    fn sh(cmd: &str) -> (String, i32) {
        let v = std::env::var("PINGNET_TEST_SSH").expect("PINGNET_TEST_SSH");
        let mut it = v.splitn(4, ':');
        let (h, p, u, pw) = (it.next().unwrap(), it.next().unwrap().parse::<u16>().unwrap(), it.next().unwrap(), it.next().unwrap());
        let mut s = ssh2::Session::new().unwrap();
        s.set_tcp_stream(std::net::TcpStream::connect((h, p)).unwrap());
        s.handshake().unwrap();
        s.userauth_password(u, pw).unwrap();
        let (out, _, code) = crate::remote::run(&s, &RemoteCmd::plain(cmd), true).unwrap();
        (out, code)
    }

    fn session() -> ssh2::Session {
        let v = std::env::var("PINGNET_TEST_SSH").unwrap();
        let mut it = v.splitn(4, ':');
        let (h, p, u, pw) = (it.next().unwrap(), it.next().unwrap().parse::<u16>().unwrap(), it.next().unwrap(), it.next().unwrap());
        let mut s = ssh2::Session::new().unwrap();
        s.set_tcp_stream(std::net::TcpStream::connect((h, p)).unwrap());
        s.handshake().unwrap();
        s.userauth_password(u, pw).unwrap();
        s.set_timeout(120_000);
        s
    }

    fn inspect(name: &str) -> serde_json::Value {
        first_inspect_object(&sh(&format!("docker inspect --format '{{{{json .}}}}' {}", name)).0).unwrap()
    }

    #[test]
    #[ignore = "needs disposable sshd + docker (PINGNET_TEST_SSH, PINGNET_TEST_IMAGE)"]
    fn live_docker_rebuild_preserves_config() {
        let img = std::env::var("PINGNET_TEST_IMAGE").unwrap();
        sh("docker rm -f pnt-a >/dev/null 2>&1; docker network rm pnt-net2 >/dev/null 2>&1; docker volume rm pnt-data >/dev/null 2>&1; true");
        sh("docker network create pnt-net2 && docker volume create pnt-data");
        let (out, code) = sh(&format!(
            "docker run -d --name pnt-a --entrypoint /bin/sh -e SECRET=s3cr3t -e MODE=prod --label app=demo \
             -p 15353:53/udp -v pnt-data:/data:ro -v /cache --restart unless-stopped --cap-add NET_ADMIN \
             --add-host db.local:10.0.0.9 {} -c 'while true; do sleep 1; done' && docker network connect --alias pnt-alias pnt-net2 pnt-a && \
             docker exec pnt-a sh -c 'echo keep > /cache/marker'", img));
        assert_eq!(code, 0, "{}", out);
        let before = inspect("pnt-a");
        let anon_before = before["Mounts"].as_array().unwrap().iter().find(|m| m["Destination"] == "/cache").unwrap()["Name"].clone();

        let msg = rebuild_container(&session(), "pnt-a", &None).expect("rebuild");
        println!("{}", msg);

        let after = inspect("pnt-a");
        assert_ne!(before["Id"], after["Id"], "container was not recreated");
        assert_eq!(after["State"]["Running"], true);
        assert_eq!(after["Config"]["Entrypoint"], before["Config"]["Entrypoint"]);
        assert_eq!(after["Config"]["Cmd"], before["Config"]["Cmd"]);
        assert!(after["Config"]["Env"].as_array().unwrap().iter().any(|e| e == "SECRET=s3cr3t"));
        assert_eq!(after["HostConfig"]["PortBindings"], before["HostConfig"]["PortBindings"]);
        assert_eq!(after["HostConfig"]["Binds"], before["HostConfig"]["Binds"]);
        assert_eq!(after["HostConfig"]["RestartPolicy"], before["HostConfig"]["RestartPolicy"]);
        assert_eq!(after["HostConfig"]["CapAdd"], before["HostConfig"]["CapAdd"]);
        assert_eq!(after["HostConfig"]["ExtraHosts"], before["HostConfig"]["ExtraHosts"]);
        assert_eq!(after["Config"]["Labels"]["app"], "demo");
        let anon_after = after["Mounts"].as_array().unwrap().iter().find(|m| m["Destination"] == "/cache").unwrap()["Name"].clone();
        assert_eq!(anon_before, anon_after, "anonymous volume must be reattached");
        assert_eq!(sh("docker exec pnt-a cat /cache/marker").0.trim(), "keep");
        let aliases = &after["NetworkSettings"]["Networks"]["pnt-net2"]["Aliases"];
        assert!(aliases.as_array().unwrap().iter().any(|a| a == "pnt-alias"), "{}", aliases);
        // backup removed, env file removed
        assert!(!sh("docker ps -a --format '{{.Names}}'").0.contains("pingnet-backup"));
        assert_eq!(sh("ls -a ~ | grep -c pingnet-env || true").0.trim(), "0");
        sh("docker rm -f pnt-a; docker network rm pnt-net2; docker volume rm pnt-data");
    }

    #[test]
    #[ignore = "needs disposable sshd + docker (PINGNET_TEST_SSH, PINGNET_TEST_IMAGE)"]
    fn live_docker_rebuild_rolls_back_on_failure() {
        let img = std::env::var("PINGNET_TEST_IMAGE").unwrap();
        sh("docker rm -f pnt-b >/dev/null 2>&1; docker rmi pnt-rollback:tag >/dev/null 2>&1; true");
        sh(&format!("docker tag {} pnt-rollback:tag", img));
        let (out, code) = sh("docker run -d --name pnt-b pnt-rollback:tag /bin/sh -c 'while true; do sleep 1; done'");
        assert_eq!(code, 0, "{}", out);
        let orig_id = inspect("pnt-b")["Id"].clone();
        // Re-point the tag at an image whose shell is missing → the recreated
        // container can't start, forcing the rollback path
        sh("mkdir -p /tmp/pnt-broken && printf 'x' > /tmp/pnt-broken/x && tar -C /tmp/pnt-broken -cf /tmp/pnt-broken.tar . && docker import /tmp/pnt-broken.tar pnt-rollback:tag");

        let err = rebuild_container(&session(), "pnt-b", &None).unwrap_err();
        println!("{}", err);
        assert!(err.contains("original container was restored"), "{}", err);
        let now = inspect("pnt-b");
        assert_eq!(now["Id"], orig_id, "original container must be back under its name");
        assert_eq!(now["State"]["Running"], true);
        assert!(!sh("docker ps -a --format '{{.Names}}'").0.contains("pingnet-backup"));
        sh("docker rm -f pnt-b; docker rmi pnt-rollback:tag");
    }

    #[test]
    #[ignore = "needs disposable sshd + docker + compose (PINGNET_TEST_SSH, PINGNET_TEST_IMAGE, PINGNET_TEST_COMPOSE_DIR)"]
    fn live_docker_compose_project_outside_home() {
        // PINGNET_TEST_COMPOSE_DIR: a directory NOT under the SSH user's home,
        // containing a compose file for project "pntapp" (service "web").
        let dir = std::env::var("PINGNET_TEST_COMPOSE_DIR").unwrap();
        let (out, code) = sh(&format!("cd {} && docker compose -p pntapp up -d", dir));
        assert_eq!(code, 0, "{}", out);
        let s = session();
        // From $HOME, -p alone can't find the file; the resolved selector can
        let sel = resolve_compose_selector(&s, "pntapp", &None, "up").unwrap();
        assert!(sel.contains(" -f "), "{}", sel);
        let before = sh("docker ps -q --filter label=com.docker.compose.project=pntapp").0;
        let out = run_docker(&s, &format!("{} up -d --force-recreate", sel), &None).expect("compose up from $HOME");
        println!("{}", out.trim());
        let after = sh("docker ps -q --filter label=com.docker.compose.project=pntapp").0;
        assert_ne!(before.trim(), after.trim(), "service should have been recreated");
        // Rebuild via the container's compose labels
        let cid = after.trim().lines().next().unwrap().to_string();
        let msg = rebuild_container(&s, &cid, &None).expect("compose rebuild");
        assert!(msg.contains("Rebuilt via compose"), "{}", msg);
        sh(&format!("cd {} && docker compose -p pntapp down", dir));
    }

    #[test]
    #[ignore = "needs a second SSH user without docker access (PINGNET_TEST_SSH_NODOCKER)"]
    fn live_docker_permission_error_is_reported() {
        let v = std::env::var("PINGNET_TEST_SSH_NODOCKER").unwrap();
        let mut it = v.splitn(4, ':');
        let (h, p, u, pw) = (it.next().unwrap(), it.next().unwrap().parse::<u16>().unwrap(), it.next().unwrap(), it.next().unwrap());
        let mut s = ssh2::Session::new().unwrap();
        s.set_tcp_stream(std::net::TcpStream::connect((h, p)).unwrap());
        s.handshake().unwrap();
        s.userauth_password(u, pw).unwrap();
        let err = list_containers(&s, &None).unwrap_err();
        assert_eq!(err, "PERMISSION_DENIED");
    }
}
