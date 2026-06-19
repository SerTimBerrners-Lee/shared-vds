import { invoke } from "@tauri-apps/api/core";

export async function logInfo(tag: string, message: string): Promise<void> {
  console.log(`[${tag}] ${message}`);
  try {
    await invoke("log_event", { level: "INFO", tag, message });
  } catch {
    // ignore Tauri errors
  }
}

export async function logError(tag: string, message: string): Promise<void> {
  console.error(`[${tag}] ${message}`);
  try {
    await invoke("log_event", { level: "ERROR", tag, message });
  } catch {
    // ignore Tauri errors
  }
}

export async function logDebug(tag: string, message: string): Promise<void> {
  console.log(`[${tag}] ${message}`);
  try {
    await invoke("log_event", { level: "DEBUG", tag, message });
  } catch {
    // ignore Tauri errors
  }
}

export async function getLogPath(): Promise<string> {
  try {
    return await invoke("get_log_path_cmd");
  } catch {
    return "~/.shared-vds/shared-vds.log";
  }
}

export async function openLogFile(): Promise<void> {
  await invoke("open_log_file_cmd");
}

export async function revealLogFile(): Promise<void> {
  await invoke("reveal_log_file_cmd");
}

export async function clearLogs(): Promise<void> {
  try {
    await invoke("clear_logs");
  } catch {
    // ignore
  }
}
