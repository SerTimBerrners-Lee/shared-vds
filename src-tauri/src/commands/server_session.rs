use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::net::{IpAddr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use tauri::Manager;

use crate::logger;

const TUNNEL_RESTART_BACKOFF: Duration = Duration::from_secs(5);
const TUNNEL_HEALTH_TIMEOUT: Duration = Duration::from_millis(900);
/// Как часто фоновый вотчдог проверяет живость туннелей и при необходимости их
/// перезапускает. Работает независимо от того, открыто окно или нет.
const TUNNEL_WATCHDOG_INTERVAL: Duration = Duration::from_secs(4);
/// Как часто вотчдог выполняет дорогую remote-проверку порта VDS по SSH.
/// Сама проверка делается вне блокировки карты туннелей.
const TUNNEL_REMOTE_HEALTH_INTERVAL: Duration = Duration::from_secs(30);
const VDS_HEALTH_TIMEOUT: Duration = Duration::from_secs(7);
const VDS_LOCATION_LOOKUP_TIMEOUT: Duration = Duration::from_secs(3);
const VDS_LOCATION_SUCCESS_TTL: Duration = Duration::from_secs(6 * 60 * 60);
const VDS_LOCATION_ERROR_TTL: Duration = Duration::from_secs(10 * 60);
const SSH_STARTUP_OUTPUT_LINE_LIMIT: usize = 24;
const VDS_HEALTH_SCRIPT: &str = r#"
os="$(uname -s 2>/dev/null || printf unknown)"
printf 'OS=%s\n' "$os"
if [ "$os" != "Linux" ]; then
  exit 0
fi
if [ -r /proc/loadavg ]; then
  read load _ < /proc/loadavg
  printf 'LOAD_AVG=%s\n' "$load"
fi
if command -v getconf >/dev/null 2>&1; then
  cores="$(getconf _NPROCESSORS_ONLN 2>/dev/null || true)"
else
  cores=""
fi
if [ -z "$cores" ] && command -v nproc >/dev/null 2>&1; then
  cores="$(nproc 2>/dev/null || true)"
fi
printf 'CPU_CORES=%s\n' "$cores"
if [ -r /proc/meminfo ]; then
  awk '/^MemTotal:/ {print "MEM_TOTAL_KB="$2} /^MemAvailable:/ {print "MEM_AVAILABLE_KB="$2}' /proc/meminfo
fi
df -B1 / 2>/dev/null | awk 'NR==2 {print "DISK_TOTAL_BYTES="$2; print "DISK_USED_BYTES="$3}'
if command -v uptime >/dev/null 2>&1; then
  uptime -p 2>/dev/null | sed 's/^/UPTIME=/'
fi
if [ -r /proc/uptime ]; then
  awk '{printf "UPTIME_SECONDS=%d\n", $1}' /proc/uptime
fi
"#;

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServerSessionConfig {
    host: String,
    ssh_port: u16,
    username: String,
    identity_file: Option<String>,
    remote_tunnel_port: u16,
    local_ssh_port: u16,
    project_path: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalTunnelConfig {
    id: String,
    label: String,
    local_port: u16,
    remote_port: u16,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReverseTunnelConfig {
    id: String,
    label: String,
    remote_port: u16,
    local_port: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerSessionStatus {
    tunnel_id: Option<String>,
    label: Option<String>,
    status: String,
    pid: Option<u32>,
    remote_tunnel_port: Option<u16>,
    local_ssh_port: Option<u16>,
    error_message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKeyInfo {
    private_key_path: String,
    public_key_path: String,
    public_key: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectionTestResult {
    ok: bool,
    message: String,
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DesktopPlatform {
    Macos,
    Linux,
    Windows,
    Unknown,
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalId {
    System,
    Ghostty,
    Warp,
    Iterm2,
    Alacritty,
    Kitty,
    WindowsTerminal,
    Powershell,
    GitBash,
    GnomeTerminal,
    Konsole,
    Xfce4Terminal,
}

impl<'de> Deserialize<'de> for TerminalId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        match value.as_str() {
            "system" | "terminal" | "x-terminal-emulator" | "xterm" => Ok(TerminalId::System),
            "ghostty" => Ok(TerminalId::Ghostty),
            "warp" => Ok(TerminalId::Warp),
            "iterm2" => Ok(TerminalId::Iterm2),
            "alacritty" => Ok(TerminalId::Alacritty),
            "kitty" => Ok(TerminalId::Kitty),
            "windows-terminal" => Ok(TerminalId::WindowsTerminal),
            "powershell" => Ok(TerminalId::Powershell),
            "git-bash" => Ok(TerminalId::GitBash),
            "gnome-terminal" => Ok(TerminalId::GnomeTerminal),
            "konsole" => Ok(TerminalId::Konsole),
            "xfce4-terminal" => Ok(TerminalId::Xfce4Terminal),
            _ => Err(serde::de::Error::unknown_variant(
                value.as_str(),
                &[
                    "system",
                    "ghostty",
                    "warp",
                    "iterm2",
                    "alacritty",
                    "kitty",
                    "windows-terminal",
                    "powershell",
                    "git-bash",
                    "gnome-terminal",
                    "konsole",
                    "xfce4-terminal",
                ],
            )),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOption {
    id: TerminalId,
    label: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemToolStatus {
    ssh_available: bool,
    ssh_keygen_available: bool,
    missing_tools: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSshSupport {
    platform: DesktopPlatform,
    port: u16,
    available: bool,
    can_open_settings: bool,
    can_request_enable: bool,
    instructions_key: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VdsSystemStatus {
    platform: DesktopPlatform,
    tools: SystemToolStatus,
    local_ssh: LocalSshSupport,
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum VdsHealthState {
    Ok,
    Degraded,
    Error,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VdsHealthMetrics {
    load_average: Option<f64>,
    cpu_cores: Option<u32>,
    memory_total_bytes: Option<u64>,
    memory_used_bytes: Option<u64>,
    disk_total_bytes: Option<u64>,
    disk_used_bytes: Option<u64>,
    uptime: Option<String>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VdsLocation {
    ip: String,
    country: Option<String>,
    city: Option<String>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VdsHealthStatus {
    status: VdsHealthState,
    checked_at: String,
    message: Option<String>,
    metrics: Option<VdsHealthMetrics>,
    location: Option<VdsLocation>,
}

#[derive(Debug, Clone, PartialEq)]
struct ParsedVdsHealth {
    status: VdsHealthState,
    message: Option<String>,
    metrics: Option<VdsHealthMetrics>,
}

#[derive(Clone)]
struct VdsLocationCacheEntry {
    checked_at: Instant,
    location: Option<VdsLocation>,
}

#[derive(Debug, Deserialize)]
struct IpWhoIsLocationResponse {
    ip: Option<String>,
    success: Option<bool>,
    city: Option<String>,
    country: Option<String>,
}

static VDS_LOCATION_CACHE: OnceLock<Mutex<HashMap<String, VdsLocationCacheEntry>>> =
    OnceLock::new();

enum TunnelSpec {
    Local(LocalTunnelConfig),
    Reverse(ReverseTunnelConfig),
}

struct TunnelProcess {
    tunnel_id: String,
    label: String,
    config: ServerSessionConfig,
    spec: TunnelSpec,
    child: Option<Child>,
    remote_tunnel_port: u16,
    local_ssh_port: u16,
    last_error: Option<String>,
    next_restart_at: Option<Instant>,
    /// Закэшированный результат последней remote-проверки порта VDS
    /// (status, message). Используется, чтобы не запускать SSH на каждый тик.
    last_remote_health: Option<(String, Option<String>)>,
    last_remote_health_at: Option<Instant>,
}

#[derive(Clone, Copy)]
enum TunnelStartupContext {
    Local { local_port: u16 },
    Reverse { remote_port: u16 },
}

impl TunnelStartupContext {
    fn label(self) -> &'static str {
        match self {
            Self::Local { .. } => "Local SSH",
            Self::Reverse { .. } => "Reverse SSH",
        }
    }
}

pub struct ServerSessionManager {
    local_tunnels: Mutex<HashMap<String, TunnelProcess>>,
    reverse_tunnels: Mutex<HashMap<String, TunnelProcess>>,
    /// Последние посчитанные вотчдогом статусы. Команды статуса читают этот кэш
    /// мгновенно, без блокирующего сетевого I/O на main-потоке UI.
    local_status_cache: Mutex<Vec<ServerSessionStatus>>,
    reverse_status_cache: Mutex<Vec<ServerSessionStatus>>,
}

impl ServerSessionManager {
    pub fn new() -> Self {
        Self {
            local_tunnels: Mutex::new(HashMap::new()),
            reverse_tunnels: Mutex::new(HashMap::new()),
            local_status_cache: Mutex::new(Vec::new()),
            reverse_status_cache: Mutex::new(Vec::new()),
        }
    }
}

fn current_platform() -> DesktopPlatform {
    if cfg!(target_os = "macos") {
        DesktopPlatform::Macos
    } else if cfg!(target_os = "linux") {
        DesktopPlatform::Linux
    } else if cfg!(target_os = "windows") {
        DesktopPlatform::Windows
    } else {
        DesktopPlatform::Unknown
    }
}

fn executable_file_exists(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };

    if !metadata.is_file() {
        return false;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }

    #[cfg(not(unix))]
    {
        true
    }
}

fn system_tool_available(tool: &str) -> bool {
    let Some(paths) = env::var_os("PATH") else {
        return false;
    };

    #[cfg(windows)]
    let candidates = {
        let has_extension = Path::new(tool).extension().is_some();
        if has_extension {
            vec![tool.to_string()]
        } else {
            let pathext = env::var_os("PATHEXT")
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".to_string());
            let mut names = vec![tool.to_string()];
            names.extend(
                pathext
                    .split(';')
                    .filter(|extension| !extension.trim().is_empty())
                    .map(|extension| format!("{}{}", tool, extension.to_ascii_lowercase())),
            );
            names.extend(
                pathext
                    .split(';')
                    .filter(|extension| !extension.trim().is_empty())
                    .map(|extension| format!("{}{}", tool, extension.to_ascii_uppercase())),
            );
            names
        }
    };

    #[cfg(not(windows))]
    let candidates = vec![tool.to_string()];

    env::split_paths(&paths).any(|dir| {
        candidates
            .iter()
            .any(|candidate| executable_file_exists(&dir.join(candidate)))
    })
}

fn missing_system_tool_message(tool: &str, platform: DesktopPlatform) -> String {
    match (tool, platform) {
        ("ssh", DesktopPlatform::Macos) => {
            "Системная команда `ssh` не найдена. Установите OpenSSH Client через Xcode Command Line Tools или Homebrew.".to_string()
        }
        ("ssh", DesktopPlatform::Linux) => {
            "Системная команда `ssh` не найдена. Установите пакет `openssh-client` через пакетный менеджер вашего дистрибутива.".to_string()
        }
        ("ssh", DesktopPlatform::Windows) => {
            "Системная команда `ssh` не найдена. Включите OpenSSH Client в Windows Optional Features или установите OpenSSH.".to_string()
        }
        ("ssh-keygen", DesktopPlatform::Macos) => {
            "Системная команда `ssh-keygen` не найдена. Установите OpenSSH через Xcode Command Line Tools или Homebrew.".to_string()
        }
        ("ssh-keygen", DesktopPlatform::Linux) => {
            "Системная команда `ssh-keygen` не найдена. Установите пакет `openssh-client` через пакетный менеджер вашего дистрибутива.".to_string()
        }
        ("ssh-keygen", DesktopPlatform::Windows) => {
            "Системная команда `ssh-keygen` не найдена. Включите OpenSSH Client в Windows Optional Features или установите OpenSSH.".to_string()
        }
        _ => format!(
            "Системная команда `{}` не найдена. Установите OpenSSH и повторите действие.",
            tool
        ),
    }
}

fn ensure_system_tool_available(tool: &str) -> Result<(), String> {
    system_tool_available(tool)
        .then_some(())
        .ok_or_else(|| missing_system_tool_message(tool, current_platform()))
}

fn local_ssh_instructions_key(platform: DesktopPlatform) -> &'static str {
    match platform {
        DesktopPlatform::Macos => "session.localSshInstructions.macos",
        DesktopPlatform::Linux => "session.localSshInstructions.linux",
        DesktopPlatform::Windows => "session.localSshInstructions.windows",
        DesktopPlatform::Unknown => "session.localSshInstructions.unknown",
    }
}

fn local_ssh_unavailable_message(local_port: u16, platform: DesktopPlatform) -> String {
    match platform {
        DesktopPlatform::Macos => format!(
            "Локальный SSH выключен. Включите Remote Login в macOS, чтобы VDS мог подключиться обратно к этому компьютеру. Порт: {}.",
            local_port
        ),
        DesktopPlatform::Windows => format!(
            "Локальный SSH выключен. Включите OpenSSH Server в Windows и запустите службу sshd. Порт: {}.",
            local_port
        ),
        DesktopPlatform::Linux => format!(
            "Локальный SSH выключен. Установите и запустите openssh-server/sshd на этом компьютере. Порт: {}.",
            local_port
        ),
        DesktopPlatform::Unknown => format!(
            "Локальный SSH на 127.0.0.1:{} недоступен. Установите и запустите OpenSSH Server для вашей OS.",
            local_port
        ),
    }
}

fn trim_required(value: &str, field: &str) -> Result<String, String> {
    let trimmed = value.trim();

    if trimmed.is_empty() {
        return Err(format!("{} is required", field));
    }

    Ok(trimmed.to_string())
}

fn validate_port(port: u16, field: &str) -> Result<u16, String> {
    if port == 0 {
        return Err(format!("{} must be between 1 and 65535", field));
    }

    Ok(port)
}

fn is_valid_dns_hostname(value: &str) -> bool {
    if value.len() > 253 {
        return false;
    }

    value.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            && label
                .as_bytes()
                .first()
                .is_some_and(|byte| byte.is_ascii_alphanumeric())
            && label
                .as_bytes()
                .last()
                .is_some_and(|byte| byte.is_ascii_alphanumeric())
    })
}

fn validate_vds_host(value: &str) -> Result<String, String> {
    let host = trim_required(value, "host")?;
    let plain_host = host
        .strip_prefix('[')
        .and_then(|trimmed| trimmed.strip_suffix(']'))
        .unwrap_or(&host);

    if plain_host.parse::<IpAddr>().is_ok() || is_valid_dns_hostname(&host) {
        return Ok(host);
    }

    Err(format!(
        "Некорректный IP/домен VDS: \"{}\". Укажите IP или домен без #, пробелов и URL.",
        host.chars().take(80).collect::<String>()
    ))
}

fn validate_tunnel_id(value: &str) -> Result<String, String> {
    let trimmed = trim_required(value, "tunnelId")?;

    if trimmed.len() > 80 {
        return Err("tunnelId is too long".to_string());
    }

    Ok(trimmed)
}

fn normalized_tunnel_label(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();

    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.chars().take(80).collect()
    }
}

fn ensure_local_ssh_available(local_ssh_port: u16) -> Result<(), String> {
    local_tcp_available(local_ssh_port)
        .then_some(())
        .ok_or_else(|| local_ssh_unavailable_message(local_ssh_port, current_platform()))
}

fn local_tcp_available(local_port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], local_port));
    TcpStream::connect_timeout(&addr, TUNNEL_HEALTH_TIMEOUT).is_ok()
}

enum RemoteTcpCheckResult {
    Available,
    Unavailable,
    Failed(String),
}

#[cfg(target_os = "macos")]
fn open_system_settings_fallback() -> Result<(), String> {
    let status = Command::new("open")
        .arg("-b")
        .arg("com.apple.systempreferences")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| format!("Failed to open System Settings: {}", error))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("System Settings exited with status {}", status))
    }
}

#[cfg(not(target_os = "macos"))]
fn open_system_settings_fallback() -> Result<(), String> {
    Err("System Settings are only available on macOS.".to_string())
}

fn validate_vds_config(config: &ServerSessionConfig) -> Result<(), String> {
    validate_vds_host(&config.host)?;
    trim_required(&config.username, "username")?;
    validate_port(config.ssh_port, "sshPort")?;

    Ok(())
}

fn expand_home_path(path: &str) -> PathBuf {
    if path == "~" {
        if let Some(home) = dirs::home_dir() {
            return home;
        }
    }

    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }

    PathBuf::from(path)
}

fn identity_file_path(config: &ServerSessionConfig) -> Option<PathBuf> {
    config
        .identity_file
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(expand_home_path)
}

fn shared_vds_ssh_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Failed to resolve home directory".to_string())?;
    Ok(home.join(".ssh"))
}

fn default_key_path() -> Result<PathBuf, String> {
    Ok(shared_vds_ssh_dir()?.join("shared-vds_ed25519"))
}

fn available_key_path() -> Result<PathBuf, String> {
    let base_path = default_key_path()?;

    if !base_path.exists() && !public_key_path(&base_path).exists() {
        return Ok(base_path);
    }

    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    Ok(shared_vds_ssh_dir()?.join(format!("shared-vds_{}_ed25519", timestamp)))
}

fn public_key_path(private_key_path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.pub", private_key_path.to_string_lossy()))
}

fn read_public_key(private_key_path: &Path) -> Result<SshKeyInfo, String> {
    let public_key_path = public_key_path(private_key_path);
    let public_key = fs::read_to_string(&public_key_path)
        .map_err(|error| format!("Failed to read SSH public key: {}", error))?
        .trim()
        .to_string();

    if public_key.is_empty() {
        return Err("SSH public key is empty".to_string());
    }

    Ok(SshKeyInfo {
        private_key_path: private_key_path.to_string_lossy().to_string(),
        public_key_path: public_key_path.to_string_lossy().to_string(),
        public_key,
    })
}

#[cfg(unix)]
fn set_private_key_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("Failed to set SSH private key permissions: {}", error))
}

#[cfg(not(unix))]
fn set_private_key_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn stopped_status(tunnel_id: String, error_message: Option<String>) -> ServerSessionStatus {
    ServerSessionStatus {
        tunnel_id: Some(tunnel_id),
        label: None,
        status: "stopped".to_string(),
        pid: None,
        remote_tunnel_port: None,
        local_ssh_port: None,
        error_message,
    }
}

/// Полная (блокирующая) проверка здоровья: локальный порт + при необходимости
/// remote-проверка порта VDS по SSH. Может занимать секунды, поэтому в фоновом
/// вотчдоге вызывается вне блокировки карты туннелей.
fn tunnel_health(process: &TunnelProcess) -> (String, Option<String>) {
    match &process.spec {
        TunnelSpec::Local(tunnel) => local_tunnel_health(tunnel.local_port),
        TunnelSpec::Reverse(tunnel) => {
            probe_reverse_health(&process.config, tunnel.remote_port, tunnel.local_port)
        }
    }
}

fn local_tunnel_health(local_port: u16) -> (String, Option<String>) {
    if local_tcp_available(local_port) {
        ("connected".to_string(), None)
    } else {
        (
            "degraded".to_string(),
            Some(format!(
                "SSH туннель работает, но локальный порт 127.0.0.1:{} не отвечает.",
                local_port
            )),
        )
    }
}

/// Блокирующая remote-проверка reverse-туннеля: локальный порт + SSH-проверка
/// порта VDS. Выделена отдельно, чтобы вотчдог мог звать её вне лока.
fn probe_reverse_health(
    config: &ServerSessionConfig,
    remote_port: u16,
    local_port: u16,
) -> (String, Option<String>) {
    if !local_tcp_available(local_port) {
        return (
            "degraded".to_string(),
            Some(local_ssh_unavailable_message(local_port, current_platform())),
        );
    }

    match remote_tcp_available(config, remote_port) {
        RemoteTcpCheckResult::Available => ("connected".to_string(), None),
        RemoteTcpCheckResult::Unavailable => (
            "degraded".to_string(),
            Some(format!(
                "SSH туннель работает, но порт VDS 127.0.0.1:{} не отвечает.",
                remote_port
            )),
        ),
        RemoteTcpCheckResult::Failed(message) => (
            "degraded".to_string(),
            Some(format!(
                "SSH туннель работает, но проверка порта VDS 127.0.0.1:{} не выполнилась: {}",
                remote_port, message
            )),
        ),
    }
}

/// Дешёвое здоровье без блокирующего SSH: локальная TCP-проверка плюс
/// закэшированный результат последней remote-проверки. Используется вотчдогом
/// под локом, чтобы не держать карту туннелей во время SSH.
fn cheap_tunnel_health(process: &TunnelProcess) -> (String, Option<String>) {
    match &process.spec {
        TunnelSpec::Local(tunnel) => local_tunnel_health(tunnel.local_port),
        TunnelSpec::Reverse(tunnel) => {
            if !local_tcp_available(tunnel.local_port) {
                return (
                    "degraded".to_string(),
                    Some(local_ssh_unavailable_message(
                        tunnel.local_port,
                        current_platform(),
                    )),
                );
            }

            match &process.last_remote_health {
                Some((status, message)) => (status.clone(), message.clone()),
                None => ("connected".to_string(), None),
            }
        }
    }
}

fn spawn_tunnel_child(process: &TunnelProcess) -> Result<Child, String> {
    match &process.spec {
        TunnelSpec::Local(tunnel) => {
            let mut command = build_local_ssh_command(&process.config, tunnel)?;
            let child = command
                .spawn()
                .map_err(|error| format!("Failed to restart local SSH tunnel: {}", error))?;
            ensure_tunnel_running(
                child,
                TunnelStartupContext::Local {
                    local_port: tunnel.local_port,
                },
            )
            .map(|(child, _)| child)
        }
        TunnelSpec::Reverse(tunnel) => {
            ensure_local_ssh_available(tunnel.local_port)?;
            let mut command = build_reverse_ssh_command(&process.config, tunnel)?;
            let child = command
                .spawn()
                .map_err(|error| format!("Failed to restart reverse SSH tunnel: {}", error))?;
            ensure_tunnel_running(
                child,
                TunnelStartupContext::Reverse {
                    remote_port: tunnel.remote_port,
                },
            )
            .map(|(child, _)| child)
        }
    }
}

fn maybe_restart_tunnel(process: &mut TunnelProcess) {
    if process.child.is_some() {
        return;
    }

    if let Some(next_restart_at) = process.next_restart_at {
        if Instant::now() < next_restart_at {
            return;
        }
    }

    match spawn_tunnel_child(process) {
        Ok(child) => {
            logger::log_info(
                "SERVER_SESSION",
                &format!("SSH tunnel restarted ({})", process.tunnel_id),
            );
            process.child = Some(child);
            process.last_error = None;
            process.next_restart_at = None;
        }
        Err(error) => {
            logger::log_error(
                "SERVER_SESSION",
                &format!(
                    "Failed to restart SSH tunnel ({}): {}",
                    process.tunnel_id, error
                ),
            );
            process.last_error = Some(error);
            process.next_restart_at = Some(Instant::now() + TUNNEL_RESTART_BACKOFF);
        }
    }
}

/// Снимает зомби-процесс ssh, если он завершился, и помечает туннель к
/// немедленному перезапуску. Не делает сетевых проверок.
fn reap_process(process: &mut TunnelProcess) {
    if let Some(child) = process.child.as_mut() {
        match child.try_wait() {
            Ok(Some(exit_status)) => {
                let message = format!("SSH tunnel exited with status {}", exit_status);
                logger::log_error("SERVER_SESSION", &message);
                process.child = None;
                process.last_remote_health = None;
                process.last_error = Some(message);
                process.next_restart_at = Some(Instant::now());
            }
            Ok(None) => {}
            Err(error) => {
                let message = format!("Failed to inspect SSH tunnel: {}", error);
                logger::log_error("SERVER_SESSION", &message);
                process.child = None;
                process.last_remote_health = None;
                process.last_error = Some(message);
                process.next_restart_at = Some(Instant::now());
            }
        }
    }
}

fn status_struct(
    process: &TunnelProcess,
    status: String,
    health_message: Option<String>,
    pid: Option<u32>,
) -> ServerSessionStatus {
    ServerSessionStatus {
        tunnel_id: Some(process.tunnel_id.clone()),
        label: Some(process.label.clone()),
        status,
        pid,
        remote_tunnel_port: Some(process.remote_tunnel_port),
        local_ssh_port: Some(process.local_ssh_port),
        error_message: health_message,
    }
}

fn not_running_health(process: &TunnelProcess) -> (String, Option<String>) {
    (
        "error".to_string(),
        process
            .last_error
            .clone()
            .or_else(|| Some("SSH туннель не запущен.".to_string())),
    )
}

/// Полный расчёт статуса с блокирующей проверкой здоровья. Используется на пути
/// пользовательских команд (start/stop), где это происходит редко.
fn status_from_process(process: &mut TunnelProcess) -> ServerSessionStatus {
    reap_process(process);
    maybe_restart_tunnel(process);

    let pid = process.child.as_ref().map(|child| child.id());
    let (status, health_message) = if pid.is_some() {
        tunnel_health(process)
    } else {
        not_running_health(process)
    };

    status_struct(process, status, health_message, pid)
}

/// Дешёвый расчёт статуса для вотчдога: reap + restart + локальная проверка,
/// без блокирующего SSH (берётся закэшированный last_remote_health).
fn status_from_process_cached(process: &mut TunnelProcess) -> ServerSessionStatus {
    reap_process(process);
    maybe_restart_tunnel(process);

    let pid = process.child.as_ref().map(|child| child.id());
    let (status, health_message) = if pid.is_some() {
        cheap_tunnel_health(process)
    } else {
        not_running_health(process)
    };

    status_struct(process, status, health_message, pid)
}

fn status_from_map(
    tunnels: &mut HashMap<String, TunnelProcess>,
    tunnel_id: &str,
) -> ServerSessionStatus {
    let Some(process) = tunnels.get_mut(tunnel_id) else {
        return stopped_status(tunnel_id.to_string(), None);
    };

    status_from_process(process)
}

/// Один тик вотчдога для одной карты туннелей. Фаза 1 под локом — reap +
/// перезапуск + дешёвый статус, плюс сбор throttled-заданий на remote-проверку.
/// Фаза 2 вне лока — дорогая SSH-проверка порта VDS. Фаза 3 — публикация в кэш.
fn tick_tunnel_map(
    tunnels: &Mutex<HashMap<String, TunnelProcess>>,
    cache: &Mutex<Vec<ServerSessionStatus>>,
) {
    let mut statuses: Vec<ServerSessionStatus>;
    let mut probe_jobs: Vec<(String, ServerSessionConfig, u16, u16)> = Vec::new();

    {
        let mut map = tunnels.lock().unwrap_or_else(|error| error.into_inner());
        let ids: Vec<String> = map.keys().cloned().collect();
        statuses = Vec::with_capacity(ids.len());

        for id in &ids {
            let Some(process) = map.get_mut(id) else {
                continue;
            };

            let status = status_from_process_cached(process);

            if let TunnelSpec::Reverse(tunnel) = &process.spec {
                let due = process.child.is_some()
                    && process
                        .last_remote_health_at
                        .map_or(true, |at| at.elapsed() >= TUNNEL_REMOTE_HEALTH_INTERVAL);

                if due {
                    process.last_remote_health_at = Some(Instant::now());
                    probe_jobs.push((
                        id.clone(),
                        process.config.clone(),
                        tunnel.remote_port,
                        tunnel.local_port,
                    ));
                }
            }

            statuses.push(status);
        }
    }

    for (id, config, remote_port, local_port) in probe_jobs {
        let health = probe_reverse_health(&config, remote_port, local_port);

        {
            let mut map = tunnels.lock().unwrap_or_else(|error| error.into_inner());
            if let Some(process) = map.get_mut(&id) {
                process.last_remote_health = Some(health.clone());
            }
        }

        if let Some(status) = statuses
            .iter_mut()
            .find(|status| status.tunnel_id.as_deref() == Some(id.as_str()))
        {
            // Уточняем статус только у живого туннеля: reap между фазами мог его
            // убить, и тогда фоновую remote-проверку игнорируем.
            if status.pid.is_some() {
                status.status = health.0.clone();
                status.error_message = health.1.clone();
            }
        }
    }

    {
        let mut cached = cache.lock().unwrap_or_else(|error| error.into_inner());
        *cached = statuses;
    }
}

/// Бесконечный цикл фонового вотчдога. Запускается в отдельном потоке из
/// `lib.rs` и поддерживает туннели живыми всё время работы приложения —
/// независимо от того, открыто окно настроек или скрыто.
pub fn run_tunnel_watchdog(app: tauri::AppHandle) {
    loop {
        {
            let manager = app.state::<ServerSessionManager>();
            tick_tunnel_map(&manager.reverse_tunnels, &manager.reverse_status_cache);
            tick_tunnel_map(&manager.local_tunnels, &manager.local_status_cache);
        }

        thread::sleep(TUNNEL_WATCHDOG_INTERVAL);
    }
}

/// Немедленно убирает туннель из кэша статусов (например, после ручного stop),
/// чтобы UI не «мигал» закэшированным connected до следующего тика вотчдога.
fn drop_cached_status(cache: &Mutex<Vec<ServerSessionStatus>>, tunnel_id: &str) {
    cache
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .retain(|status| status.tunnel_id.as_deref() != Some(tunnel_id));
}

fn add_non_multiplexed_ssh_options(command: &mut Command) -> &mut Command {
    command
        .arg("-o")
        .arg("ControlMaster=no")
        .arg("-o")
        .arg("ControlPath=none")
        .arg("-o")
        .arg("ControlPersist=no")
}

fn add_non_multiplexed_tokio_ssh_options(
    command: &mut tokio::process::Command,
) -> &mut tokio::process::Command {
    command
        .arg("-o")
        .arg("ControlMaster=no")
        .arg("-o")
        .arg("ControlPath=none")
        .arg("-o")
        .arg("ControlPersist=no")
}

fn spawn_ssh_log_reader<R>(
    label: &'static str,
    reader: R,
    captured_lines: Option<Arc<Mutex<Vec<String>>>>,
) where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let buffered = BufReader::new(reader);

        for line in buffered.lines().map_while(Result::ok) {
            let trimmed = line.trim();

            if !trimmed.is_empty() {
                if let Some(lines) = &captured_lines {
                    let mut lines = lines.lock().unwrap_or_else(|error| error.into_inner());

                    if lines.len() < SSH_STARTUP_OUTPUT_LINE_LIMIT {
                        lines.push(trimmed.to_string());
                    }
                }

                logger::log_info("SERVER_SESSION", &format!("ssh {}: {}", label, trimmed));
            }
        }
    });
}

fn build_local_ssh_command(
    config: &ServerSessionConfig,
    tunnel: &LocalTunnelConfig,
) -> Result<Command, String> {
    ensure_system_tool_available("ssh")?;
    validate_vds_config(config)?;
    validate_tunnel_id(&tunnel.id)?;
    validate_port(tunnel.local_port, "localPort")?;
    validate_port(tunnel.remote_port, "remotePort")?;

    let host = trim_required(&config.host, "host")?;
    let username = trim_required(&config.username, "username")?;
    let local_forward = format!(
        "127.0.0.1:{}:127.0.0.1:{}",
        tunnel.local_port, tunnel.remote_port
    );

    let mut command = Command::new("ssh");
    command
        .arg("-N")
        .arg("-T")
        .arg("-L")
        .arg(local_forward)
        .arg("-p")
        .arg(config.ssh_port.to_string())
        .arg("-o")
        .arg("ExitOnForwardFailure=yes")
        .arg("-o")
        .arg("ServerAliveInterval=15")
        .arg("-o")
        .arg("ServerAliveCountMax=3")
        .arg("-o")
        .arg("TCPKeepAlive=yes")
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new");
    add_non_multiplexed_ssh_options(&mut command);

    if let Some(identity_file) = identity_file_path(config) {
        command.arg("-i").arg(identity_file);
    }

    command
        .arg(format!("{}@{}", username, host))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    Ok(command)
}

fn build_reverse_ssh_command(
    config: &ServerSessionConfig,
    tunnel: &ReverseTunnelConfig,
) -> Result<Command, String> {
    ensure_system_tool_available("ssh")?;
    validate_vds_config(config)?;
    validate_tunnel_id(&tunnel.id)?;
    validate_port(tunnel.remote_port, "remotePort")?;
    validate_port(tunnel.local_port, "localPort")?;

    let host = trim_required(&config.host, "host")?;
    let username = trim_required(&config.username, "username")?;
    let remote_forward = format!(
        "127.0.0.1:{}:127.0.0.1:{}",
        tunnel.remote_port, tunnel.local_port
    );

    let mut command = Command::new("ssh");
    command
        .arg("-N")
        .arg("-T")
        .arg("-R")
        .arg(remote_forward)
        .arg("-p")
        .arg(config.ssh_port.to_string())
        .arg("-o")
        .arg("ExitOnForwardFailure=yes")
        .arg("-o")
        .arg("ServerAliveInterval=15")
        .arg("-o")
        .arg("ServerAliveCountMax=3")
        .arg("-o")
        .arg("TCPKeepAlive=yes")
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new");
    add_non_multiplexed_ssh_options(&mut command);

    if let Some(identity_file) = identity_file_path(config) {
        command.arg("-i").arg(identity_file);
    }

    command
        .arg(format!("{}@{}", username, host))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    Ok(command)
}

fn build_tokio_ssh_test_command(
    config: &ServerSessionConfig,
) -> Result<tokio::process::Command, String> {
    ensure_system_tool_available("ssh")?;
    validate_vds_config(config)?;

    let host = trim_required(&config.host, "host")?;
    let username = trim_required(&config.username, "username")?;
    let mut command = tokio::process::Command::new("ssh");

    command
        .arg("-p")
        .arg(config.ssh_port.to_string())
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ConnectTimeout=5")
        .arg("-o")
        .arg("ConnectionAttempts=1")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new");
    add_non_multiplexed_tokio_ssh_options(&mut command);

    if let Some(identity_file) = identity_file_path(config) {
        command.arg("-i").arg(identity_file);
    }

    command
        .arg(format!("{}@{}", username, host))
        .arg("echo shared-vds-ok")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    Ok(command)
}

fn build_tokio_vds_health_command(
    config: &ServerSessionConfig,
) -> Result<tokio::process::Command, String> {
    ensure_system_tool_available("ssh")?;
    validate_vds_config(config)?;

    let host = trim_required(&config.host, "host")?;
    let username = trim_required(&config.username, "username")?;
    let mut command = tokio::process::Command::new("ssh");

    command
        .arg("-p")
        .arg(config.ssh_port.to_string())
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ConnectTimeout=5")
        .arg("-o")
        .arg("ConnectionAttempts=1")
        .arg("-o")
        .arg("LogLevel=ERROR")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new");
    add_non_multiplexed_tokio_ssh_options(&mut command);

    if let Some(identity_file) = identity_file_path(config) {
        command.arg("-i").arg(identity_file);
    }

    command
        .arg(format!("{}@{}", username, host))
        .arg(format!("sh -lc {}", posix_shell_quote(VDS_HEALTH_SCRIPT)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    Ok(command)
}

fn checked_at_now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn vds_health_status(
    status: VdsHealthState,
    checked_at: String,
    message: Option<String>,
    metrics: Option<VdsHealthMetrics>,
    location: Option<VdsLocation>,
) -> VdsHealthStatus {
    VdsHealthStatus {
        status,
        checked_at,
        message,
        metrics,
        location,
    }
}

fn vds_health_error(checked_at: String, message: String) -> VdsHealthStatus {
    vds_health_status(VdsHealthState::Error, checked_at, Some(message), None, None)
}

fn vds_location_cache_key(config: &ServerSessionConfig) -> Option<String> {
    let host = config.host.trim();

    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

fn vds_location_cache() -> &'static Mutex<HashMap<String, VdsLocationCacheEntry>> {
    VDS_LOCATION_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached_vds_location_entry(key: &str) -> Option<Option<VdsLocation>> {
    let cache = vds_location_cache().lock().ok()?;
    let entry = cache.get(key)?;
    let ttl = if entry.location.is_some() {
        VDS_LOCATION_SUCCESS_TTL
    } else {
        VDS_LOCATION_ERROR_TTL
    };

    (entry.checked_at.elapsed() < ttl).then(|| entry.location.clone())
}

fn remember_vds_location(key: String, location: Option<VdsLocation>) {
    if let Ok(mut cache) = vds_location_cache().lock() {
        cache.insert(
            key,
            VdsLocationCacheEntry {
                checked_at: Instant::now(),
                location,
            },
        );
    }
}

fn normalize_location_text(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn normalize_lookup_host(host: &str) -> &str {
    host.strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(host)
}

fn build_vds_location(
    ip: IpAddr,
    response_ip: Option<String>,
    country: Option<String>,
    city: Option<String>,
) -> Option<VdsLocation> {
    let country = normalize_location_text(country);
    let city = normalize_location_text(city);

    if country.is_none() && city.is_none() {
        return None;
    }

    Some(VdsLocation {
        ip: response_ip.unwrap_or_else(|| ip.to_string()),
        country,
        city,
    })
}

async fn resolve_vds_location_ip(config: &ServerSessionConfig) -> Option<IpAddr> {
    let host = trim_required(&config.host, "host").ok()?;
    let lookup_host = normalize_lookup_host(&host);

    if let Ok(ip) = lookup_host.parse::<IpAddr>() {
        return Some(ip);
    }

    let mut addrs = tokio::time::timeout(
        VDS_LOCATION_LOOKUP_TIMEOUT,
        tokio::net::lookup_host((lookup_host, config.ssh_port)),
    )
    .await
    .ok()?
    .ok()?;

    addrs.next().map(|addr| addr.ip())
}

async fn fetch_vds_location(config: &ServerSessionConfig) -> Option<VdsLocation> {
    let ip = resolve_vds_location_ip(config).await?;
    let client = reqwest::Client::builder()
        .timeout(VDS_LOCATION_LOOKUP_TIMEOUT)
        .user_agent("Shared VDS/0.1")
        .build()
        .ok()?;

    fetch_ipwhois_location(&client, ip).await
}

async fn fetch_ipwhois_location(client: &reqwest::Client, ip: IpAddr) -> Option<VdsLocation> {
    let response = client
        .get(format!("https://ipwho.is/{}", ip))
        .send()
        .await
        .ok()?;

    if !response.status().is_success() {
        return None;
    }

    let body = response.json::<IpWhoIsLocationResponse>().await.ok()?;

    if body.success == Some(false) {
        return None;
    }

    build_vds_location(ip, body.ip, body.country, body.city)
}

async fn cached_vds_location(config: &ServerSessionConfig) -> Option<VdsLocation> {
    let key = vds_location_cache_key(config)?;

    if let Some(location) = cached_vds_location_entry(&key) {
        return location;
    }

    let location = fetch_vds_location(config).await;
    remember_vds_location(key, location.clone());

    location
}

fn parse_health_f64(value: Option<&&str>) -> Option<f64> {
    value
        .map(|value| value.split_whitespace().next().unwrap_or(""))
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite())
}

fn parse_health_u32(value: Option<&&str>) -> Option<u32> {
    value
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .and_then(|value| value.parse::<u32>().ok())
}

fn parse_health_u64(value: Option<&&str>) -> Option<u64> {
    value
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .and_then(|value| value.parse::<u64>().ok())
}

fn format_uptime_seconds(seconds: u64) -> String {
    let days = seconds / 86_400;
    let hours = (seconds % 86_400) / 3_600;
    let minutes = (seconds % 3_600) / 60;

    if days > 0 {
        format!("{}d {}h", days, hours)
    } else if hours > 0 {
        format!("{}h {}m", hours, minutes)
    } else {
        format!("{}m", minutes)
    }
}

fn normalize_uptime(value: Option<&&str>, seconds: Option<u64>) -> Option<String> {
    let uptime = value
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| value.strip_prefix("up ").unwrap_or(value).to_string());

    uptime.or_else(|| seconds.map(format_uptime_seconds))
}

fn parse_vds_health_output(output: &str) -> ParsedVdsHealth {
    let values = output
        .lines()
        .filter_map(|line| {
            let (key, value) = line.split_once('=')?;
            Some((key.trim(), value.trim()))
        })
        .collect::<HashMap<_, _>>();

    let os = values.get("OS").copied().unwrap_or("unknown");
    if os != "Linux" {
        let message = if os == "unknown" {
            "VDS ответил, но remote OS не определена. В этой версии мониторинг поддерживает Linux VDS.".to_string()
        } else {
            format!(
                "Remote OS `{}` пока не поддержана. В этой версии мониторинг поддерживает Linux VDS.",
                os
            )
        };

        return ParsedVdsHealth {
            status: VdsHealthState::Degraded,
            message: Some(message),
            metrics: None,
        };
    }

    let memory_total_kb = parse_health_u64(values.get("MEM_TOTAL_KB"));
    let memory_available_kb = parse_health_u64(values.get("MEM_AVAILABLE_KB"));
    let memory_total_bytes = memory_total_kb.map(|value| value.saturating_mul(1024));
    let memory_used_bytes = memory_total_kb
        .zip(memory_available_kb)
        .map(|(total, available)| total.saturating_sub(available).saturating_mul(1024));
    let metrics = VdsHealthMetrics {
        load_average: parse_health_f64(values.get("LOAD_AVG")),
        cpu_cores: parse_health_u32(values.get("CPU_CORES")),
        memory_total_bytes,
        memory_used_bytes,
        disk_total_bytes: parse_health_u64(values.get("DISK_TOTAL_BYTES")),
        disk_used_bytes: parse_health_u64(values.get("DISK_USED_BYTES")),
        uptime: normalize_uptime(
            values.get("UPTIME"),
            parse_health_u64(values.get("UPTIME_SECONDS")),
        ),
    };
    let has_any_metric = metrics.load_average.is_some()
        || metrics.cpu_cores.is_some()
        || metrics.memory_total_bytes.is_some()
        || metrics.memory_used_bytes.is_some()
        || metrics.disk_total_bytes.is_some()
        || metrics.disk_used_bytes.is_some()
        || metrics.uptime.is_some();

    if !has_any_metric {
        return ParsedVdsHealth {
            status: VdsHealthState::Degraded,
            message: Some("VDS ответил, но метрики Linux не удалось прочитать.".to_string()),
            metrics: None,
        };
    }

    let has_primary_metrics = metrics.load_average.is_some()
        && metrics.memory_total_bytes.is_some()
        && metrics.memory_used_bytes.is_some()
        && metrics.disk_total_bytes.is_some()
        && metrics.disk_used_bytes.is_some();

    ParsedVdsHealth {
        status: if has_primary_metrics {
            VdsHealthState::Ok
        } else {
            VdsHealthState::Degraded
        },
        message: (!has_primary_metrics).then(|| "Метрики VDS получены частично.".to_string()),
        metrics: Some(metrics),
    }
}

fn limited_output_detail(stdout: &[u8], stderr: &[u8], fallback: String) -> String {
    let stderr = String::from_utf8_lossy(stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(stdout).trim().to_string();
    let detail = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        fallback
    };

    if detail.chars().count() <= 360 {
        detail
    } else {
        detail.chars().take(357).collect::<String>() + "..."
    }
}

fn vds_health_failure_message(detail: &str) -> String {
    let normalized = detail.to_lowercase();

    if normalized.contains("permission denied") {
        return "SSH ключ не принят VDS. Проверьте пользователя, путь к ключу и authorized_keys на сервере."
            .to_string();
    }

    if normalized.contains("connection timed out") || normalized.contains("operation timed out") {
        return "SSH к VDS не ответил за timeout. Проверьте IP, порт SSH и firewall.".to_string();
    }

    if normalized.contains("connection refused") {
        return "VDS отклонил SSH подключение. Проверьте SSH порт и запущен ли sshd на сервере."
            .to_string();
    }

    if normalized.contains("could not resolve hostname")
        || normalized.contains("name or service not known")
    {
        return "Не удалось разрешить IP/домен VDS. Проверьте поле сервера.".to_string();
    }

    if normalized.contains("host key verification failed")
        || normalized.contains("remote host identification has changed")
    {
        return "SSH host key VDS не прошел проверку. Проверьте known_hosts перед повторной попыткой."
            .to_string();
    }

    format!("SSH проверка не прошла: {}", detail)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CommandLineSyntax {
    Posix,
    PowerShell,
}

fn posix_shell_quote(value: &str) -> String {
    if value.is_empty() {
        "''".to_string()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

fn powershell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn command_line_quote(value: &str, syntax: CommandLineSyntax) -> String {
    match syntax {
        CommandLineSyntax::Posix => posix_shell_quote(value),
        CommandLineSyntax::PowerShell => powershell_quote(value),
    }
}

fn applescript_quote(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn build_interactive_ssh_command_for_syntax(
    config: &ServerSessionConfig,
    syntax: CommandLineSyntax,
) -> Result<String, String> {
    build_interactive_ssh_command_for_syntax_with_options(config, syntax, true, false)
}

fn build_interactive_ssh_command_for_syntax_with_options(
    config: &ServerSessionConfig,
    syntax: CommandLineSyntax,
    include_identity_file: bool,
    prefer_password: bool,
) -> Result<String, String> {
    ensure_system_tool_available("ssh")?;
    validate_vds_config(config)?;

    let host = trim_required(&config.host, "host")?;
    let username = trim_required(&config.username, "username")?;
    let mut parts = vec![
        "ssh".to_string(),
        "-p".to_string(),
        command_line_quote(&config.ssh_port.to_string(), syntax),
        "-o".to_string(),
        command_line_quote("ControlMaster=no", syntax),
        "-o".to_string(),
        command_line_quote("ControlPath=none", syntax),
        "-o".to_string(),
        command_line_quote("ControlPersist=no", syntax),
    ];

    if prefer_password {
        parts.push("-o".to_string());
        parts.push(command_line_quote(
            "PreferredAuthentications=password,keyboard-interactive,publickey",
            syntax,
        ));
        parts.push("-o".to_string());
        parts.push(command_line_quote("BatchMode=no", syntax));
    }

    if include_identity_file {
        if let Some(identity_file) = identity_file_path(config) {
            parts.push("-i".to_string());
            parts.push(command_line_quote(&identity_file.to_string_lossy(), syntax));
        }
    }

    parts.push(command_line_quote(
        &format!("{}@{}", username, host),
        syntax,
    ));
    Ok(parts.join(" "))
}

fn build_interactive_ssh_command_set(
    config: &ServerSessionConfig,
) -> Result<TerminalCommandSet, String> {
    Ok(TerminalCommandSet {
        posix: build_interactive_ssh_command_for_syntax(config, CommandLineSyntax::Posix)?,
        powershell: build_interactive_ssh_command_for_syntax(
            config,
            CommandLineSyntax::PowerShell,
        )?,
    })
}

fn build_remote_ssh_command_for_syntax(
    config: &ServerSessionConfig,
    remote_command: &str,
    syntax: CommandLineSyntax,
) -> Result<String, String> {
    build_remote_ssh_command_for_syntax_with_options(config, remote_command, syntax, true, false)
}

fn build_remote_ssh_command_for_syntax_with_options(
    config: &ServerSessionConfig,
    remote_command: &str,
    syntax: CommandLineSyntax,
    include_identity_file: bool,
    prefer_password: bool,
) -> Result<String, String> {
    let mut command = build_interactive_ssh_command_for_syntax_with_options(
        config,
        syntax,
        include_identity_file,
        prefer_password,
    )?;
    command.push_str(" -t ");
    command.push_str(&command_line_quote(remote_command, syntax));
    Ok(command)
}

fn build_remote_ssh_command_set(
    config: &ServerSessionConfig,
    remote_command: &str,
) -> Result<TerminalCommandSet, String> {
    Ok(TerminalCommandSet {
        posix: build_remote_ssh_command_for_syntax(
            config,
            remote_command,
            CommandLineSyntax::Posix,
        )?,
        powershell: build_remote_ssh_command_for_syntax(
            config,
            remote_command,
            CommandLineSyntax::PowerShell,
        )?,
    })
}

fn build_key_install_ssh_command_for_syntax(
    config: &ServerSessionConfig,
    remote_command: &str,
    syntax: CommandLineSyntax,
) -> Result<String, String> {
    let ssh_command = build_remote_ssh_command_for_syntax_with_options(
        config,
        remote_command,
        syntax,
        false,
        true,
    )?;
    let prompt = "Введите пароль пользователя VDS, если терминал запросит его. После успешного входа SSH ключ будет записан в ~/.ssh/authorized_keys.";

    Ok(match syntax {
        CommandLineSyntax::Posix => format!(
            "printf '%s\\n' {}; {}; printf '%s\\n' {}; exec ${{SHELL:-sh}}",
            posix_shell_quote(prompt),
            ssh_command,
            posix_shell_quote("Команда записи ключа завершена. Терминал оставлен открытым.")
        ),
        CommandLineSyntax::PowerShell => format!(
            "Write-Host {}; {}; Write-Host {}",
            powershell_quote(prompt),
            ssh_command,
            powershell_quote("Команда записи ключа завершена.")
        ),
    })
}

fn build_key_install_ssh_command_set(
    config: &ServerSessionConfig,
    remote_command: &str,
) -> Result<TerminalCommandSet, String> {
    Ok(TerminalCommandSet {
        posix: build_key_install_ssh_command_for_syntax(
            config,
            remote_command,
            CommandLineSyntax::Posix,
        )?,
        powershell: build_key_install_ssh_command_for_syntax(
            config,
            remote_command,
            CommandLineSyntax::PowerShell,
        )?,
    })
}

fn build_remote_tcp_check_command(
    config: &ServerSessionConfig,
    remote_port: u16,
) -> Result<Command, String> {
    ensure_system_tool_available("ssh")?;
    validate_vds_config(config)?;
    validate_port(remote_port, "remotePort")?;

    let host = trim_required(&config.host, "host")?;
    let username = trim_required(&config.username, "username")?;
    let remote_check = format!(
        "if command -v nc >/dev/null 2>&1; then nc -z -w 1 127.0.0.1 {0}; check_status=$?; elif command -v bash >/dev/null 2>&1; then bash -lc ': > /dev/tcp/127.0.0.1/{0}'; check_status=$?; else echo 'Neither nc nor bash is available for VDS port check.' >&2; exit 126; fi; if [ \"$check_status\" -eq 0 ]; then exit 0; fi; if [ \"$check_status\" -eq 1 ]; then exit 17; fi; echo \"VDS port check command failed with status $check_status\" >&2; exit \"$check_status\"",
        remote_port
    );

    let mut command = Command::new("ssh");
    command
        .arg("-p")
        .arg(config.ssh_port.to_string())
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ConnectTimeout=2")
        .arg("-o")
        .arg("ConnectionAttempts=1")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new");
    add_non_multiplexed_ssh_options(&mut command);

    if let Some(identity_file) = identity_file_path(config) {
        command.arg("-i").arg(identity_file);
    }

    command
        .arg(format!("{}@{}", username, host))
        .arg(format!("sh -lc {}", posix_shell_quote(&remote_check)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    Ok(command)
}

fn run_remote_tcp_check(mut command: Command, timeout: Duration) -> RemoteTcpCheckResult {
    let Ok(mut child) = command.spawn() else {
        return RemoteTcpCheckResult::Failed("не удалось запустить SSH-проверку".to_string());
    };

    let started_at = Instant::now();
    while started_at.elapsed() < timeout {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = match child.wait_with_output() {
                    Ok(output) => output,
                    Err(error) => {
                        return RemoteTcpCheckResult::Failed(format!(
                            "не удалось прочитать результат SSH-проверки: {}",
                            error
                        ));
                    }
                };

                if status.success() {
                    return RemoteTcpCheckResult::Available;
                }

                if status.code() == Some(17) {
                    return RemoteTcpCheckResult::Unavailable;
                }

                let detail = limited_output_detail(
                    &output.stdout,
                    &output.stderr,
                    format!("SSH-проверка завершилась со статусом {}", status),
                );

                return RemoteTcpCheckResult::Failed(detail);
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return RemoteTcpCheckResult::Failed(
                    "не удалось прочитать статус SSH-проверки".to_string(),
                );
            }
        }
    }

    let _ = child.kill();
    let _ = child.wait();
    RemoteTcpCheckResult::Failed("SSH-проверка порта VDS не ответила за timeout".to_string())
}

fn remote_tcp_available(config: &ServerSessionConfig, remote_port: u16) -> RemoteTcpCheckResult {
    match build_remote_tcp_check_command(config, remote_port) {
        Ok(command) => run_remote_tcp_check(command, Duration::from_secs(8)),
        Err(error) => RemoteTcpCheckResult::Failed(error),
    }
}

const TERMINAL_NOT_FOUND_PREFIX: &str = "TERMINAL_NOT_FOUND:";
const WARP_SHARED_VDS_TAB_CONFIG_NAME: &str = "shared_vds_open";

#[derive(Debug, Clone, PartialEq, Eq)]
struct TerminalCommandSet {
    posix: String,
    powershell: String,
}

impl TerminalCommandSet {
    fn same(command: &str) -> Self {
        Self {
            posix: command.to_string(),
            powershell: command.to_string(),
        }
    }

    fn command(&self, syntax: CommandLineSyntax) -> &str {
        match syntax {
            CommandLineSyntax::Posix => &self.posix,
            CommandLineSyntax::PowerShell => &self.powershell,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TerminalAvailability {
    SystemTool,
    SystemToolAlternatives(&'static [&'static str]),
    GitBash,
    MacosApplication(&'static str),
    WarpUri(DesktopPlatform),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TerminalPreparation {
    WarpTabConfig {
        platform: DesktopPlatform,
        command: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TerminalLaunch {
    id: TerminalId,
    program: String,
    args: Vec<String>,
    wait_for_exit: bool,
    availability: TerminalAvailability,
    preparation: Option<TerminalPreparation>,
}

fn terminal_launch_candidates(platform: DesktopPlatform, command: &str) -> Vec<TerminalLaunch> {
    terminal_launch_candidates_for_commands(platform, &TerminalCommandSet::same(command))
}

fn terminal_launch_candidates_for_commands(
    platform: DesktopPlatform,
    commands: &TerminalCommandSet,
) -> Vec<TerminalLaunch> {
    match platform {
        DesktopPlatform::Macos => {
            macos_terminal_launch_candidates(commands.command(CommandLineSyntax::Posix))
        }
        DesktopPlatform::Windows => windows_terminal_launch_candidates(commands),
        DesktopPlatform::Linux | DesktopPlatform::Unknown => {
            let command = commands.command(CommandLineSyntax::Posix);
            vec![
                TerminalLaunch {
                    id: TerminalId::System,
                    program: "x-terminal-emulator".to_string(),
                    args: terminal_e_args("sh", command),
                    wait_for_exit: false,
                    availability: TerminalAvailability::SystemTool,
                    preparation: None,
                },
                TerminalLaunch {
                    id: TerminalId::Ghostty,
                    program: "ghostty".to_string(),
                    args: terminal_e_args("sh", command),
                    wait_for_exit: false,
                    availability: TerminalAvailability::SystemTool,
                    preparation: None,
                },
                TerminalLaunch {
                    id: TerminalId::Warp,
                    program: "warp-terminal".to_string(),
                    args: vec![warp_tab_config_url().to_string()],
                    wait_for_exit: false,
                    availability: TerminalAvailability::WarpUri(platform),
                    preparation: Some(TerminalPreparation::WarpTabConfig {
                        platform,
                        command: command.to_string(),
                    }),
                },
                TerminalLaunch {
                    id: TerminalId::GnomeTerminal,
                    program: "gnome-terminal".to_string(),
                    args: vec![
                        "--".to_string(),
                        "sh".to_string(),
                        "-lc".to_string(),
                        command.to_string(),
                    ],
                    wait_for_exit: false,
                    availability: TerminalAvailability::SystemTool,
                    preparation: None,
                },
                TerminalLaunch {
                    id: TerminalId::Konsole,
                    program: "konsole".to_string(),
                    args: terminal_e_args("sh", command),
                    wait_for_exit: false,
                    availability: TerminalAvailability::SystemTool,
                    preparation: None,
                },
                TerminalLaunch {
                    id: TerminalId::Xfce4Terminal,
                    program: "xfce4-terminal".to_string(),
                    args: vec![
                        "--command".to_string(),
                        format!("sh -lc {}", posix_shell_quote(command)),
                    ],
                    wait_for_exit: false,
                    availability: TerminalAvailability::SystemTool,
                    preparation: None,
                },
            ]
        }
    }
}

fn macos_terminal_launch_candidates(command: &str) -> Vec<TerminalLaunch> {
    let terminal_script = format!(
        "tell application \"Terminal\" to do script \"{}\"",
        applescript_quote(command)
    );
    let iterm_script = format!(
        "tell application \"iTerm\" to activate\n\
         tell application \"iTerm\" to set newWindow to (create window with default profile)\n\
         tell application \"iTerm\" to tell current session of newWindow to write text \"{}\"",
        applescript_quote(command)
    );

    vec![
        TerminalLaunch {
            id: TerminalId::System,
            program: "osascript".to_string(),
            args: vec![
                "-e".to_string(),
                terminal_script,
                "-e".to_string(),
                "tell application \"Terminal\" to activate".to_string(),
            ],
            wait_for_exit: true,
            availability: TerminalAvailability::MacosApplication("Terminal"),
            preparation: None,
        },
        macos_open_app_shell_candidate(TerminalId::Ghostty, "Ghostty", command),
        TerminalLaunch {
            id: TerminalId::Warp,
            program: "open".to_string(),
            args: vec![warp_tab_config_url().to_string()],
            wait_for_exit: false,
            availability: TerminalAvailability::WarpUri(DesktopPlatform::Macos),
            preparation: Some(TerminalPreparation::WarpTabConfig {
                platform: DesktopPlatform::Macos,
                command: command.to_string(),
            }),
        },
        TerminalLaunch {
            id: TerminalId::Iterm2,
            program: "osascript".to_string(),
            args: vec!["-e".to_string(), iterm_script],
            wait_for_exit: true,
            availability: TerminalAvailability::MacosApplication("iTerm"),
            preparation: None,
        },
        macos_open_app_shell_candidate(TerminalId::Alacritty, "Alacritty", command),
        macos_open_app_shell_candidate(TerminalId::Kitty, "kitty", command),
    ]
}

fn macos_open_app_shell_candidate(
    id: TerminalId,
    app_name: &'static str,
    command: &str,
) -> TerminalLaunch {
    TerminalLaunch {
        id,
        program: "open".to_string(),
        args: vec![
            "-na".to_string(),
            app_name.to_string(),
            "--args".to_string(),
            "-e".to_string(),
            "/bin/sh".to_string(),
            "-lc".to_string(),
            command.to_string(),
        ],
        wait_for_exit: false,
        availability: TerminalAvailability::MacosApplication(app_name),
        preparation: None,
    }
}

fn windows_terminal_launch_candidates(commands: &TerminalCommandSet) -> Vec<TerminalLaunch> {
    let powershell_command = commands.command(CommandLineSyntax::PowerShell);
    let git_bash_command = commands.command(CommandLineSyntax::Posix);

    vec![
        TerminalLaunch {
            id: TerminalId::System,
            program: "cmd.exe".to_string(),
            args: vec![
                "/C".to_string(),
                "start".to_string(),
                "".to_string(),
                "powershell.exe".to_string(),
                "-NoExit".to_string(),
                "-Command".to_string(),
                powershell_command.to_string(),
            ],
            wait_for_exit: false,
            availability: TerminalAvailability::SystemTool,
            preparation: None,
        },
        TerminalLaunch {
            id: TerminalId::Ghostty,
            program: "ghostty.exe".to_string(),
            args: vec![
                "-e".to_string(),
                "powershell.exe".to_string(),
                "-NoExit".to_string(),
                "-Command".to_string(),
                powershell_command.to_string(),
            ],
            wait_for_exit: false,
            availability: TerminalAvailability::SystemTool,
            preparation: None,
        },
        TerminalLaunch {
            id: TerminalId::Warp,
            program: "cmd.exe".to_string(),
            args: vec![
                "/C".to_string(),
                "start".to_string(),
                "".to_string(),
                warp_tab_config_url().to_string(),
            ],
            wait_for_exit: false,
            availability: TerminalAvailability::WarpUri(DesktopPlatform::Windows),
            preparation: Some(TerminalPreparation::WarpTabConfig {
                platform: DesktopPlatform::Windows,
                command: powershell_command.to_string(),
            }),
        },
        TerminalLaunch {
            id: TerminalId::WindowsTerminal,
            program: "wt.exe".to_string(),
            args: vec![
                "powershell.exe".to_string(),
                "-NoExit".to_string(),
                "-Command".to_string(),
                powershell_command.to_string(),
            ],
            wait_for_exit: false,
            availability: TerminalAvailability::SystemTool,
            preparation: None,
        },
        TerminalLaunch {
            id: TerminalId::Powershell,
            program: "powershell.exe".to_string(),
            args: vec![
                "-NoExit".to_string(),
                "-Command".to_string(),
                powershell_command.to_string(),
            ],
            wait_for_exit: false,
            availability: TerminalAvailability::SystemToolAlternatives(&[
                "powershell.exe",
                "pwsh.exe",
            ]),
            preparation: None,
        },
        TerminalLaunch {
            id: TerminalId::GitBash,
            program: "git-bash.exe".to_string(),
            args: vec![
                "-c".to_string(),
                format!("{}; exec bash -l", git_bash_command),
            ],
            wait_for_exit: false,
            availability: TerminalAvailability::GitBash,
            preparation: None,
        },
    ]
}

fn terminal_e_args(shell: &str, command: &str) -> Vec<String> {
    vec![
        "-e".to_string(),
        shell.to_string(),
        "-lc".to_string(),
        command.to_string(),
    ]
}

fn terminal_option_label(id: TerminalId) -> &'static str {
    match id {
        TerminalId::System => "System default",
        TerminalId::Ghostty => "Ghostty",
        TerminalId::Warp => "Warp",
        TerminalId::Iterm2 => "iTerm2",
        TerminalId::Alacritty => "Alacritty",
        TerminalId::Kitty => "kitty",
        TerminalId::WindowsTerminal => "Windows Terminal",
        TerminalId::Powershell => "PowerShell",
        TerminalId::GitBash => "Git Bash",
        TerminalId::GnomeTerminal => "GNOME Terminal",
        TerminalId::Konsole => "Konsole",
        TerminalId::Xfce4Terminal => "Xfce Terminal",
    }
}

fn terminal_launch_candidates_for_selection(
    platform: DesktopPlatform,
    commands: &TerminalCommandSet,
    terminal_id: Option<TerminalId>,
) -> Vec<TerminalLaunch> {
    let candidates = terminal_launch_candidates_for_commands(platform, commands);

    match terminal_id {
        Some(id) if id != TerminalId::System => {
            let mut selected = candidates
                .iter()
                .filter(|candidate| candidate.id == id)
                .cloned()
                .collect::<Vec<_>>();

            selected.extend(
                candidates
                    .into_iter()
                    .filter(|candidate| candidate.id != id),
            );
            selected
        }
        _ => candidates,
    }
}

fn terminal_launcher_available(platform: DesktopPlatform) -> bool {
    terminal_launch_candidates(platform, "true")
        .iter()
        .any(terminal_candidate_available)
}

fn terminal_candidate_available(candidate: &TerminalLaunch) -> bool {
    resolve_terminal_program(candidate).is_some()
}

fn resolve_terminal_program(candidate: &TerminalLaunch) -> Option<String> {
    match candidate.availability {
        TerminalAvailability::SystemTool => {
            system_tool_available(&candidate.program).then(|| candidate.program.clone())
        }
        TerminalAvailability::SystemToolAlternatives(programs) => programs
            .iter()
            .find(|program| system_tool_available(program))
            .map(|program| (*program).to_string()),
        TerminalAvailability::GitBash => {
            git_bash_executable().map(|path| path.to_string_lossy().into_owned())
        }
        TerminalAvailability::MacosApplication(app_name) => {
            macos_application_available(app_name).then(|| candidate.program.clone())
        }
        TerminalAvailability::WarpUri(platform) => {
            warp_uri_available(platform).then(|| candidate.program.clone())
        }
    }
}

fn macos_application_available(app_name: &str) -> bool {
    if !system_tool_available("osascript") {
        return false;
    }

    let script = format!("id of app \"{}\"", applescript_quote(app_name));
    Command::new("osascript")
        .args(["-e", script.as_str()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn git_bash_executable() -> Option<PathBuf> {
    if system_tool_available("git-bash.exe") {
        return Some(PathBuf::from("git-bash.exe"));
    }

    windows_program_files_dirs()
        .into_iter()
        .map(|dir| dir.join("Git").join("git-bash.exe"))
        .find(|path| executable_file_exists(path))
}

fn windows_program_files_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for key in ["ProgramFiles", "PROGRAMFILES", "ProgramFiles(x86)"] {
        if let Some(value) = env::var_os(key) {
            let path = PathBuf::from(value);
            if !dirs.iter().any(|existing| existing == &path) {
                dirs.push(path);
            }
        }
    }

    for path in [
        PathBuf::from(r"C:\Program Files"),
        PathBuf::from(r"C:\Program Files (x86)"),
    ] {
        if !dirs.iter().any(|existing| existing == &path) {
            dirs.push(path);
        }
    }

    dirs
}

fn warp_uri_available(platform: DesktopPlatform) -> bool {
    match platform {
        DesktopPlatform::Macos => macos_application_available("Warp"),
        DesktopPlatform::Linux | DesktopPlatform::Unknown => system_tool_available("warp-terminal"),
        DesktopPlatform::Windows => {
            system_tool_available("cmd.exe")
                && (system_tool_available("warp.exe") || windows_warp_data_root_exists())
        }
    }
}

fn windows_warp_data_root_exists() -> bool {
    [env::var_os("APPDATA"), env::var_os("LOCALAPPDATA")]
        .into_iter()
        .flatten()
        .map(PathBuf::from)
        .any(|dir| dir.join("warp").join("Warp").exists())
}

fn warp_tab_config_dir(platform: DesktopPlatform) -> Result<PathBuf, String> {
    match platform {
        DesktopPlatform::Macos => {
            let home_dir =
                dirs::home_dir().ok_or_else(|| "Home directory was not found".to_string())?;
            Ok(home_dir.join(".warp").join("tab_configs"))
        }
        DesktopPlatform::Windows => env::var_os("APPDATA")
            .map(PathBuf::from)
            .map(|path| {
                path.join("warp")
                    .join("Warp")
                    .join("data")
                    .join("tab_configs")
            })
            .ok_or_else(|| "APPDATA directory was not found".to_string()),
        DesktopPlatform::Linux | DesktopPlatform::Unknown => {
            let data_home = env::var_os("XDG_DATA_HOME")
                .map(PathBuf::from)
                .or_else(|| dirs::home_dir().map(|home| home.join(".local").join("share")))
                .ok_or_else(|| "Home directory was not found".to_string())?;

            Ok(data_home.join("warp-terminal").join("tab_configs"))
        }
    }
}

fn warp_tab_config_url() -> &'static str {
    "warp://tab_config/shared_vds_open"
}

fn prepare_warp_tab_config(platform: DesktopPlatform, command: &str) -> Result<(), String> {
    let tab_configs_dir = warp_tab_config_dir(platform)?;
    fs::create_dir_all(&tab_configs_dir)
        .map_err(|error| format!("Failed to create Warp tab config directory: {}", error))?;

    let command_value = toml_basic_string(command)?;
    let tab_config = format!(
        r#"name = "Shared VDS"
title = "Shared VDS"

[[panes]]
id = "main"
type = "terminal"
commands = [{}]
is_focused = true
"#,
        command_value
    );
    let tab_config_path = tab_configs_dir.join(format!("{}.toml", WARP_SHARED_VDS_TAB_CONFIG_NAME));
    fs::write(&tab_config_path, tab_config).map_err(|error| {
        format!(
            "Failed to write Warp tab config {}: {}",
            tab_config_path.display(),
            error
        )
    })?;

    Ok(())
}

fn toml_basic_string(value: &str) -> Result<String, String> {
    serde_json::to_string(value)
        .map_err(|error| format!("Failed to encode terminal command: {}", error))
}

fn terminal_not_found_error(command: &str) -> String {
    format!("{}{}", TERMINAL_NOT_FOUND_PREFIX, command)
}

fn run_terminal_launch(candidate: &TerminalLaunch) -> Result<(), String> {
    if let Some(preparation) = &candidate.preparation {
        match preparation {
            TerminalPreparation::WarpTabConfig { platform, command } => {
                prepare_warp_tab_config(*platform, command)?;
            }
        }
    }

    let program = resolve_terminal_program(candidate)
        .ok_or_else(|| format!("Terminal program `{}` was not found", candidate.program))?;
    let mut command = Command::new(program);
    command
        .args(&candidate.args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    if candidate.wait_for_exit {
        let status = command
            .status()
            .map_err(|error| format!("Failed to open terminal: {}", error))?;

        if status.success() {
            Ok(())
        } else {
            Err(format!(
                "Terminal open command exited with status {}",
                status
            ))
        }
    } else {
        command
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("Failed to open terminal: {}", error))
    }
}

fn open_terminal_with_command(
    command: &str,
    terminal_id: Option<TerminalId>,
) -> Result<(), String> {
    open_terminal_with_commands(&TerminalCommandSet::same(command), terminal_id)
}

fn open_terminal_with_commands(
    commands: &TerminalCommandSet,
    terminal_id: Option<TerminalId>,
) -> Result<(), String> {
    let platform = current_platform();
    let candidates = terminal_launch_candidates_for_selection(platform, commands, terminal_id);
    let mut last_error: Option<String> = None;

    for candidate in candidates {
        if !terminal_candidate_available(&candidate) {
            continue;
        }

        match run_terminal_launch(&candidate) {
            Ok(()) => return Ok(()),
            Err(error) => last_error = Some(error),
        }
    }

    Err(last_error.unwrap_or_else(|| {
        let syntax = match platform {
            DesktopPlatform::Windows => CommandLineSyntax::PowerShell,
            _ => CommandLineSyntax::Posix,
        };
        terminal_not_found_error(commands.command(syntax))
    }))
}

#[tauri::command]
pub fn get_available_terminals() -> Vec<TerminalOption> {
    let platform = current_platform();
    let mut terminals = vec![TerminalOption {
        id: TerminalId::System,
        label: terminal_option_label(TerminalId::System).to_string(),
    }];

    for candidate in terminal_launch_candidates(platform, "true") {
        if !terminal_candidate_available(&candidate)
            || terminals.iter().any(|terminal| terminal.id == candidate.id)
        {
            continue;
        }

        terminals.push(TerminalOption {
            id: candidate.id,
            label: terminal_option_label(candidate.id).to_string(),
        });
    }

    terminals
}

fn local_ssh_support(local_ssh_port: u16) -> LocalSshSupport {
    let platform = current_platform();
    LocalSshSupport {
        platform,
        port: local_ssh_port,
        available: local_ssh_port > 0 && local_tcp_available(local_ssh_port),
        can_open_settings: match platform {
            DesktopPlatform::Macos => system_tool_available("open"),
            DesktopPlatform::Windows => {
                system_tool_available("cmd.exe") || system_tool_available("powershell.exe")
            }
            DesktopPlatform::Linux => terminal_launcher_available(platform),
            DesktopPlatform::Unknown => false,
        },
        can_request_enable: platform == DesktopPlatform::Macos,
        instructions_key: local_ssh_instructions_key(platform).to_string(),
    }
}

fn compute_vds_system_status(local_ssh_port: u16) -> VdsSystemStatus {
    let platform = current_platform();
    let ssh_available = system_tool_available("ssh");
    let ssh_keygen_available = system_tool_available("ssh-keygen");
    let missing_tools = [("ssh", ssh_available), ("ssh-keygen", ssh_keygen_available)]
        .into_iter()
        .filter_map(|(tool, available)| (!available).then_some(tool.to_string()))
        .collect();

    VdsSystemStatus {
        platform,
        tools: SystemToolStatus {
            ssh_available,
            ssh_keygen_available,
            missing_tools,
        },
        local_ssh: local_ssh_support(local_ssh_port),
    }
}

#[tauri::command]
pub async fn get_vds_system_status(local_ssh_port: u16) -> VdsSystemStatus {
    // local_ssh_support делает блокирующий TCP-connect (до 900 мс). Уводим его
    // с main-потока через spawn_blocking, чтобы UI не фризился на каждый поллинг.
    match tauri::async_runtime::spawn_blocking(move || compute_vds_system_status(local_ssh_port))
        .await
    {
        Ok(status) => status,
        Err(_) => compute_vds_system_status(local_ssh_port),
    }
}

#[tauri::command]
pub async fn get_vds_health(config: ServerSessionConfig) -> VdsHealthStatus {
    let checked_at = checked_at_now();
    let mut command = match build_tokio_vds_health_command(&config) {
        Ok(command) => command,
        Err(error) => return vds_health_error(checked_at, error),
    };

    let output = match tokio::time::timeout(VDS_HEALTH_TIMEOUT, command.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            return vds_health_error(checked_at, format!("Failed to run SSH check: {}", error))
        }
        Err(_) => {
            return vds_health_error(
                checked_at,
                "SSH проверка не ответила за 7 секунд.".to_string(),
            )
        }
    };

    if !output.status.success() {
        let detail = limited_output_detail(
            &output.stdout,
            &output.stderr,
            format!("ssh exited with status {}", output.status),
        );

        return vds_health_error(checked_at, vds_health_failure_message(&detail));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed = parse_vds_health_output(&stdout);

    vds_health_status(
        parsed.status,
        checked_at,
        parsed.message,
        parsed.metrics,
        None,
    )
}

#[tauri::command]
pub async fn get_vds_location(config: ServerSessionConfig) -> Option<VdsLocation> {
    cached_vds_location(&config).await
}

#[tauri::command]
pub fn generate_ssh_key() -> Result<SshKeyInfo, String> {
    ensure_system_tool_available("ssh-keygen")?;

    let ssh_dir = shared_vds_ssh_dir()?;
    fs::create_dir_all(&ssh_dir)
        .map_err(|error| format!("Failed to create ~/.ssh directory: {}", error))?;

    let private_key_path = available_key_path()?;
    let status = Command::new("ssh-keygen")
        .arg("-t")
        .arg("ed25519")
        .arg("-f")
        .arg(&private_key_path)
        .arg("-N")
        .arg("")
        .arg("-C")
        .arg("shared-vds")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| format!("Failed to run ssh-keygen: {}", error))?;

    if !status.success() {
        return Err(format!("ssh-keygen exited with status {}", status));
    }

    set_private_key_permissions(&private_key_path)?;
    read_public_key(&private_key_path)
}

#[tauri::command]
pub fn read_ssh_public_key(private_key_path: String) -> Result<SshKeyInfo, String> {
    let private_key_path = PathBuf::from(trim_required(&private_key_path, "privateKeyPath")?);
    read_public_key(&private_key_path)
}

#[tauri::command]
pub async fn test_server_connection(
    config: ServerSessionConfig,
) -> Result<SshConnectionTestResult, String> {
    let output = tokio::time::timeout(
        Duration::from_secs(7),
        build_tokio_ssh_test_command(&config)?.output(),
    )
    .await
    .map_err(|_| "SSH проверка не ответила за 7 секунд.".to_string())?
    .map_err(|error| format!("Failed to run SSH test: {}", error))?;

    if output.status.success() {
        if let Err(error) = ensure_local_ssh_available(config.local_ssh_port) {
            return Ok(SshConnectionTestResult {
                ok: false,
                message: error,
            });
        }

        return Ok(SshConnectionTestResult {
            ok: true,
            message: "SSH к VDS и локальный SSH доступны.".to_string(),
        });
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("ssh exited with status {}", output.status)
    };

    let message = if detail.contains("Permission denied") {
        "SSH ключ не принят VDS. Откройте «Команды для записи ключа» и нажмите «Запустить»: терминал запросит пароль VDS и запишет ключ."
            .to_string()
    } else {
        format!("SSH подключение не удалось: {}", detail)
    };

    Ok(SshConnectionTestResult { ok: false, message })
}

#[tauri::command]
pub fn check_local_ssh_access(local_ssh_port: u16) -> SshConnectionTestResult {
    match ensure_local_ssh_available(local_ssh_port) {
        Ok(()) => SshConnectionTestResult {
            ok: true,
            message: "Локальный SSH доступен.".to_string(),
        },
        Err(error) => SshConnectionTestResult {
            ok: false,
            message: error,
        },
    }
}

#[tauri::command]
pub fn open_remote_login_settings(terminal_id: Option<TerminalId>) -> Result<(), String> {
    match current_platform() {
        DesktopPlatform::Macos => {
            let status = Command::new("open")
                .arg("x-apple.systempreferences:com.apple.Sharing-Settings.extension")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();

            match status {
                Ok(exit_status) if exit_status.success() => Ok(()),
                Ok(_) | Err(_) => open_system_settings_fallback(),
            }
        }
        DesktopPlatform::Windows => {
            let attempts: [(&str, &[&str]); 3] = [
                (
                    "cmd.exe",
                    &["/C", "start", "", "ms-settings:optionalfeatures"],
                ),
                ("cmd.exe", &["/C", "start", "", "services.msc"]),
                (
                    "powershell.exe",
                    &["-NoProfile", "-Command", "Start-Process services.msc"],
                ),
            ];

            let mut last_error: Option<String> = None;
            for (program, args) in attempts {
                if !system_tool_available(program) {
                    continue;
                }

                match Command::new(program)
                    .args(args)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                {
                    Ok(_) => return Ok(()),
                    Err(error) => last_error = Some(format!("{}", error)),
                }
            }

            Err(last_error.unwrap_or_else(|| {
                "Не удалось открыть настройки OpenSSH Server в Windows.".to_string()
            }))
        }
        DesktopPlatform::Linux => {
            let instruction = vec![
                "printf '%s\\n'".to_string(),
                posix_shell_quote("Shared VDS Local SSH setup"),
                posix_shell_quote("Debian/Ubuntu: sudo apt install openssh-server && sudo systemctl enable --now ssh"),
                posix_shell_quote("Fedora/RHEL: sudo dnf install openssh-server && sudo systemctl enable --now sshd"),
                posix_shell_quote("Arch: sudo pacman -S openssh && sudo systemctl enable --now sshd"),
                "; exec sh".to_string(),
            ]
            .join(" ");

            open_terminal_with_command(&instruction, terminal_id)
        }
        DesktopPlatform::Unknown => {
            Err("Открытие настроек Local SSH не поддержано для этой OS.".to_string())
        }
    }
}

#[tauri::command]
pub fn request_remote_login(local_ssh_port: u16) -> Result<SshConnectionTestResult, String> {
    #[cfg(target_os = "macos")]
    {
        let script =
            "do shell script \"systemsetup -setremotelogin on\" with administrator privileges";
        let status = Command::new("osascript")
            .arg("-e")
            .arg(script)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|error| format!("Failed to request Local SSH permission: {}", error))?;

        if !status.success() {
            return Ok(SshConnectionTestResult {
                ok: false,
                message: format!("Local SSH request exited with status {}", status),
            });
        }

        std::thread::sleep(Duration::from_millis(500));
        return Ok(check_local_ssh_access(local_ssh_port));
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(SshConnectionTestResult {
            ok: false,
            message:
                "Автоматическое включение Local SSH поддержано только на macOS через системный запрос."
                    .to_string(),
        })
    }
}

#[tauri::command]
pub fn open_server_terminal(
    config: ServerSessionConfig,
    terminal_id: Option<TerminalId>,
) -> Result<(), String> {
    let ssh_commands = build_interactive_ssh_command_set(&config)?;
    open_terminal_with_commands(&ssh_commands, terminal_id)
}

#[tauri::command]
pub fn open_server_terminal_command(
    config: ServerSessionConfig,
    command: String,
    terminal_id: Option<TerminalId>,
) -> Result<(), String> {
    let command = trim_required(&command, "command")?;
    let ssh_commands = build_remote_ssh_command_set(&config, &command)?;
    open_terminal_with_commands(&ssh_commands, terminal_id)
}

#[tauri::command]
pub fn open_server_key_install_terminal(
    config: ServerSessionConfig,
    command: String,
    terminal_id: Option<TerminalId>,
) -> Result<(), String> {
    let command = trim_required(&command, "command")?;
    let ssh_commands = build_key_install_ssh_command_set(&config, &command)?;
    open_terminal_with_commands(&ssh_commands, terminal_id)
}

#[tauri::command]
pub fn get_server_session_status(
    manager: tauri::State<'_, ServerSessionManager>,
) -> Vec<ServerSessionStatus> {
    // Отдаём закэшированные вотчдогом статусы. Никакого блокирующего сетевого
    // I/O на main-потоке UI — поэтому скролл и интерфейс не подвисают.
    manager
        .reverse_status_cache
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone()
}

#[tauri::command]
pub fn get_local_tunnel_status(
    manager: tauri::State<'_, ServerSessionManager>,
) -> Vec<ServerSessionStatus> {
    manager
        .local_status_cache
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone()
}

fn captured_ssh_lines(lines: &Arc<Mutex<Vec<String>>>) -> Vec<String> {
    lines
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone()
}

fn startup_output_excerpt(lines: &[String]) -> String {
    let output = lines.join(" ");
    let output = output.trim();

    if output.chars().count() <= 360 {
        return output.to_string();
    }

    output.chars().take(357).collect::<String>() + "..."
}

fn tunnel_startup_failure_message(
    context: TunnelStartupContext,
    exit_status: impl std::fmt::Display,
    stderr_lines: &[String],
) -> String {
    let stderr_excerpt = startup_output_excerpt(stderr_lines);
    let normalized_stderr = stderr_excerpt.to_lowercase();

    if normalized_stderr.contains("address already in use") {
        return match context {
            TunnelStartupContext::Local { local_port } => format!(
                "Локальный порт 127.0.0.1:{} уже занят. Выберите другой локальный порт для Local SSH tunnel или остановите процесс, который его слушает.",
                local_port
            ),
            TunnelStartupContext::Reverse { remote_port } => format!(
                "Порт VDS 127.0.0.1:{} уже занят. Выберите другой VDS порт для Reverse SSH tunnel или остановите процесс на VDS.",
                remote_port
            ),
        };
    }

    if normalized_stderr.contains("cannot listen to port")
        || normalized_stderr.contains("port forwarding failed for listen port")
    {
        return match context {
            TunnelStartupContext::Local { local_port } => format!(
                "Локальный порт 127.0.0.1:{} недоступен. Чаще всего он уже занят другим процессом; выберите другой локальный порт или остановите этот процесс.",
                local_port
            ),
            TunnelStartupContext::Reverse { remote_port } => format!(
                "Порт VDS 127.0.0.1:{} недоступен. Чаще всего он уже занят процессом на VDS; выберите другой VDS порт или освободите его.",
                remote_port
            ),
        };
    }

    if !stderr_excerpt.is_empty() {
        return format!(
            "{} tunnel не запустился: {}",
            context.label(),
            stderr_excerpt
        );
    }

    format!(
        "{} tunnel exited immediately with status {}",
        context.label(),
        exit_status
    )
}

fn ensure_tunnel_running(
    mut child: Child,
    context: TunnelStartupContext,
) -> Result<(Child, u32), String> {
    if let Some(stdout) = child.stdout.take() {
        spawn_ssh_log_reader("stdout", stdout, None);
    }

    let stderr_lines = Arc::new(Mutex::new(Vec::new()));
    if let Some(stderr) = child.stderr.take() {
        spawn_ssh_log_reader("stderr", stderr, Some(Arc::clone(&stderr_lines)));
    }

    let started_at = Instant::now();
    while started_at.elapsed() < Duration::from_millis(1500) {
        if let Some(exit_status) = child
            .try_wait()
            .map_err(|error| format!("Failed to inspect SSH tunnel: {}", error))?
        {
            thread::sleep(Duration::from_millis(80));
            return Err(tunnel_startup_failure_message(
                context,
                exit_status,
                &captured_ssh_lines(&stderr_lines),
            ));
        }

        thread::sleep(Duration::from_millis(100));
    }

    let pid = child.id();
    Ok((child, pid))
}

#[tauri::command]
pub fn start_local_tunnel(
    manager: tauri::State<'_, ServerSessionManager>,
    config: ServerSessionConfig,
    tunnel: LocalTunnelConfig,
) -> Result<ServerSessionStatus, String> {
    let tunnel_id = validate_tunnel_id(&tunnel.id)?;
    let mut tunnels = manager
        .local_tunnels
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let current_status = status_from_map(&mut tunnels, &tunnel_id);

    if current_status.status == "connected" || current_status.status == "degraded" {
        return Ok(current_status);
    }

    let mut command = build_local_ssh_command(&config, &tunnel)?;
    let child = command
        .spawn()
        .map_err(|error| format!("Failed to start local SSH tunnel: {}", error))?;
    let (child, pid) = ensure_tunnel_running(
        child,
        TunnelStartupContext::Local {
            local_port: tunnel.local_port,
        },
    )?;
    let label = normalized_tunnel_label(&tunnel.label, &tunnel_id);

    logger::log_info(
        "SERVER_SESSION",
        &format!(
            "Local SSH tunnel started: local 127.0.0.1:{} -> remote 127.0.0.1:{} ({})",
            tunnel.local_port, tunnel.remote_port, tunnel_id
        ),
    );

    tunnels.insert(
        tunnel_id.clone(),
        TunnelProcess {
            tunnel_id: tunnel_id.clone(),
            label: label.clone(),
            config: config.clone(),
            spec: TunnelSpec::Local(tunnel.clone()),
            child: Some(child),
            remote_tunnel_port: tunnel.remote_port,
            local_ssh_port: tunnel.local_port,
            last_error: None,
            next_restart_at: None,
            last_remote_health: None,
            last_remote_health_at: None,
        },
    );

    Ok(ServerSessionStatus {
        tunnel_id: Some(tunnel_id),
        label: Some(label),
        status: "connected".to_string(),
        pid: Some(pid),
        remote_tunnel_port: Some(tunnel.remote_port),
        local_ssh_port: Some(tunnel.local_port),
        error_message: None,
    })
}

#[tauri::command]
pub fn stop_local_tunnel(
    manager: tauri::State<'_, ServerSessionManager>,
    tunnel_id: String,
) -> Result<ServerSessionStatus, String> {
    let tunnel_id = validate_tunnel_id(&tunnel_id)?;
    let mut tunnels = manager
        .local_tunnels
        .lock()
        .unwrap_or_else(|error| error.into_inner());

    if let Some(mut process) = tunnels.remove(&tunnel_id) {
        if let Some(mut child) = process.child.take() {
            child
                .kill()
                .map_err(|error| format!("Failed to stop local SSH tunnel: {}", error))?;
            let _ = child.wait();
        }
        logger::log_info(
            "SERVER_SESSION",
            &format!("Local SSH tunnel stopped ({})", tunnel_id),
        );
    }

    drop(tunnels);
    drop_cached_status(&manager.local_status_cache, &tunnel_id);

    Ok(ServerSessionStatus {
        tunnel_id: Some(tunnel_id),
        label: None,
        status: "stopped".to_string(),
        pid: None,
        remote_tunnel_port: None,
        local_ssh_port: None,
        error_message: None,
    })
}

#[tauri::command]
pub fn start_server_session_tunnel(
    manager: tauri::State<'_, ServerSessionManager>,
    config: ServerSessionConfig,
    tunnel: ReverseTunnelConfig,
) -> Result<ServerSessionStatus, String> {
    let tunnel_id = validate_tunnel_id(&tunnel.id)?;
    let mut tunnels = manager
        .reverse_tunnels
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let current_status = status_from_map(&mut tunnels, &tunnel_id);

    if current_status.status == "connected" || current_status.status == "degraded" {
        return Ok(current_status);
    }

    ensure_local_ssh_available(tunnel.local_port)?;

    let mut command = build_reverse_ssh_command(&config, &tunnel)?;
    let child = command
        .spawn()
        .map_err(|error| format!("Failed to start reverse SSH tunnel: {}", error))?;
    let (child, pid) = ensure_tunnel_running(
        child,
        TunnelStartupContext::Reverse {
            remote_port: tunnel.remote_port,
        },
    )?;
    let label = normalized_tunnel_label(&tunnel.label, &tunnel_id);

    logger::log_info(
        "SERVER_SESSION",
        &format!(
            "Reverse SSH tunnel started: remote 127.0.0.1:{} -> local 127.0.0.1:{} ({})",
            tunnel.remote_port, tunnel.local_port, tunnel_id
        ),
    );

    tunnels.insert(
        tunnel_id.clone(),
        TunnelProcess {
            tunnel_id: tunnel_id.clone(),
            label: label.clone(),
            config: config.clone(),
            spec: TunnelSpec::Reverse(tunnel.clone()),
            child: Some(child),
            remote_tunnel_port: tunnel.remote_port,
            local_ssh_port: tunnel.local_port,
            last_error: None,
            next_restart_at: None,
            last_remote_health: None,
            last_remote_health_at: None,
        },
    );

    Ok(ServerSessionStatus {
        tunnel_id: Some(tunnel_id),
        label: Some(label),
        status: "connected".to_string(),
        pid: Some(pid),
        remote_tunnel_port: Some(tunnel.remote_port),
        local_ssh_port: Some(tunnel.local_port),
        error_message: None,
    })
}

#[tauri::command]
pub fn stop_server_session_tunnel(
    manager: tauri::State<'_, ServerSessionManager>,
    tunnel_id: String,
) -> Result<ServerSessionStatus, String> {
    let tunnel_id = validate_tunnel_id(&tunnel_id)?;
    let mut tunnels = manager
        .reverse_tunnels
        .lock()
        .unwrap_or_else(|error| error.into_inner());

    if let Some(mut process) = tunnels.remove(&tunnel_id) {
        if let Some(mut child) = process.child.take() {
            child
                .kill()
                .map_err(|error| format!("Failed to stop SSH tunnel: {}", error))?;
            let _ = child.wait();
        }
        logger::log_info(
            "SERVER_SESSION",
            &format!("Reverse SSH tunnel stopped ({})", tunnel_id),
        );
    }

    drop(tunnels);
    drop_cached_status(&manager.reverse_status_cache, &tunnel_id);

    Ok(ServerSessionStatus {
        tunnel_id: Some(tunnel_id),
        label: None,
        status: "stopped".to_string(),
        pid: None,
        remote_tunnel_port: None,
        local_ssh_port: None,
        error_message: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_server_session_config() -> ServerSessionConfig {
        ServerSessionConfig {
            host: "87.58.216.198".to_string(),
            ssh_port: 22,
            username: "root".to_string(),
            identity_file: Some("~/.ssh/shared-vds_ed25519".to_string()),
            remote_tunnel_port: 2222,
            local_ssh_port: 22,
            project_path: "~/project".to_string(),
        }
    }

    #[test]
    fn posix_shell_quote_preserves_spaces_and_quotes() {
        assert_eq!(posix_shell_quote("alpha beta"), "'alpha beta'");
        assert_eq!(posix_shell_quote("a'b c"), "'a'\\''b c'");
        assert_eq!(posix_shell_quote(""), "''");
    }

    #[test]
    fn powershell_quote_preserves_spaces_and_quotes() {
        assert_eq!(
            powershell_quote("C:\\Users\\Ada Lovelace\\.ssh\\it's"),
            "'C:\\Users\\Ada Lovelace\\.ssh\\it''s'"
        );
    }

    #[test]
    fn validate_vds_host_accepts_ips_and_dns_names() {
        assert_eq!(
            validate_vds_host(" 123.123.123.123 ").unwrap(),
            "123.123.123.123"
        );
        assert_eq!(
            validate_vds_host("vds.example.com").unwrap(),
            "vds.example.com"
        );
        assert_eq!(validate_vds_host("[2001:db8::1]").unwrap(), "[2001:db8::1]");
    }

    #[test]
    fn validate_vds_host_rejects_issue_ids_urls_and_spaces() {
        assert!(validate_vds_host("#161860").is_err());
        assert!(validate_vds_host("https://example.com").is_err());
        assert!(validate_vds_host("vds example com").is_err());
    }

    #[test]
    fn parse_vds_health_output_handles_linux_values() {
        let parsed = parse_vds_health_output(
            "\
OS=Linux
LOAD_AVG=0.42
CPU_CORES=4
MEM_TOTAL_KB=2048000
MEM_AVAILABLE_KB=1024000
DISK_TOTAL_BYTES=1000000000
DISK_USED_BYTES=250000000
UPTIME=up 1 day, 2 hours
",
        );

        assert_eq!(parsed.status, VdsHealthState::Ok);
        assert_eq!(parsed.message, None);

        let metrics = parsed.metrics.unwrap();
        assert_eq!(metrics.load_average, Some(0.42));
        assert_eq!(metrics.cpu_cores, Some(4));
        assert_eq!(metrics.memory_total_bytes, Some(2_097_152_000));
        assert_eq!(metrics.memory_used_bytes, Some(1_048_576_000));
        assert_eq!(metrics.disk_total_bytes, Some(1_000_000_000));
        assert_eq!(metrics.disk_used_bytes, Some(250_000_000));
        assert_eq!(metrics.uptime, Some("1 day, 2 hours".to_string()));
    }

    #[test]
    fn parse_vds_health_output_handles_missing_optional_fields() {
        let parsed = parse_vds_health_output(
            "\
OS=Linux
LOAD_AVG=0.10
MEM_TOTAL_KB=1000
MEM_AVAILABLE_KB=400
DISK_TOTAL_BYTES=9000
DISK_USED_BYTES=3000
",
        );

        assert_eq!(parsed.status, VdsHealthState::Ok);

        let metrics = parsed.metrics.unwrap();
        assert_eq!(metrics.cpu_cores, None);
        assert_eq!(metrics.uptime, None);
        assert_eq!(metrics.memory_total_bytes, Some(1_024_000));
        assert_eq!(metrics.memory_used_bytes, Some(614_400));
    }

    #[test]
    fn parse_vds_health_output_degrades_non_linux_without_panic() {
        let parsed = parse_vds_health_output("OS=FreeBSD\n");

        assert_eq!(parsed.status, VdsHealthState::Degraded);
        assert!(parsed.metrics.is_none());
        assert!(parsed.message.unwrap().contains("Linux VDS"));
    }

    #[test]
    fn vds_health_failure_message_maps_permission_denied() {
        let message =
            vds_health_failure_message("root@example.com: Permission denied (publickey,password).");

        assert!(message.contains("SSH ключ не принят VDS"));
        assert!(!message.contains("Permission denied"));
    }

    #[test]
    fn build_vds_location_trims_country_and_city() {
        let location = build_vds_location(
            "87.58.216.198".parse().unwrap(),
            None,
            Some(" Netherlands ".to_string()),
            Some(" Amsterdam ".to_string()),
        )
        .unwrap();

        assert_eq!(location.ip, "87.58.216.198");
        assert_eq!(location.country.as_deref(), Some("Netherlands"));
        assert_eq!(location.city.as_deref(), Some("Amsterdam"));
    }

    #[test]
    fn remote_tcp_check_quotes_shell_script_for_ssh() {
        let command = build_remote_tcp_check_command(&test_server_session_config(), 2222).unwrap();
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let remote_command = args.last().unwrap();

        assert!(remote_command.starts_with("sh -lc 'if command -v nc"));
        assert!(remote_command.contains("then nc -z -w 1 127.0.0.1 2222"));
        assert!(!args.contains(&"sh".to_string()));
        assert!(!args.contains(&"-lc".to_string()));
    }

    #[test]
    fn key_install_command_prefers_password_without_identity_file() {
        let command = build_key_install_ssh_command_for_syntax(
            &test_server_session_config(),
            "echo install-key",
            CommandLineSyntax::Posix,
        )
        .unwrap();

        assert!(
            command.contains("PreferredAuthentications=password,keyboard-interactive,publickey")
        );
        assert!(command.contains("BatchMode=no"));
        assert!(command.contains("Введите пароль пользователя VDS"));
        assert!(!command.contains(" -i "));
    }

    #[test]
    fn tunnel_startup_message_explains_local_port_in_use() {
        let stderr_lines = vec![
            "bind [127.0.0.1]:3000: Address already in use".to_string(),
            "channel_setup_fwd_listener_tcpip: cannot listen to port: 3000".to_string(),
        ];
        let message = tunnel_startup_failure_message(
            TunnelStartupContext::Local { local_port: 3000 },
            "exit status: 255",
            &stderr_lines,
        );

        assert!(message.contains("Локальный порт 127.0.0.1:3000 уже занят"));
        assert!(!message.contains("exit status: 255"));
    }

    #[test]
    fn terminal_launch_candidates_keep_expected_order() {
        let macos = terminal_launch_candidates(DesktopPlatform::Macos, "ssh example");
        let macos_ids = macos
            .iter()
            .map(|candidate| candidate.id)
            .collect::<Vec<_>>();
        assert_eq!(
            macos_ids,
            vec![
                TerminalId::System,
                TerminalId::Ghostty,
                TerminalId::Warp,
                TerminalId::Iterm2,
                TerminalId::Alacritty,
                TerminalId::Kitty
            ]
        );
        assert_eq!(macos[0].program, "osascript");

        let linux = terminal_launch_candidates(DesktopPlatform::Linux, "ssh example");
        let linux_ids = linux
            .iter()
            .map(|candidate| candidate.id)
            .collect::<Vec<_>>();
        assert_eq!(
            linux_ids,
            vec![
                TerminalId::System,
                TerminalId::Ghostty,
                TerminalId::Warp,
                TerminalId::GnomeTerminal,
                TerminalId::Konsole,
                TerminalId::Xfce4Terminal
            ]
        );
        let linux_programs = linux
            .iter()
            .map(|candidate| candidate.program.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            linux_programs,
            vec![
                "x-terminal-emulator",
                "ghostty",
                "warp-terminal",
                "gnome-terminal",
                "konsole",
                "xfce4-terminal"
            ]
        );
        assert_eq!(linux[0].id, TerminalId::System);
        assert!(!linux_programs.contains(&"xterm"));

        let windows = terminal_launch_candidates(DesktopPlatform::Windows, "ssh example");
        let windows_ids = windows
            .iter()
            .map(|candidate| candidate.id)
            .collect::<Vec<_>>();
        assert_eq!(
            windows_ids,
            vec![
                TerminalId::System,
                TerminalId::Ghostty,
                TerminalId::Warp,
                TerminalId::WindowsTerminal,
                TerminalId::Powershell,
                TerminalId::GitBash
            ]
        );
    }

    #[test]
    fn terminal_id_deserializes_legacy_preferences_as_system() {
        for value in ["system", "terminal", "x-terminal-emulator", "xterm"] {
            let json = serde_json::to_string(value).unwrap();
            assert_eq!(
                serde_json::from_str::<TerminalId>(&json).unwrap(),
                TerminalId::System
            );
        }

        assert_eq!(
            serde_json::from_str::<TerminalId>("\"git-bash\"").unwrap(),
            TerminalId::GitBash
        );
    }
}
