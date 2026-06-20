import { describe, expect, test } from "bun:test";
import type { TerminalId } from "./store";
import {
  normalizeTerminalId,
  selectAvailableTerminalId,
  shouldShowTerminalPicker,
} from "./terminalPicker";

const terminal = (id: TerminalId) => ({ id });

describe("terminal picker helpers", () => {
  test("hides picker when only system terminal is available", () => {
    expect(shouldShowTerminalPicker(true, [terminal("system")])).toBe(false);
  });

  test("shows picker when any additional terminal is available", () => {
    expect(
      shouldShowTerminalPicker(true, [
        terminal("system"),
        terminal("ghostty"),
      ]),
    ).toBe(true);
    expect(
      shouldShowTerminalPicker(true, [terminal("system"), terminal("warp")]),
    ).toBe(true);
  });

  test("resets missing preferred terminal to system", () => {
    expect(
      selectAvailableTerminalId(
        [terminal("system"), terminal("warp")],
        "ghostty",
      ),
    ).toBe("system");
  });

  test("normalizes legacy terminal preferences to system", () => {
    expect(normalizeTerminalId("terminal")).toBe("system");
    expect(normalizeTerminalId("x-terminal-emulator")).toBe("system");
    expect(normalizeTerminalId("xterm")).toBe("system");
  });

  test("accepts strict terminal ids", () => {
    expect(normalizeTerminalId("iterm2")).toBe("iterm2");
    expect(normalizeTerminalId("alacritty")).toBe("alacritty");
    expect(normalizeTerminalId("kitty")).toBe("kitty");
    expect(normalizeTerminalId("git-bash")).toBe("git-bash");
  });
});
