import type { TerminalId } from "./store";

type TerminalLike = {
  id: TerminalId;
};

const TERMINAL_IDS = new Set<string>([
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
]);

const LEGACY_SYSTEM_TERMINAL_IDS = new Set<string>([
  "terminal",
  "x-terminal-emulator",
  "xterm",
]);

export function normalizeTerminalId(value: unknown): TerminalId | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  if (LEGACY_SYSTEM_TERMINAL_IDS.has(value)) {
    return "system";
  }

  return TERMINAL_IDS.has(value) ? (value as TerminalId) : undefined;
}

export function selectAvailableTerminalId(
  terminals: TerminalLike[],
  preferredTerminalId: TerminalId,
): TerminalId {
  return terminals.some((terminal) => terminal.id === preferredTerminalId)
    ? preferredTerminalId
    : "system";
}

export function shouldShowTerminalPicker(
  terminalsLoaded: boolean,
  terminals: TerminalLike[],
): boolean {
  return (
    terminalsLoaded && terminals.some((terminal) => terminal.id !== "system")
  );
}
