import { load } from "@tauri-apps/plugin-store";
import type {
  VdsLocation,
  VdsHealthMetrics,
  VdsHealthSample,
  VdsHealthStatus,
} from "./serverSessionClient";

export type ThemePreference = "system" | "light" | "dark";
export type InterfaceLanguage = "ru" | "en";
export type VdsHealthPollIntervalMs =
  | 5000
  | 10000
  | 30000
  | 60000
  | 300000
  | 600000;

export const DEFAULT_VDS_HEALTH_POLL_INTERVAL_MS: VdsHealthPollIntervalMs =
  10000;

export const VDS_HEALTH_POLL_INTERVAL_OPTIONS: VdsHealthPollIntervalMs[] = [
  5000,
  10000,
  30000,
  60000,
  300000,
  600000,
];

export type VdsHealthSnapshot = {
  status: VdsHealthStatus | null;
  history: VdsHealthSample[];
  location: VdsLocation | null;
};

export type VdsHealthSnapshotsByIdentity = Record<string, VdsHealthSnapshot>;

const VDS_HEALTH_SNAPSHOTS_STORE_KEY = "vdsHealthSnapshotsByIdentity";
const VDS_HEALTH_HISTORY_LIMIT = 360;

export type RememberedRunningTunnels = {
  localTunnelIds: string[];
  reverseTunnelIds: string[];
};

export type RememberedRunningTunnelsByProfile = Record<
  string,
  RememberedRunningTunnels
>;

export interface LocalTunnelSettings {
  id: string;
  label: string;
  localPort: number;
  remotePort: number;
}

export interface ReverseTunnelSettings {
  id: string;
  label: string;
  remotePort: number;
  localPort: number;
}

export interface ServerSessionSettings {
  host: string;
  sshPort: number;
  username: string;
  identityFile: string;
  remoteTunnelPort: number;
  localSshPort: number;
  localTunnels: LocalTunnelSettings[];
  reverseTunnels: ReverseTunnelSettings[];
  projectPath: string;
}

export interface ServerSessionProfile {
  id: string;
  name: string;
  config: ServerSessionSettings;
}

export interface AppSettings {
  theme: ThemePreference;
  interfaceLanguage: InterfaceLanguage;
  vdsHealthPollIntervalMs: VdsHealthPollIntervalMs;
  serverSession: ServerSessionSettings;
  serverSessionProfiles: ServerSessionProfile[];
  activeServerSessionProfileId: string;
  pinnedServerSessionProfileIds: string[];
  appLaunchCount: number;
  remoteLoginPromptedForPort: number | null;
  rememberedRunningTunnelsByProfile: RememberedRunningTunnelsByProfile;
}

export const DEFAULT_SERVER_SESSION_SETTINGS: ServerSessionSettings = {
  host: "",
  sshPort: 22,
  username: "",
  identityFile: "",
  remoteTunnelPort: 2222,
  localSshPort: 22,
  localTunnels: [
    {
      id: "codex-lb",
      label: "codex-lb",
      localPort: 2455,
      remotePort: 2455,
    },
  ],
  reverseTunnels: [
    {
      id: "local-ssh",
      label: "Локальный SSH",
      remotePort: 2222,
      localPort: 22,
    },
  ],
  projectPath: "",
};

export const DEFAULT_SERVER_SESSION_PROFILE_ID = "vds-1";

export const DEFAULT_SERVER_SESSION_PROFILES: ServerSessionProfile[] = [
  {
    id: DEFAULT_SERVER_SESSION_PROFILE_ID,
    name: "VDS 1",
    config: DEFAULT_SERVER_SESSION_SETTINGS,
  },
];

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "system",
  interfaceLanguage: "ru",
  vdsHealthPollIntervalMs: DEFAULT_VDS_HEALTH_POLL_INTERVAL_MS,
  serverSession: DEFAULT_SERVER_SESSION_SETTINGS,
  serverSessionProfiles: DEFAULT_SERVER_SESSION_PROFILES,
  activeServerSessionProfileId: DEFAULT_SERVER_SESSION_PROFILE_ID,
  pinnedServerSessionProfileIds: [],
  appLaunchCount: 0,
  remoteLoginPromptedForPort: null,
  rememberedRunningTunnelsByProfile: {},
};

function parseTheme(value: unknown): ThemePreference | undefined {
  if (value === "black") {
    return "dark";
  }

  if (value === "system" || value === "light" || value === "dark") {
    return value;
  }

  return undefined;
}

function parseInterfaceLanguage(value: unknown): InterfaceLanguage | undefined {
  if (value === "ru" || value === "en") {
    return value;
  }

  return undefined;
}

function parseVdsHealthPollInterval(
  value: unknown,
): VdsHealthPollIntervalMs | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return undefined;
  }

  return VDS_HEALTH_POLL_INTERVAL_OPTIONS.includes(
    value as VdsHealthPollIntervalMs,
  )
    ? (value as VdsHealthPollIntervalMs)
    : undefined;
}

function parseVdsHealthStatusKind(
  value: unknown,
): VdsHealthStatus["status"] | undefined {
  if (value === "ok" || value === "degraded" || value === "error") {
    return value;
  }

  return undefined;
}

function parseFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function parseNullableFiniteNumber(value: unknown): number | null {
  return parseFiniteNumber(value) ?? null;
}

function parseVdsHealthMetrics(value: unknown): VdsHealthMetrics | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const raw = value as Record<string, unknown>;

  return {
    loadAverage: parseFiniteNumber(raw.loadAverage) ?? null,
    cpuCores: parseFiniteNumber(raw.cpuCores) ?? null,
    memoryTotalBytes: parseFiniteNumber(raw.memoryTotalBytes) ?? null,
    memoryUsedBytes: parseFiniteNumber(raw.memoryUsedBytes) ?? null,
    diskTotalBytes: parseFiniteNumber(raw.diskTotalBytes) ?? null,
    diskUsedBytes: parseFiniteNumber(raw.diskUsedBytes) ?? null,
    uptime: typeof raw.uptime === "string" ? raw.uptime : null,
  };
}

function parseVdsLocation(value: unknown): VdsLocation | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const ip = typeof raw.ip === "string" ? raw.ip.trim() : "";
  const country =
    typeof raw.country === "string" && raw.country.trim()
      ? raw.country.trim()
      : null;
  const city =
    typeof raw.city === "string" && raw.city.trim() ? raw.city.trim() : null;

  if (!ip || (!country && !city)) {
    return null;
  }

  return {
    ip,
    country,
    city,
  };
}

function parseVdsHealthStatus(value: unknown): VdsHealthStatus | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const status = parseVdsHealthStatusKind(raw.status);
  const checkedAt = typeof raw.checkedAt === "string" ? raw.checkedAt : null;

  if (!status || !checkedAt) {
    return null;
  }

  return {
    status,
    checkedAt,
    message: typeof raw.message === "string" ? raw.message : null,
    metrics: parseVdsHealthMetrics(raw.metrics),
    location: parseVdsLocation(raw.location),
  };
}

function parseVdsHealthSample(value: unknown): VdsHealthSample | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const checkedAt = typeof raw.checkedAt === "string" ? raw.checkedAt : null;
  const status = parseVdsHealthStatusKind(raw.status);

  if (!checkedAt || !status) {
    return null;
  }

  return {
    checkedAt,
    loadAverage: parseNullableFiniteNumber(raw.loadAverage),
    cpuCores: parseNullableFiniteNumber(raw.cpuCores),
    memoryUsedRatio: parseNullableFiniteNumber(raw.memoryUsedRatio),
    diskUsedRatio: parseNullableFiniteNumber(raw.diskUsedRatio),
    status,
  };
}

function parseVdsHealthSnapshot(value: unknown): VdsHealthSnapshot | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const history = Array.isArray(raw.history)
    ? raw.history
        .map(parseVdsHealthSample)
        .filter((sample): sample is VdsHealthSample => sample !== null)
        .slice(-VDS_HEALTH_HISTORY_LIMIT)
    : [];

  const status = parseVdsHealthStatus(raw.status);

  return {
    status,
    history,
    location: parseVdsLocation(raw.location) ?? status?.location ?? null,
  };
}

function parseVdsHealthSnapshotsByIdentity(
  value: unknown,
): VdsHealthSnapshotsByIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([identity, snapshot]) => [
        identity,
        parseVdsHealthSnapshot(snapshot),
      ])
      .filter(
        (entry): entry is [string, VdsHealthSnapshot] =>
          typeof entry[0] === "string" &&
          entry[0].length > 0 &&
          entry[1] !== null,
      ),
  );
}

function parsePort(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return undefined;
  }

  return value > 0 && value <= 65535 ? value : undefined;
}

function parseDraftPort(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return undefined;
  }

  return value >= 0 && value <= 65535 ? value : undefined;
}

function parseNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return undefined;
  }

  return value >= 0 ? value : undefined;
}

function parseString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return value;
}

function parseTunnelId(value: unknown): string | undefined {
  const text = parseString(value)?.trim();

  if (!text) {
    return undefined;
  }

  return text.slice(0, 80);
}

function parseProfileId(value: unknown): string | undefined {
  const text = parseString(value)?.trim();

  if (!text) {
    return undefined;
  }

  return text.slice(0, 80);
}

function parseProfileName(value: unknown, fallback: string): string {
  const text = parseString(value)?.trim().slice(0, 80);

  return text || fallback;
}

function parseTunnelLabel(value: unknown): string {
  return parseString(value)?.trim().slice(0, 80) ?? "";
}

function parseTunnelIdList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map(parseTunnelId)
    .filter((id): id is string => Boolean(id));
}

function parseProfileIdList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value.map(parseProfileId).filter((id): id is string => Boolean(id)),
    ),
  );
}

function parseRememberedRunningTunnels(
  value: unknown,
): RememberedRunningTunnels | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;

  return {
    localTunnelIds: parseTunnelIdList(raw.localTunnelIds),
    reverseTunnelIds: parseTunnelIdList(raw.reverseTunnelIds),
  };
}

function parseRememberedRunningTunnelsByProfile(
  value: unknown,
): RememberedRunningTunnelsByProfile | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .map(([profileId, remembered]): [string, RememberedRunningTunnels] | null => {
      const normalizedProfileId = parseProfileId(profileId);
      const normalizedRemembered = parseRememberedRunningTunnels(remembered);

      if (!normalizedProfileId || !normalizedRemembered) {
        return null;
      }

      return [normalizedProfileId, normalizedRemembered];
    })
    .filter(
      (entry): entry is [string, RememberedRunningTunnels] => entry !== null,
    );

  return Object.fromEntries(entries);
}

function parseLocalTunnels(value: unknown): LocalTunnelSettings[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  if (value.length === 0) {
    return [];
  }

  const tunnels = value
    .map((item): LocalTunnelSettings | null => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const raw = item as Record<string, unknown>;
      const id = parseTunnelId(raw.id);
      const localPort = parseDraftPort(raw.localPort);
      const remotePort = parseDraftPort(raw.remotePort);

      if (!id || localPort === undefined || remotePort === undefined) {
        return null;
      }

      return {
        id,
        label: parseTunnelLabel(raw.label),
        localPort,
        remotePort,
      };
    })
    .filter((tunnel): tunnel is LocalTunnelSettings => tunnel !== null);

  return tunnels.length > 0 ? tunnels : undefined;
}

function parseReverseTunnels(
  value: unknown,
): ReverseTunnelSettings[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  if (value.length === 0) {
    return [];
  }

  const tunnels = value
    .map((item): ReverseTunnelSettings | null => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const raw = item as Record<string, unknown>;
      const id = parseTunnelId(raw.id);
      const remotePort = parseDraftPort(raw.remotePort);
      const localPort = parseDraftPort(raw.localPort);

      if (!id || remotePort === undefined || localPort === undefined) {
        return null;
      }

      return {
        id,
        label: parseTunnelLabel(raw.label),
        remotePort,
        localPort,
      };
    })
    .filter((tunnel): tunnel is ReverseTunnelSettings => tunnel !== null);

  return tunnels.length > 0 ? tunnels : undefined;
}

function parseServerSessionSettings(
  value: unknown,
): ServerSessionSettings | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const remoteTunnelPort =
    parsePort(raw.remoteTunnelPort) ??
    DEFAULT_SERVER_SESSION_SETTINGS.remoteTunnelPort;
  const localSshPort =
    parsePort(raw.localSshPort) ?? DEFAULT_SERVER_SESSION_SETTINGS.localSshPort;

  return {
    host: parseString(raw.host) ?? DEFAULT_SERVER_SESSION_SETTINGS.host,
    sshPort: parsePort(raw.sshPort) ?? DEFAULT_SERVER_SESSION_SETTINGS.sshPort,
    username:
      parseString(raw.username) ?? DEFAULT_SERVER_SESSION_SETTINGS.username,
    identityFile:
      parseString(raw.identityFile) ??
      DEFAULT_SERVER_SESSION_SETTINGS.identityFile,
    remoteTunnelPort,
    localSshPort,
    localTunnels:
      parseLocalTunnels(raw.localTunnels) ??
      DEFAULT_SERVER_SESSION_SETTINGS.localTunnels,
    reverseTunnels: parseReverseTunnels(raw.reverseTunnels) ?? [
      {
        ...DEFAULT_SERVER_SESSION_SETTINGS.reverseTunnels[0],
        remotePort: remoteTunnelPort,
        localPort: localSshPort,
      },
    ],
    projectPath:
      parseString(raw.projectPath) ??
      DEFAULT_SERVER_SESSION_SETTINGS.projectPath,
  };
}

function parseServerSessionProfiles(
  value: unknown,
): ServerSessionProfile[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const profiles = value
    .map((item, index): ServerSessionProfile | null => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const raw = item as Record<string, unknown>;
      const id = parseProfileId(raw.id);
      const config = parseServerSessionSettings(raw.config);

      if (!id || !config) {
        return null;
      }

      return {
        id,
        name: parseProfileName(raw.name, `VDS ${index + 1}`),
        config,
      };
    })
    .filter((profile): profile is ServerSessionProfile => profile !== null);

  return profiles.length > 0 ? profiles : undefined;
}

function normalizeSavedSettings(saved: unknown): Partial<AppSettings> {
  if (!saved || typeof saved !== "object") {
    return {};
  }

  const raw = saved as Record<string, unknown>;
  const legacyServerSession =
    parseServerSessionSettings(raw.serverSession) ??
    DEFAULT_SERVER_SESSION_SETTINGS;
  const serverSessionProfiles = parseServerSessionProfiles(
    raw.serverSessionProfiles,
  ) ?? [
    {
      id: DEFAULT_SERVER_SESSION_PROFILE_ID,
      name: "VDS 1",
      config: legacyServerSession,
    },
  ];
  const requestedActiveProfileId = parseProfileId(
    raw.activeServerSessionProfileId,
  );
  const activeProfile =
    serverSessionProfiles.find(
      (profile) => profile.id === requestedActiveProfileId,
    ) ?? serverSessionProfiles[0];
  const profileIds = new Set(serverSessionProfiles.map((profile) => profile.id));
  const pinnedServerSessionProfileIds = parseProfileIdList(
    raw.pinnedServerSessionProfileIds,
  ).filter((id) => profileIds.has(id));

  return {
    theme: parseTheme(raw.theme),
    interfaceLanguage: parseInterfaceLanguage(raw.interfaceLanguage),
    vdsHealthPollIntervalMs: parseVdsHealthPollInterval(
      raw.vdsHealthPollIntervalMs,
    ),
    serverSession: activeProfile.config,
    serverSessionProfiles,
    activeServerSessionProfileId: activeProfile.id,
    pinnedServerSessionProfileIds,
    appLaunchCount: parseNonNegativeInteger(raw.appLaunchCount),
    remoteLoginPromptedForPort:
      parsePort(raw.remoteLoginPromptedForPort) ?? null,
    rememberedRunningTunnelsByProfile: parseRememberedRunningTunnelsByProfile(
      raw.rememberedRunningTunnelsByProfile,
    ),
  };
}

let store: Awaited<ReturnType<typeof load>> | null = null;

async function getStore() {
  if (!store) {
    store = await load("shared-vds.json");
  }

  return store;
}

export async function getSettings({
  reload = false,
}: {
  reload?: boolean;
} = {}): Promise<AppSettings> {
  const appStore = await getStore();

  if (reload) {
    try {
      await appStore.reload();
    } catch (error) {
      console.warn(
        "Failed to reload settings store, using in-memory store",
        error,
      );
    }
  }

  const saved = await appStore.get<unknown>("settings");
  const normalized = normalizeSavedSettings(saved);
  const defined = Object.fromEntries(
    Object.entries(normalized).filter(([, value]) => value !== undefined),
  );

  return { ...DEFAULT_SETTINGS, ...defined } as AppSettings;
}

export async function saveSettings(
  settings: Partial<AppSettings>,
): Promise<void> {
  const appStore = await getStore();
  const current = await getSettings({ reload: true });
  const nextSettings = { ...current, ...settings };

  await appStore.set("settings", nextSettings);
  await appStore.save();
}

export async function getVdsHealthSnapshotsByIdentity({
  reload = false,
}: {
  reload?: boolean;
} = {}): Promise<VdsHealthSnapshotsByIdentity> {
  if (reload && store) {
    try {
      await store.reload();
    } catch (error) {
      console.warn(
        "[store] failed to reload VDS health snapshots store",
        error,
      );
    }
  }

  const appStore = await getStore();
  const saved = await appStore.get<unknown>(VDS_HEALTH_SNAPSHOTS_STORE_KEY);

  return parseVdsHealthSnapshotsByIdentity(saved);
}

export async function saveVdsHealthSnapshotsByIdentity(
  snapshots: VdsHealthSnapshotsByIdentity,
): Promise<void> {
  const appStore = await getStore();

  await appStore.set(VDS_HEALTH_SNAPSHOTS_STORE_KEY, snapshots);
  await appStore.save();
}
