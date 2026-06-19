import { useEffect, useState } from "react";
import {
  disable as disableAutostart,
  enable as enableAutostart,
  isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart";
import { emit } from "@tauri-apps/api/event";
import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";

import {
  getSettings,
  saveSettings,
  type AppSettings,
  type InterfaceLanguage,
  type ThemePreference,
  type VdsHealthPollIntervalMs,
  VDS_HEALTH_POLL_INTERVAL_OPTIONS,
} from "../../../lib/store";
import { applyThemePreference } from "../../../lib/theme";
import {
  INTERFACE_LANGUAGES,
  applyInterfaceLanguage,
  normalizeInterfaceLanguage,
  translate,
  useAppLocale,
  type TranslationKey,
} from "../../../lib/i18n";
import { SETTINGS_UPDATED_EVENT } from "../../../lib/settingsEvents";
import { logError, logInfo } from "../../../lib/logger";

const CONTROL_HEIGHT = 38;
const CONTROL_RADIUS = 8;
const CONTROL_FONT_SIZE = "var(--text-sm)";
const SETTINGS_CARD_STYLE = {
  display: "grid",
  gap: 12,
  background: "transparent",
  backdropFilter: "none",
  WebkitBackdropFilter: "none",
} as const;

const THEME_OPTIONS: Array<{
  id: ThemePreference;
  labelKey: TranslationKey;
  Icon: LucideIcon;
}> = [
  { id: "system", labelKey: "settings.themeSystem", Icon: Monitor },
  { id: "light", labelKey: "settings.themeLight", Icon: Sun },
  { id: "dark", labelKey: "settings.themeDark", Icon: Moon },
];

const STATS_REFRESH_OPTIONS: Array<{
  value: VdsHealthPollIntervalMs;
  labelKey: TranslationKey;
}> = [
  { value: 5000, labelKey: "settings.statsRefresh5s" },
  { value: 10000, labelKey: "settings.statsRefresh10s" },
  { value: 30000, labelKey: "settings.statsRefresh30s" },
  { value: 60000, labelKey: "settings.statsRefresh1m" },
  { value: 300000, labelKey: "settings.statsRefresh5m" },
  { value: 600000, labelKey: "settings.statsRefresh10m" },
];

export function SettingsTab() {
  const locale = useAppLocale();
  const t = (
    key: TranslationKey,
    values: Record<string, string> = {},
  ): string => translate(locale, key, values);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [autostartLoaded, setAutostartLoaded] = useState(false);
  const [autostartPending, setAutostartPending] = useState(false);

  useEffect(() => {
    let mounted = true;

    getSettings({ reload: true })
      .then((nextSettings) => {
        if (!mounted) {
          return;
        }

        setSettings(nextSettings);
      })
      .catch((error) => {
        void logError(
          "SETTINGS",
          `Failed to load settings: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;

    const loadAutostartState = async (): Promise<void> => {
      try {
        const enabled = await isAutostartEnabled();
        if (!mounted) {
          return;
        }

        setAutostartEnabled(enabled);
        setAutostartLoaded(true);
      } catch (error) {
        if (!mounted) {
          return;
        }

        setAutostartLoaded(true);
        void logError(
          "SETTINGS",
          `Failed to load autostart state: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };

    void loadAutostartState();

    return () => {
      mounted = false;
    };
  }, []);

  const update = async (patch: Partial<AppSettings>): Promise<void> => {
    if (!settings) {
      return;
    }

    const nextSettings = { ...settings, ...patch };
    setSettings(nextSettings);
    await saveSettings(patch);
    await emit(SETTINGS_UPDATED_EVENT).catch((error) => {
      void logError(
        "SETTINGS",
        `Failed to emit settings update event: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };

  const updateTheme = async (theme: ThemePreference): Promise<void> => {
    applyThemePreference(theme);
    await update({ theme });
  };

  const updateInterfaceLanguage = async (
    value: InterfaceLanguage,
  ): Promise<void> => {
    const interfaceLanguage = normalizeInterfaceLanguage(value);
    applyInterfaceLanguage(interfaceLanguage);
    await update({ interfaceLanguage });
  };

  const updateStatsRefresh = async (value: string): Promise<void> => {
    const nextInterval = Number.parseInt(value, 10);

    if (
      !VDS_HEALTH_POLL_INTERVAL_OPTIONS.includes(
        nextInterval as VdsHealthPollIntervalMs,
      )
    ) {
      return;
    }

    await update({
      vdsHealthPollIntervalMs: nextInterval as VdsHealthPollIntervalMs,
    });
  };

  const toggleAutostart = async (): Promise<void> => {
    if (autostartPending) {
      return;
    }

    const nextEnabled = !autostartEnabled;
    setAutostartPending(true);

    try {
      if (nextEnabled) {
        await enableAutostart();
      } else {
        await disableAutostart();
      }

      const confirmedEnabled = await isAutostartEnabled();
      setAutostartEnabled(confirmedEnabled);
      setAutostartLoaded(true);
      void logInfo(
        "SETTINGS",
        `Autostart ${confirmedEnabled ? "enabled" : "disabled"}`,
      );
    } catch (error) {
      void logError(
        "SETTINGS",
        `Failed to update autostart: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setAutostartPending(false);
    }
  };

  if (!settings) {
    return null;
  }

  const autostartDisabled = !autostartLoaded || autostartPending;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="card" style={SETTINGS_CARD_STYLE}>
        <div
          style={{
            fontSize: "var(--text-lg)",
            fontWeight: "var(--weight-bold)",
            color: "var(--text-hi)",
            margin: 0,
          }}
        >
          {t("settings.theme")}
        </div>

        <div
          style={{
            display: "flex",
            background: "var(--control-track)",
            borderRadius: 10,
            padding: 3,
            gap: 2,
            width: "100%",
          }}
        >
          {THEME_OPTIONS.map(({ id, labelKey, Icon }) => {
            const active = settings.theme === id;

            return (
              <button
                key={id}
                type="button"
                onClick={() => {
                  void updateTheme(id);
                }}
                style={{
                  flex: 1,
                  minWidth: 0,
                  minHeight: CONTROL_HEIGHT - 6,
                  padding: "0 4px",
                  borderRadius: CONTROL_RADIUS,
                  border: "none",
                  fontSize: CONTROL_FONT_SIZE,
                  fontWeight: active
                    ? "var(--weight-bold)"
                    : "var(--weight-medium)",
                  background: active ? "var(--dropdown-active)" : "transparent",
                  color: active ? "var(--text-hi)" : "var(--text-mid)",
                  cursor: "pointer",
                  transition: "background 0.15s ease, color 0.15s ease",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 4,
                }}
              >
                <Icon
                  size={13}
                  strokeWidth={active ? 2.2 : 1.7}
                  style={{ flexShrink: 0 }}
                />
                <span
                  style={{
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {t(labelKey)}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="card" style={SETTINGS_CARD_STYLE}>
        <label
          htmlFor="interface-language"
          style={{
            display: "grid",
            gap: 12,
            fontSize: "var(--text-lg)",
            fontWeight: "var(--weight-bold)",
            color: "var(--text-hi)",
          }}
        >
          {t("settings.interfaceLanguage")}
          <select
            id="interface-language"
            name="interfaceLanguage"
            value={settings.interfaceLanguage}
            onChange={(event) => {
              void updateInterfaceLanguage(
                normalizeInterfaceLanguage(event.currentTarget.value),
              );
            }}
            className="input"
            style={{
              minHeight: CONTROL_HEIGHT,
              height: CONTROL_HEIGHT,
              padding: "0 10px",
              border: "1px solid var(--border)",
              borderRadius: CONTROL_RADIUS,
              background: "var(--control-bg)",
              color: "var(--text-hi)",
              fontSize: CONTROL_FONT_SIZE,
              fontWeight: "var(--weight-medium)",
            }}
          >
            {INTERFACE_LANGUAGES.map((language) => (
              <option key={language.id} value={language.id}>
                {language.nativeLabel}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="card" style={SETTINGS_CARD_STYLE}>
        <label
          htmlFor="stats-refresh"
          style={{
            display: "grid",
            gap: 12,
            fontSize: "var(--text-lg)",
            fontWeight: "var(--weight-bold)",
            color: "var(--text-hi)",
          }}
        >
          {t("settings.statsRefresh")}
          <select
            id="stats-refresh"
            name="statsRefresh"
            value={settings.vdsHealthPollIntervalMs}
            onChange={(event) => {
              void updateStatsRefresh(event.currentTarget.value);
            }}
            className="input"
            style={{
              minHeight: CONTROL_HEIGHT,
              height: CONTROL_HEIGHT,
              padding: "0 10px",
              border: "1px solid var(--border)",
              borderRadius: CONTROL_RADIUS,
              background: "var(--control-bg)",
              color: "var(--text-hi)",
              fontSize: CONTROL_FONT_SIZE,
              fontWeight: "var(--weight-medium)",
            }}
          >
            {STATS_REFRESH_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.labelKey)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="card" style={SETTINGS_CARD_STYLE}>
        <div
          style={{
            fontSize: "var(--text-lg)",
            fontWeight: "var(--weight-bold)",
            color: "var(--text-hi)",
            margin: 0,
          }}
        >
          {t("settings.autostart")}
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={autostartEnabled}
          aria-disabled={autostartDisabled}
          onClick={() => {
            void toggleAutostart();
          }}
          className="btn"
          style={{
            width: "100%",
            minHeight: CONTROL_HEIGHT,
            padding: "0 10px",
            borderRadius: CONTROL_RADIUS,
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) 34px",
            alignItems: "center",
            gap: 10,
            opacity: autostartDisabled ? 0.72 : 1,
            cursor: autostartDisabled ? "wait" : "pointer",
            transform: "none",
          }}
        >
          <span
            style={{
              color: "var(--text-hi)",
              fontSize: CONTROL_FONT_SIZE,
              fontWeight: "var(--weight-bold)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              minWidth: 0,
            }}
          >
            {autostartPending
              ? t("settings.autostartBusy")
              : autostartEnabled
                ? t("common.enabled")
                : t("common.disabled")}
          </span>
          <span
            aria-hidden="true"
            style={{
              width: 34,
              height: 20,
              borderRadius: 999,
              background: autostartEnabled
                ? "var(--accent)"
                : "var(--switch-track)",
              padding: 3,
              position: "relative",
              transition: "background 0.15s ease",
              flexShrink: 0,
            }}
          >
            <span
              style={{
                position: "absolute",
                top: 3,
                left: 3,
                width: 14,
                height: 14,
                borderRadius: "50%",
                background: "var(--accent-contrast)",
                boxShadow: "0 1px 3px rgba(0,0,0,0.18)",
                transform: autostartEnabled
                  ? "translateX(14px)"
                  : "translateX(0)",
                transition: "transform 0.18s ease",
              }}
            />
          </span>
        </button>
      </div>
    </div>
  );
}
