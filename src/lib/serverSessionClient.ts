import { invoke } from "@tauri-apps/api/core";
import type {
  LocalTunnelSettings,
  ReverseTunnelSettings,
  ServerSessionSettings,
  TerminalId,
} from "./store";

export type ServerSessionStatus = {
  tunnelId?: string | null;
  label?: string | null;
  status: "stopped" | "connected" | "degraded" | "error";
  pid?: number | null;
  remoteTunnelPort?: number | null;
  localSshPort?: number | null;
  errorMessage?: string | null;
};

export type SshKeyInfo = {
  privateKeyPath: string;
  publicKeyPath: string;
  publicKey: string;
};

export type SshConnectionTestResult = {
  ok: boolean;
  message: string;
};

export type DesktopPlatform = "macos" | "linux" | "windows" | "unknown";

export type TerminalOption = {
  id: TerminalId;
  label: string;
};

export type SystemToolStatus = {
  sshAvailable: boolean;
  sshKeygenAvailable: boolean;
  missingTools: string[];
};

export type LocalSshSupport = {
  platform: DesktopPlatform;
  port: number;
  available: boolean;
  canOpenSettings: boolean;
  canRequestEnable: boolean;
  instructionsKey: string;
};

export type VdsSystemStatus = {
  platform: DesktopPlatform;
  tools: SystemToolStatus;
  localSsh: LocalSshSupport;
};

export type VdsHealthMetrics = {
  loadAverage?: number | null;
  cpuCores?: number | null;
  memoryTotalBytes?: number | null;
  memoryUsedBytes?: number | null;
  diskTotalBytes?: number | null;
  diskUsedBytes?: number | null;
  uptime?: string | null;
};

export type VdsLocation = {
  ip: string;
  country?: string | null;
  city?: string | null;
};

export type VdsHealthStatus = {
  status: "ok" | "degraded" | "error";
  checkedAt: string;
  message?: string | null;
  metrics?: VdsHealthMetrics | null;
  location?: VdsLocation | null;
};

export type VdsHealthSample = {
  checkedAt: string;
  loadAverage: number | null;
  cpuCores: number | null;
  memoryUsedRatio: number | null;
  diskUsedRatio: number | null;
  status: VdsHealthStatus["status"];
};

const TERMINAL_NOT_FOUND_PREFIX = "TERMINAL_NOT_FOUND:";
let availableTerminalsPromise: Promise<TerminalOption[]> | null = null;

export function isLocalSshUnavailableMessage(
  message: string | null | undefined,
): boolean {
  const normalized = message?.toLocaleLowerCase() ?? "";

  return (
    normalized.includes("локальный ssh выключен") ||
    normalized.includes("openssh server") ||
    normalized.includes("sshd") ||
    normalized.includes("remote login") ||
    (normalized.includes("local ssh") &&
      (normalized.includes("off") || normalized.includes("disabled")))
  );
}

export const isRemoteLoginUnavailableMessage = isLocalSshUnavailableMessage;

export function terminalFallbackCommandFromError(
  error: unknown,
): string | null {
  const message = error instanceof Error ? error.message : String(error);
  const prefixIndex = message.indexOf(TERMINAL_NOT_FOUND_PREFIX);

  return prefixIndex >= 0
    ? message.slice(prefixIndex + TERMINAL_NOT_FOUND_PREFIX.length)
    : null;
}

export function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function getVdsSystemStatus(
  localSshPort: number,
): Promise<VdsSystemStatus> {
  return await invoke<VdsSystemStatus>("get_vds_system_status", {
    localSshPort,
  });
}

export async function getAvailableTerminals(): Promise<TerminalOption[]> {
  availableTerminalsPromise ??= invoke<TerminalOption[]>(
    "get_available_terminals",
  ).catch((error) => {
    availableTerminalsPromise = null;
    throw error;
  });

  return await availableTerminalsPromise;
}

export async function getVdsHealth(
  config: ServerSessionSettings,
): Promise<VdsHealthStatus> {
  return await invoke<VdsHealthStatus>("get_vds_health", {
    config,
  });
}

export async function getVdsLocation(
  config: ServerSessionSettings,
): Promise<VdsLocation | null> {
  return await invoke<VdsLocation | null>("get_vds_location", {
    config,
  });
}

export async function getServerSessionStatus(): Promise<ServerSessionStatus[]> {
  return await invoke<ServerSessionStatus[]>("get_server_session_status");
}

export async function getLocalTunnelStatus(): Promise<ServerSessionStatus[]> {
  return await invoke<ServerSessionStatus[]>("get_local_tunnel_status");
}

export async function generateSshKey(): Promise<SshKeyInfo> {
  return await invoke<SshKeyInfo>("generate_ssh_key");
}

export async function readSshPublicKey(
  privateKeyPath: string,
): Promise<SshKeyInfo> {
  return await invoke<SshKeyInfo>("read_ssh_public_key", {
    privateKeyPath,
  });
}

export async function testServerConnection(
  config: ServerSessionSettings,
): Promise<SshConnectionTestResult> {
  return await invoke<SshConnectionTestResult>("test_server_connection", {
    config,
  });
}

export async function checkLocalSshAccess(
  localSshPort: number,
): Promise<SshConnectionTestResult> {
  return await invoke<SshConnectionTestResult>("check_local_ssh_access", {
    localSshPort,
  });
}

export async function requestRemoteLogin(
  localSshPort: number,
): Promise<SshConnectionTestResult> {
  return await invoke<SshConnectionTestResult>("request_remote_login", {
    localSshPort,
  });
}

export const requestLocalSshEnable = requestRemoteLogin;

export async function openRemoteLoginSettings(
  terminalId?: TerminalId,
): Promise<void> {
  return await invoke<void>("open_remote_login_settings", {
    terminalId,
  });
}

export const openLocalSshSettings = openRemoteLoginSettings;

export async function openServerTerminal(
  config: ServerSessionSettings,
  terminalId?: TerminalId,
): Promise<void> {
  return await invoke<void>("open_server_terminal", {
    config,
    terminalId,
  });
}

export async function openServerTerminalCommand({
  config,
  command,
  terminalId,
}: {
  config: ServerSessionSettings;
  command: string;
  terminalId?: TerminalId;
}): Promise<void> {
  return await invoke<void>("open_server_terminal_command", {
    config,
    command,
    terminalId,
  });
}

export async function openServerKeyInstallTerminal({
  config,
  command,
  terminalId,
}: {
  config: ServerSessionSettings;
  command: string;
  terminalId?: TerminalId;
}): Promise<void> {
  return await invoke<void>("open_server_key_install_terminal", {
    config,
    command,
    terminalId,
  });
}

export async function startServerSessionTunnel(
  config: ServerSessionSettings,
  tunnel: ReverseTunnelSettings,
): Promise<ServerSessionStatus> {
  return await invoke<ServerSessionStatus>("start_server_session_tunnel", {
    config,
    tunnel,
  });
}

export async function stopServerSessionTunnel(
  tunnelId: string,
): Promise<ServerSessionStatus> {
  return await invoke<ServerSessionStatus>("stop_server_session_tunnel", {
    tunnelId,
  });
}

export async function startLocalTunnel(
  config: ServerSessionSettings,
  tunnel: LocalTunnelSettings,
): Promise<ServerSessionStatus> {
  return await invoke<ServerSessionStatus>("start_local_tunnel", {
    config,
    tunnel,
  });
}

export async function stopLocalTunnel(
  tunnelId: string,
): Promise<ServerSessionStatus> {
  return await invoke<ServerSessionStatus>("stop_local_tunnel", {
    tunnelId,
  });
}
