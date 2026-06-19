import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { listen, emit } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AlertCircle,
  Download,
  ExternalLink,
  Loader2,
  MoreHorizontal,
  Pencil,
  Pin,
  Plus,
  Server,
  Sliders,
  Trash2,
  X,
} from "lucide-react";
import { TitleBar } from "../../components/TitleBar";
import { ProxyTab } from "./tabs/ProxyTab";
import { SettingsTab } from "./tabs/SettingsTab";
import { SETTINGS_UPDATED_EVENT } from "../../lib/settingsEvents";
import {
  DEFAULT_SERVER_SESSION_SETTINGS,
  DEFAULT_SETTINGS,
  getVdsHealthSnapshotsByIdentity,
  getSettings,
  saveVdsHealthSnapshotsByIdentity,
  saveSettings,
  type AppSettings,
  type LocalTunnelSettings,
  type RememberedRunningTunnels,
  type RememberedRunningTunnelsByProfile,
  type ReverseTunnelSettings,
  type ServerSessionProfile,
  type ServerSessionSettings,
  type ThemePreference,
  type VdsHealthSnapshot,
  type VdsHealthSnapshotsByIdentity,
} from "../../lib/store";
import { logError } from "../../lib/logger";
import { watchThemePreference } from "../../lib/theme";
import {
  checkForAppUpdateNow,
  installAvailableAppUpdate,
  subscribeToAppUpdateState,
  type AppUpdateState,
} from "../../lib/updater";
import {
  translate,
  useAppLocale,
  useT,
  type TranslationKey,
} from "../../lib/i18n";
import {
  getVdsHealth,
  getVdsLocation,
  getVdsSystemStatus,
  getLocalTunnelStatus,
  getServerSessionStatus,
  messageFromError,
  openLocalSshSettings,
  requestLocalSshEnable,
  startLocalTunnel,
  startServerSessionTunnel,
  stopLocalTunnel,
  stopServerSessionTunnel,
  type DesktopPlatform,
  type VdsHealthSample,
  type VdsHealthStatus,
  type VdsLocation,
  type ServerSessionStatus,
  type VdsSystemStatus,
} from "../../lib/serverSessionClient";
import appPackage from "../../../package.json";

type ActiveView = "empty" | "vds" | "settings";
type AppNotification = {
  id: string;
  tone: "error";
  message: string;
};
const APP_VERSION = appPackage.version;
const APP_REPOSITORY_URL = "https://github.com/SerTimBerrners-Lee/shared-vds";
const VDS_REFERRAL_URL = "https://rdp-onedash.ru/r/a49cd94";
const APP_LAUNCH_COUNT_SESSION_KEY = "shared-vds-app-launch-counted";
const VDS_REFERRAL_MIN_LAUNCH_COUNT = 3;

function resolveInitialView(): ActiveView {
  const requestedTab = new URLSearchParams(window.location.search).get("tab");
  return requestedTab === "settings" ? "settings" : "empty";
}

function formatUpdateVersion(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

function claimAppLaunchCountForSession(): boolean {
  try {
    if (window.sessionStorage.getItem(APP_LAUNCH_COUNT_SESSION_KEY) === "1") {
      return false;
    }

    window.sessionStorage.setItem(APP_LAUNCH_COUNT_SESSION_KEY, "1");
    return true;
  } catch {
    return true;
  }
}

function NotificationToast({
  notification,
  top,
  onClose,
}: {
  notification: AppNotification;
  top: number;
  onClose: (id: string) => void;
}): ReactElement {
  const t = useT();
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const popover = popoverRef.current;

    if (popover?.showPopover && !popover.matches(":popover-open")) {
      popover.showPopover();
    }

    const timer = window.setTimeout(() => {
      onClose(notification.id);
    }, 9000);

    return () => {
      window.clearTimeout(timer);

      if (popover?.hidePopover && popover.matches(":popover-open")) {
        popover.hidePopover();
      }
    };
  }, [notification.id, onClose]);

  return (
    <div
      ref={popoverRef}
      className={`app-notification is-${notification.tone}`}
      role="alert"
      popover="manual"
      title={notification.message}
      style={{ top }}
    >
      <AlertCircle size={16} strokeWidth={2} aria-hidden="true" />
      <span>{notification.message}</span>
      <button
        type="button"
        className="app-notification-close"
        aria-label={t("window.close")}
        onClick={() => onClose(notification.id)}
      >
        <X size={14} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}

function AppNotifications({
  notifications,
  onClose,
}: {
  notifications: AppNotification[];
  onClose: (id: string) => void;
}): ReactElement | null {
  if (notifications.length === 0) {
    return null;
  }

  return (
    <>
      {notifications.map((notification, index) => (
        <NotificationToast
          key={notification.id}
          notification={notification}
          top={64 + index * 132}
          onClose={onClose}
        />
      ))}
    </>
  );
}

function AppUpdateFooter({
  onError,
}: {
  onError?: (message: string) => void;
}): ReactElement | null {
  const t = useT();
  const [updateState, setUpdateState] = useState<AppUpdateState>({
    status: "idle",
  });
  const reportedUpdateErrorRef = useRef<string | null>(null);

  useEffect(() => {
    if (import.meta.env.DEV) {
      return;
    }

    const unsubscribe = subscribeToAppUpdateState(setUpdateState);
    void checkForAppUpdateNow();

    return unsubscribe;
  }, []);

  useEffect(() => {
    if (updateState.status !== "error") {
      reportedUpdateErrorRef.current = null;
      return;
    }

    const message = updateState.errorMessage
      ? `${t("update.error")}: ${updateState.errorMessage}`
      : t("update.error");

    if (reportedUpdateErrorRef.current === message) {
      return;
    }

    reportedUpdateErrorRef.current = message;
    onError?.(message);
  }, [onError, t, updateState.errorMessage, updateState.status]);

  const showUpdateButton =
    !import.meta.env.DEV &&
    Boolean(updateState.version) &&
    (updateState.status === "available" ||
      updateState.status === "installing" ||
      updateState.status === "error");

  if (!showUpdateButton) {
    return null;
  }

  const updateVersion = updateState.version
    ? formatUpdateVersion(updateState.version)
    : "";
  const installing = updateState.status === "installing";

  return (
    <div style={{ display: "grid", gap: 5, padding: "0 8px" }}>
      <button
        type="button"
        className="btn"
        disabled={installing}
        onClick={() => {
          void installAvailableAppUpdate().catch((error) => {
            const message =
              error instanceof Error ? error.message : String(error);
            onError?.(`${t("update.error")}: ${message}`);
            void logError(
              "SETTINGS_APP",
              `Failed to install app update: ${message}`,
            );
          });
        }}
        style={{
          width: "100%",
          minHeight: 32,
          height: "auto",
          padding: "7px 9px",
          justifyContent: "center",
          borderRadius: 10,
          fontSize: "var(--text-sm)",
          fontWeight: "var(--weight-bold)",
          lineHeight: 1.25,
          whiteSpace: "normal",
          textAlign: "center",
        }}
      >
        {installing ? (
          <Loader2
            className="loading-soft-icon"
            size={13}
            strokeWidth={2}
            style={{ flexShrink: 0 }}
          />
        ) : (
          <Download size={13} strokeWidth={2} style={{ flexShrink: 0 }} />
        )}
        <span>
          {installing
            ? t("update.installing")
            : t("update.install", { version: updateVersion })}
        </span>
      </button>

      {updateState.status === "error" && (
        <div
          style={{
            fontSize: "var(--text-xs)",
            lineHeight: 1.35,
            color: "var(--danger)",
            textAlign: "center",
          }}
        >
          {t("update.error")}
        </div>
      )}
    </div>
  );
}

function VdsReferralCard({
  onOpen,
  onDismiss,
}: {
  onOpen: () => void;
  onDismiss?: () => void;
}): ReactElement {
  const t = useT();

  return (
    <div
      className={`settings-sidebar-referral-card ${
        onDismiss ? "has-dismiss" : ""
      }`}
    >
      {onDismiss && (
        <button
          type="button"
          className="settings-sidebar-referral-dismiss"
          aria-label={t("window.close")}
          title={t("window.close")}
          onClick={onDismiss}
        >
          <X size={12} strokeWidth={2} aria-hidden="true" />
        </button>
      )}
      <div className="settings-sidebar-referral-copy">
        <div className="settings-sidebar-referral-title">
          {t("session.vdsReferralTitle")}
        </div>
        <ul className="settings-sidebar-referral-description">
          <li>{t("session.vdsReferralBenefitIp")}</li>
          <li>{t("session.vdsReferralBenefitConfig")}</li>
          <li>{t("session.vdsReferralBenefitProxy")}</li>
        </ul>
      </div>
      <button
        type="button"
        className="btn settings-sidebar-referral-button"
        onClick={onOpen}
      >
        <span>{t("session.vdsReferralAction")}</span>
        <ExternalLink size={12} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}

function isVdsConnectionReady(config: ServerSessionSettings): boolean {
  return Boolean(
    config.host.trim() && config.username.trim() && config.sshPort > 0,
  );
}

function makeVdsHealthIdentity(
  profileId: string,
  config: ServerSessionSettings,
): string {
  return JSON.stringify([
    profileId,
    config.host.trim(),
    config.sshPort,
    config.username.trim(),
    config.identityFile.trim(),
  ]);
}

function metricRatio(
  used: number | null | undefined,
  total: number | null | undefined,
): number | null {
  if (
    typeof used !== "number" ||
    typeof total !== "number" ||
    !Number.isFinite(used) ||
    !Number.isFinite(total) ||
    total <= 0
  ) {
    return null;
  }

  return Math.max(0, Math.min(1, used / total));
}

function sampleFromVdsHealth(status: VdsHealthStatus): VdsHealthSample {
  return {
    checkedAt: status.checkedAt,
    loadAverage:
      typeof status.metrics?.loadAverage === "number"
        ? status.metrics.loadAverage
        : null,
    cpuCores:
      typeof status.metrics?.cpuCores === "number"
        ? status.metrics.cpuCores
        : null,
    memoryUsedRatio: metricRatio(
      status.metrics?.memoryUsedBytes,
      status.metrics?.memoryTotalBytes,
    ),
    diskUsedRatio: metricRatio(
      status.metrics?.diskUsedBytes,
      status.metrics?.diskTotalBytes,
    ),
    status: status.status,
  };
}

function appendVdsHealthSample(
  samples: VdsHealthSample[],
  status: VdsHealthStatus,
): VdsHealthSample[] {
  const nextSample = sampleFromVdsHealth(status);
  const previousSample = samples[samples.length - 1];
  const nextSamples =
    previousSample?.checkedAt === nextSample.checkedAt
      ? [...samples.slice(0, -1), nextSample]
      : [...samples, nextSample];

  return nextSamples.slice(-360);
}

function getEmptyVdsHealthSnapshot(): VdsHealthSnapshot {
  return {
    status: null,
    history: [],
    location: null,
  };
}

function mergeVdsHealthStatusLocation(
  status: VdsHealthStatus,
  location: VdsLocation | null,
): VdsHealthStatus {
  return location && !status.location ? { ...status, location } : status;
}

function appendVdsHealthSnapshotStatus(
  snapshot: VdsHealthSnapshot | undefined,
  status: VdsHealthStatus,
): VdsHealthSnapshot {
  const previousSnapshot = snapshot ?? getEmptyVdsHealthSnapshot();
  const location =
    status.location ??
    previousSnapshot.location ??
    previousSnapshot.status?.location ??
    null;
  const statusWithLocation = mergeVdsHealthStatusLocation(status, location);

  return {
    status: isTransientVdsHealthError(status)
      ? previousSnapshot.status
      : statusWithLocation,
    history: appendVdsHealthSample(previousSnapshot.history, statusWithLocation),
    location,
  };
}

function appendVdsHealthSnapshotLocation(
  snapshot: VdsHealthSnapshot | undefined,
  location: VdsLocation,
): VdsHealthSnapshot {
  const previousSnapshot = snapshot ?? getEmptyVdsHealthSnapshot();
  const status = previousSnapshot.status
    ? mergeVdsHealthStatusLocation(previousSnapshot.status, location)
    : null;

  return {
    ...previousSnapshot,
    status,
    location,
  };
}

function isTransientVdsHealthError(status: VdsHealthStatus): boolean {
  if (status.status !== "error") {
    return false;
  }

  const message = status.message?.toLocaleLowerCase() ?? "";

  return (
    message.includes("ssh проверка не прошла") ||
    message.includes("ssh проверка не ответила") ||
    message.includes("ssh exited with status") ||
    message.includes("connection timed out") ||
    message.includes("operation timed out") ||
    message.includes("connection reset") ||
    message.includes("broken pipe")
  );
}

function statusesById(
  statuses: ServerSessionStatus[],
): Record<string, ServerSessionStatus> {
  return Object.fromEntries(
    statuses
      .filter((status) => status.tunnelId)
      .map((status) => [status.tunnelId as string, status]),
  );
}

function getLocalSshPort(config: ServerSessionSettings): number | null {
  return (
    config.reverseTunnels.find((tunnel) => tunnel.localPort > 0)?.localPort ??
    (config.localSshPort > 0 ? config.localSshPort : null)
  );
}

function platformPromptKey(platform: DesktopPlatform): TranslationKey {
  if (platform === "macos") {
    return "session.localSshNeedsSettings.macos";
  }

  if (platform === "windows") {
    return "session.localSshNeedsSettings.windows";
  }

  if (platform === "linux") {
    return "session.localSshNeedsSettings.linux";
  }

  return "session.localSshNeedsSettings.unknown";
}

function localSshActionLabelKey(
  status: VdsSystemStatus | null,
): TranslationKey {
  return status?.platform === "linux"
    ? "session.openLocalSshInstructions"
    : "session.openLocalSshSettings";
}

function makeSessionId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

function createDefaultServerSessionForProfile(
  profileId: string,
): ServerSessionSettings {
  return {
    ...DEFAULT_SERVER_SESSION_SETTINGS,
    localTunnels: DEFAULT_SERVER_SESSION_SETTINGS.localTunnels.map(
      (tunnel) => ({
        ...tunnel,
        id: makeSessionId(`local-${profileId}`),
      }),
    ),
    reverseTunnels: DEFAULT_SERVER_SESSION_SETTINGS.reverseTunnels.map(
      (tunnel) => ({
        ...tunnel,
        id: makeSessionId(`reverse-${profileId}`),
      }),
    ),
  };
}

function createServerSessionProfile(index: number): ServerSessionProfile {
  const id = makeSessionId("vds");

  return {
    id,
    name: `VDS ${index}`,
    config: createDefaultServerSessionForProfile(id),
  };
}

function getServerSessionProfile(
  settings: AppSettings,
  profileId: string | null,
): ServerSessionProfile | null {
  if (!profileId) {
    return null;
  }

  return (
    settings.serverSessionProfiles.find(
      (profile) => profile.id === profileId,
    ) ?? null
  );
}

function isLiveTunnelStatus(status: ServerSessionStatus | undefined): boolean {
  return status?.status === "connected" || status?.status === "degraded";
}

function profileHasLiveTunnels(
  profile: ServerSessionProfile,
  localStatuses: Record<string, ServerSessionStatus>,
  reverseStatuses: Record<string, ServerSessionStatus>,
): boolean {
  return (
    profile.config.localTunnels.some((tunnel) =>
      isLiveTunnelStatus(localStatuses[tunnel.id]),
    ) ||
    profile.config.reverseTunnels.some((tunnel) =>
      isLiveTunnelStatus(reverseStatuses[tunnel.id]),
    )
  );
}

function tunnelIsReady(
  profile: ServerSessionProfile,
  tunnel: LocalTunnelSettings | ReverseTunnelSettings,
): boolean {
  return (
    isVdsConnectionReady(profile.config) &&
    tunnel.localPort > 0 &&
    tunnel.remotePort > 0
  );
}

function emptyRememberedRunningTunnels(): RememberedRunningTunnels {
  return {
    localTunnelIds: [],
    reverseTunnelIds: [],
  };
}

function rememberedRunningTunnelsForProfile(
  remembered: RememberedRunningTunnelsByProfile,
  profileId: string,
): RememberedRunningTunnels {
  return remembered[profileId] ?? emptyRememberedRunningTunnels();
}

function uniqueTunnelIds(ids: string[]): string[] {
  return Array.from(new Set(ids));
}

function pruneRememberedRunningTunnels(
  profiles: ServerSessionProfile[],
  remembered: RememberedRunningTunnelsByProfile,
): RememberedRunningTunnelsByProfile {
  const nextEntries = profiles
    .map((profile): [string, RememberedRunningTunnels] | null => {
      const profileRemembered = rememberedRunningTunnelsForProfile(
        remembered,
        profile.id,
      );
      const localTunnelIds = new Set(
        profile.config.localTunnels.map((tunnel) => tunnel.id),
      );
      const reverseTunnelIds = new Set(
        profile.config.reverseTunnels.map((tunnel) => tunnel.id),
      );
      const nextRemembered = {
        localTunnelIds: uniqueTunnelIds(
          profileRemembered.localTunnelIds.filter((id) =>
            localTunnelIds.has(id),
          ),
        ),
        reverseTunnelIds: uniqueTunnelIds(
          profileRemembered.reverseTunnelIds.filter((id) =>
            reverseTunnelIds.has(id),
          ),
        ),
      };

      if (
        nextRemembered.localTunnelIds.length === 0 &&
        nextRemembered.reverseTunnelIds.length === 0
      ) {
        return null;
      }

      return [profile.id, nextRemembered];
    })
    .filter(
      (entry): entry is [string, RememberedRunningTunnels] => entry !== null,
    );

  return Object.fromEntries(nextEntries);
}

function prunePinnedProfileIds(
  profiles: ServerSessionProfile[],
  pinnedProfileIds: string[],
): string[] {
  const profileIds = new Set(profiles.map((profile) => profile.id));

  return Array.from(
    new Set(pinnedProfileIds.filter((profileId) => profileIds.has(profileId))),
  );
}

function makeTunnelAutostartKey({
  profile,
  tunnel,
  kind,
}: {
  profile: ServerSessionProfile;
  tunnel: LocalTunnelSettings | ReverseTunnelSettings;
  kind: "local" | "reverse";
}): string {
  return JSON.stringify([
    kind,
    profile.id,
    tunnel.id,
    profile.config.host.trim(),
    profile.config.sshPort,
    profile.config.username.trim(),
    profile.config.identityFile.trim(),
    tunnel.localPort,
    tunnel.remotePort,
  ]);
}

function errorStatusForTunnel({
  tunnel,
  message,
}: {
  tunnel: LocalTunnelSettings | ReverseTunnelSettings;
  message: string;
}): ServerSessionStatus {
  return {
    tunnelId: tunnel.id,
    label: tunnel.label || tunnel.id,
    status: "error",
    pid: null,
    remoteTunnelPort: tunnel.remotePort,
    localSshPort: tunnel.localPort,
    errorMessage: message,
  };
}

function VdsSidebar({
  profiles,
  pinnedProfileIds,
  activeView,
  openedProfileId,
  localTunnelStatuses,
  reverseTunnelStatuses,
  onOpenProfile,
  onAdd,
  onRename,
  onTogglePinned,
  onRemove,
  onOpenSettings,
  showReferral,
  onOpenReferral,
  onDismissReferral,
  onOpenRepository,
  onError,
}: {
  profiles: ServerSessionProfile[];
  pinnedProfileIds: string[];
  activeView: ActiveView;
  openedProfileId: string | null;
  localTunnelStatuses: Record<string, ServerSessionStatus>;
  reverseTunnelStatuses: Record<string, ServerSessionStatus>;
  onOpenProfile: (profileId: string) => void;
  onAdd: () => void;
  onRename: (profileId: string, name: string) => void;
  onTogglePinned: (profileId: string) => void;
  onRemove: (profileId: string) => void;
  onOpenSettings: () => void;
  showReferral: boolean;
  onOpenReferral: () => void;
  onDismissReferral?: () => void;
  onOpenRepository: () => void;
  onError: (message: string) => void;
}): ReactElement {
  const t = useT();
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [editingProfileNameDraft, setEditingProfileNameDraft] = useState("");
  const [openActionsProfileId, setOpenActionsProfileId] = useState<
    string | null
  >(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const skipNextProfileRenameRef = useRef(false);
  const actionsContainerRef = useRef<HTMLDivElement | null>(null);
  const pinnedProfileIdSet = new Set(pinnedProfileIds);
  const orderedProfiles = [
    ...profiles.filter((profile) => pinnedProfileIdSet.has(profile.id)),
    ...profiles.filter((profile) => !pinnedProfileIdSet.has(profile.id)),
  ];

  useEffect(() => {
    if (!editingProfileId) {
      return;
    }

    const input = editInputRef.current;
    input?.focus();
    input?.select();
  }, [editingProfileId]);

  const beginEditingProfile = (profile: ServerSessionProfile): void => {
    skipNextProfileRenameRef.current = false;
    setOpenActionsProfileId(null);
    setEditingProfileId(profile.id);
    setEditingProfileNameDraft(profile.name);
  };

  const finishEditingProfile = (profile: ServerSessionProfile): void => {
    if (skipNextProfileRenameRef.current) {
      skipNextProfileRenameRef.current = false;
      setEditingProfileId((current) =>
        current === profile.id ? null : current,
      );
      setEditingProfileNameDraft("");
      return;
    }

    const nextName = editingProfileNameDraft.trim().slice(0, 80);

    setEditingProfileId((current) =>
      current === profile.id ? null : current,
    );
    setEditingProfileNameDraft("");

    if (nextName && nextName !== profile.name) {
      onRename(profile.id, editingProfileNameDraft);
    }
  };

  useEffect(() => {
    if (
      openActionsProfileId &&
      !profiles.some((profile) => profile.id === openActionsProfileId)
    ) {
      setOpenActionsProfileId(null);
    }
  }, [openActionsProfileId, profiles]);

  useEffect(() => {
    if (!openActionsProfileId) {
      return;
    }

    const handlePointerDown = (event: PointerEvent): void => {
      const container = actionsContainerRef.current;
      const target = event.target;

      if (target instanceof Node && container?.contains(target)) {
        return;
      }

      setOpenActionsProfileId(null);
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpenActionsProfileId(null);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [openActionsProfileId]);

  return (
    <aside
      className="settings-sidebar"
      aria-label={t("session.vdsSidebarTitle")}
    >
      <div className="settings-sidebar-main">
        <div className="settings-sidebar-head">
          <span className="settings-sidebar-brand">
            {t("session.vdsSidebarBrand")}
          </span>
        </div>
        <div
          className="settings-sidebar-list"
          role="list"
          aria-label={t("session.vdsSidebarTitle")}
        >
          {orderedProfiles.map((profile) => {
            const selected =
              activeView === "vds" && profile.id === openedProfileId;
            const editing = editingProfileId === profile.id;
            const pinned = pinnedProfileIdSet.has(profile.id);
            const actionsOpen = openActionsProfileId === profile.id;
            const hasLiveTunnels = profileHasLiveTunnels(
              profile,
              localTunnelStatuses,
              reverseTunnelStatuses,
            );
            const removeDisabled = profiles.length <= 1 || hasLiveTunnels;

            return (
              <div
                key={profile.id}
                className={`vds-profile-pill ${
                  selected ? "is-selected" : ""
                } ${editing ? "is-editing" : ""} ${
                  pinned ? "is-pinned" : ""
                }`}
                role="listitem"
                aria-current={selected ? "true" : undefined}
                tabIndex={0}
                onClick={() => {
                  setOpenActionsProfileId(null);
                  onOpenProfile(profile.id);
                }}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  beginEditingProfile(profile);
                }}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) {
                    return;
                  }

                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setOpenActionsProfileId(null);
                    onOpenProfile(profile.id);
                  }
                }}
              >
                {editing ? (
                  <input
                    ref={editInputRef}
                    className="vds-profile-name-input is-editing"
                    type="text"
                    value={editingProfileNameDraft}
                    maxLength={80}
                    spellCheck={false}
                    aria-label={`${t("session.vdsSidebarTitle")}: ${profile.name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                    }}
                    onDoubleClick={(event) => {
                      event.stopPropagation();
                    }}
                    onChange={(event) => {
                      setEditingProfileNameDraft(event.currentTarget.value);
                    }}
                    onBlur={() => {
                      finishEditingProfile(profile);
                    }}
                    onKeyDown={(event) => {
                      event.stopPropagation();

                      if (event.key === "Enter") {
                        event.preventDefault();
                        event.currentTarget.blur();
                      }

                      if (event.key === "Escape") {
                        event.preventDefault();
                        skipNextProfileRenameRef.current = true;
                        event.currentTarget.blur();
                      }
                    }}
                  />
                ) : (
                  <span className="vds-profile-name-wrap">
                    <span className="vds-profile-name-text">
                      {profile.name}
                    </span>
                    {pinned && (
                      <Pin
                        className="vds-profile-pin"
                        size={11}
                        strokeWidth={2}
                        aria-hidden="true"
                      />
                    )}
                  </span>
                )}
                <div
                  ref={actionsOpen ? actionsContainerRef : null}
                  className="vds-profile-actions"
                  onClick={(event) => {
                    event.stopPropagation();
                  }}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                  }}
                >
                  <button
                    type="button"
                    className={`btn vds-profile-actions-trigger ${
                      actionsOpen ? "is-open" : ""
                    }`}
                    aria-expanded={actionsOpen}
                    aria-label={`${t("session.vdsProfileActions")}: ${profile.name}`}
                    title={t("session.vdsProfileActions")}
                    onClick={(event) => {
                      event.stopPropagation();
                      setEditingProfileId(null);
                      setOpenActionsProfileId((current) =>
                        current === profile.id ? null : profile.id,
                      );
                    }}
                    onDoubleClick={(event) => {
                      event.stopPropagation();
                    }}
                  >
                    <MoreHorizontal
                      size={15}
                      strokeWidth={2}
                      aria-hidden="true"
                    />
                  </button>
                  {actionsOpen && (
                    <div className="vds-profile-actions-popover">
                      <button
                        type="button"
                        className="btn vds-profile-action-item"
                        onClick={(event) => {
                          event.stopPropagation();
                          setOpenActionsProfileId(null);
                          onTogglePinned(profile.id);
                        }}
                      >
                        <Pin size={13} strokeWidth={2} aria-hidden="true" />
                        <span>
                          {pinned
                            ? t("session.unpinVdsProfile")
                            : t("session.pinVdsProfile")}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="btn vds-profile-action-item"
                        onClick={(event) => {
                          event.stopPropagation();
                          beginEditingProfile(profile);
                        }}
                      >
                        <Pencil size={13} strokeWidth={2} aria-hidden="true" />
                        <span>{t("session.renameVdsProfile")}</span>
                      </button>
                      <button
                        type="button"
                        className="btn vds-profile-action-item is-danger"
                        disabled={removeDisabled}
                        aria-label={`${t("session.removeVdsProfile")}: ${profile.name}`}
                        title={
                          hasLiveTunnels
                            ? t("session.removeVdsProfileBlocked")
                            : t("session.removeVdsProfile")
                        }
                        onClick={(event) => {
                          event.stopPropagation();
                          if (removeDisabled) {
                            return;
                          }

                          setOpenActionsProfileId(null);
                          onRemove(profile.id);
                        }}
                      >
                        <Trash2 size={13} strokeWidth={2} aria-hidden="true" />
                        <span>{t("session.removeVdsProfile")}</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="settings-sidebar-action-stack">
          {showReferral && (
            <VdsReferralCard
              onOpen={onOpenReferral}
              onDismiss={onDismissReferral}
            />
          )}
          <div className="settings-sidebar-actions">
            <button
              type="button"
              className="btn vds-profile-add"
              onClick={onAdd}
            >
              <Plus size={13} strokeWidth={2} aria-hidden="true" />
              <span>{t("session.addVdsProfile")}</span>
            </button>
            <button
              type="button"
              className={`btn settings-sidebar-settings-button ${
                activeView === "settings" ? "active" : ""
              }`}
              aria-label={t("nav.settings")}
              title={t("nav.settings")}
              onClick={onOpenSettings}
            >
              <Sliders
                size={17}
                strokeWidth={activeView === "settings" ? 2.2 : 1.7}
                aria-hidden="true"
              />
            </button>
          </div>
          <button
            type="button"
            className="settings-sidebar-version"
            title={`Shared VDS ${APP_VERSION} - GitHub`}
            aria-label={`Shared VDS ${APP_VERSION} - GitHub`}
            onClick={onOpenRepository}
          >
            <span>v{APP_VERSION}</span>
            <ExternalLink size={10} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="settings-sidebar-bottom">
        <AppUpdateFooter onError={onError} />
      </div>
    </aside>
  );
}

export function SettingsApp(): ReactElement {
  const locale = useAppLocale();
  const t = (key: TranslationKey): string => translate(locale, key);
  const [activeView, setActiveView] = useState<ActiveView>(resolveInitialView);
  const [openedProfileId, setOpenedProfileId] = useState<string | null>(null);
  const [themePreference, setThemePreference] =
    useState<ThemePreference>("system");
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [localTunnelStatuses, setLocalTunnelStatuses] = useState<
    Record<string, ServerSessionStatus>
  >({});
  const [reverseTunnelStatuses, setReverseTunnelStatuses] = useState<
    Record<string, ServerSessionStatus>
  >({});
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [localTunnelBusyId, setLocalTunnelBusyId] = useState<string | null>(
    null,
  );
  const [reverseTunnelBusyId, setReverseTunnelBusyId] = useState<string | null>(
    null,
  );
  const [vdsSystemStatus, setVdsSystemStatus] =
    useState<VdsSystemStatus | null>(null);
  const [vdsHealthSnapshotsByIdentity, setVdsHealthSnapshotsByIdentity] =
    useState<VdsHealthSnapshotsByIdentity>({});
  const [vdsHealthLoading, setVdsHealthLoading] = useState(false);
  const [vdsHealthRefreshNonce, setVdsHealthRefreshNonce] = useState(0);
  const [referralDismissedForDevSession, setReferralDismissedForDevSession] =
    useState(false);
  const [settingsReady, setSettingsReady] = useState(false);
  const remoteLoginPromptInFlight = useRef(false);
  const launchCountRecordedRef = useRef(false);
  const attemptedTunnelAutostartKeysRef = useRef<Set<string>>(new Set());
  const attemptedVdsLocationIdentitiesRef = useRef<Set<string>>(new Set());
  const openedProfile = getServerSessionProfile(appSettings, openedProfileId);
  const activeServerSession =
    openedProfile?.config ?? DEFAULT_SERVER_SESSION_SETTINGS;
  const activeLocalSshPort = openedProfile
    ? getLocalSshPort(activeServerSession)
    : null;
  const vdsHealthIdentity = openedProfile
    ? makeVdsHealthIdentity(openedProfile.id, activeServerSession)
    : null;
  const vdsHealthPollIntervalMs = appSettings.vdsHealthPollIntervalMs;
  const currentVdsHealthSnapshot = vdsHealthIdentity
    ? vdsHealthSnapshotsByIdentity[vdsHealthIdentity]
    : null;
  const vdsHealthStatus = currentVdsHealthSnapshot?.status ?? null;
  const vdsLocation =
    currentVdsHealthSnapshot?.location ?? vdsHealthStatus?.location ?? null;
  const vdsHealthHistory = currentVdsHealthSnapshot?.history ?? [];

  const dismissNotification = useCallback((id: string): void => {
    setNotifications((current) =>
      current.filter((notification) => notification.id !== id),
    );
  }, []);

  const showErrorNotification = useCallback((message: string): void => {
    const normalizedMessage = message.trim();

    if (!normalizedMessage) {
      return;
    }

    setNotifications((current) => [
      {
        id: makeSessionId("notification"),
        tone: "error",
        message: normalizedMessage,
      },
      ...current
        .filter((notification) => notification.message !== normalizedMessage)
        .slice(0, 3),
    ]);
  }, []);

  const persistVdsHealthSnapshots = useCallback(
    (snapshots: VdsHealthSnapshotsByIdentity): void => {
      void saveVdsHealthSnapshotsByIdentity(snapshots).catch((error) => {
        void logError(
          "SETTINGS_APP",
          `Failed to save VDS health snapshots: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    },
    [],
  );

  const updateRememberedRunningTunnels = useCallback(
    async (
      profileId: string,
      updateProfileState: (
        remembered: RememberedRunningTunnels,
      ) => RememberedRunningTunnels,
    ): Promise<void> => {
      const currentRemembered = appSettings.rememberedRunningTunnelsByProfile;
      const nextProfileRemembered = updateProfileState(
        rememberedRunningTunnelsForProfile(currentRemembered, profileId),
      );
      const nextRemembered = pruneRememberedRunningTunnels(
        appSettings.serverSessionProfiles,
        {
          ...currentRemembered,
          [profileId]: {
            localTunnelIds: uniqueTunnelIds(
              nextProfileRemembered.localTunnelIds,
            ),
            reverseTunnelIds: uniqueTunnelIds(
              nextProfileRemembered.reverseTunnelIds,
            ),
          },
        },
      );

      setAppSettings((current) => ({
        ...current,
        rememberedRunningTunnelsByProfile: nextRemembered,
      }));
      await saveSettings({
        rememberedRunningTunnelsByProfile: nextRemembered,
      });
    },
    [
      appSettings.rememberedRunningTunnelsByProfile,
      appSettings.serverSessionProfiles,
    ],
  );

  useEffect(() => {
    const syncSettings = async (reload = false): Promise<void> => {
      const settings = await getSettings({ reload });
      const shouldRecordLaunch =
        !launchCountRecordedRef.current && claimAppLaunchCountForSession();
      launchCountRecordedRef.current = true;

      if (shouldRecordLaunch) {
        const appLaunchCount = Math.min(
          settings.appLaunchCount + 1,
          Number.MAX_SAFE_INTEGER,
        );
        const nextSettings = {
          ...settings,
          appLaunchCount,
        };

        setThemePreference(nextSettings.theme);
        setAppSettings(nextSettings);
        await saveSettings({ appLaunchCount }).catch((error) => {
          void logError(
            "SETTINGS_APP",
            `Failed to save app launch count: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      } else {
        setThemePreference(settings.theme);
        setAppSettings(settings);
      }

      setSettingsReady(true);
    };

    void syncSettings(true);

    const unlistenPromise = listen(SETTINGS_UPDATED_EVENT, () => {
      void syncSettings(true);
    });

    return () => {
      unlistenPromise.then((dispose) => dispose());
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    getVdsHealthSnapshotsByIdentity({ reload: true })
      .then((snapshots) => {
        if (cancelled) {
          return;
        }

        setVdsHealthSnapshotsByIdentity((current) => ({
          ...snapshots,
          ...current,
        }));
      })
      .catch((error) => {
        if (!cancelled) {
          void logError(
            "SETTINGS_APP",
            `Failed to load VDS health snapshots: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!settingsReady) {
      return undefined;
    }

    return watchThemePreference(themePreference);
  }, [settingsReady, themePreference]);

  useEffect(() => {
    if (
      openedProfileId &&
      !appSettings.serverSessionProfiles.some(
        (profile) => profile.id === openedProfileId,
      )
    ) {
      setOpenedProfileId(null);
      if (activeView === "vds") {
        setActiveView("empty");
      }
    }
  }, [activeView, appSettings.serverSessionProfiles, openedProfileId]);

  useEffect(() => {
    if (!settingsReady || activeView !== "vds" || !activeLocalSshPort) {
      setVdsSystemStatus(null);
      return;
    }

    let cancelled = false;

    const syncVdsSystemStatus = async (): Promise<void> => {
      try {
        const status = await getVdsSystemStatus(activeLocalSshPort);
        if (!cancelled) {
          setVdsSystemStatus(status);
        }
      } catch (error) {
        if (!cancelled) {
          void logError(
            "SETTINGS_APP",
            `Failed to sync VDS system status: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    };

    void syncVdsSystemStatus();
    const timer = window.setInterval(() => void syncVdsSystemStatus(), 6000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeLocalSshPort, activeView, settingsReady]);

  useEffect(() => {
    if (
      !settingsReady ||
      activeView !== "vds" ||
      !openedProfile ||
      !vdsHealthIdentity ||
      !isVdsConnectionReady(activeServerSession) ||
      vdsLocation ||
      attemptedVdsLocationIdentitiesRef.current.has(vdsHealthIdentity)
    ) {
      return;
    }

    let cancelled = false;
    const config = activeServerSession;
    const identity = vdsHealthIdentity;

    attemptedVdsLocationIdentitiesRef.current.add(identity);

    void getVdsLocation(config)
      .then((location) => {
        if (cancelled || !location) {
          return;
        }

        setVdsHealthSnapshotsByIdentity((current) => {
          const nextSnapshots = {
            ...current,
            [identity]: appendVdsHealthSnapshotLocation(
              current[identity],
              location,
            ),
          };

          persistVdsHealthSnapshots(nextSnapshots);

          return nextSnapshots;
        });
      })
      .catch((error) => {
        void logError(
          "SETTINGS_APP",
          `Failed to sync VDS location: ${messageFromError(error)}`,
        );
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeView,
    persistVdsHealthSnapshots,
    settingsReady,
    vdsHealthIdentity,
    vdsLocation,
  ]);

  useEffect(() => {
    if (
      !settingsReady ||
      activeView !== "vds" ||
      !openedProfile ||
      !vdsHealthIdentity ||
      !isVdsConnectionReady(activeServerSession)
    ) {
      setVdsHealthLoading(false);
      return;
    }

    let cancelled = false;
    let requestSerial = 0;
    let requestInFlight = false;
    const config = activeServerSession;
    const identity = vdsHealthIdentity;

    const recordVdsHealthStatus = (status: VdsHealthStatus): void => {
      setVdsHealthSnapshotsByIdentity((current) => {
        const nextSnapshots = {
          ...current,
          [identity]: appendVdsHealthSnapshotStatus(
            current[identity],
            status,
          ),
        };

        persistVdsHealthSnapshots(nextSnapshots);

        return nextSnapshots;
      });
    };

    const syncVdsHealthStatus = async (showLoading: boolean): Promise<void> => {
      if (requestInFlight) {
        return;
      }

      const requestId = ++requestSerial;
      requestInFlight = true;

      if (showLoading) {
        setVdsHealthLoading(true);
      }

      try {
        const status = await getVdsHealth(config);
        if (!cancelled && requestId === requestSerial) {
          recordVdsHealthStatus(status);
        }
      } catch (error) {
        const message = messageFromError(error);
        const errorStatus: VdsHealthStatus = {
          status: "error",
          checkedAt: new Date().toISOString(),
          message,
          metrics: null,
        };
        if (!cancelled && requestId === requestSerial) {
          recordVdsHealthStatus(errorStatus);
        }
        void logError("SETTINGS_APP", `Failed to sync VDS health: ${message}`);
      } finally {
        requestInFlight = false;
        if (!cancelled && requestId === requestSerial) {
          setVdsHealthLoading(false);
        }
      }
    };

    void syncVdsHealthStatus(true);
    const timer = window.setInterval(
      () => void syncVdsHealthStatus(false),
      vdsHealthPollIntervalMs,
    );

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    activeView,
    persistVdsHealthSnapshots,
    settingsReady,
    vdsHealthIdentity,
    vdsHealthPollIntervalMs,
    vdsHealthRefreshNonce,
  ]);

  useEffect(() => {
    if (
      !settingsReady ||
      remoteLoginPromptInFlight.current ||
      !vdsSystemStatus
    ) {
      return;
    }

    const requestLocalSshPermission = async (): Promise<void> => {
      remoteLoginPromptInFlight.current = true;

      try {
        const localSshPort = vdsSystemStatus.localSsh.port;

        if (!localSshPort || vdsSystemStatus.localSsh.available) {
          return;
        }

        if (appSettings.remoteLoginPromptedForPort === localSshPort) {
          return;
        }

        if (
          !vdsSystemStatus.localSsh.canOpenSettings &&
          !vdsSystemStatus.localSsh.canRequestEnable
        ) {
          return;
        }

        setAppSettings((current) => ({
          ...current,
          remoteLoginPromptedForPort: localSshPort,
        }));
        await saveSettings({ remoteLoginPromptedForPort: localSshPort });

        const accepted = await ask(
          t(platformPromptKey(vdsSystemStatus.platform)),
          {
            title: t("session.localSshPromptTitle"),
            kind: "warning",
            okLabel: t(localSshActionLabelKey(vdsSystemStatus)),
            cancelLabel: t("session.remoteLoginPromptCancel"),
          },
        );

        if (!accepted) {
          return;
        }

        if (vdsSystemStatus.localSsh.canOpenSettings) {
          try {
            await openLocalSshSettings();
          } catch (error) {
            void logError(
              "SETTINGS_APP",
              `Failed to open Local SSH settings: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }

        if (vdsSystemStatus.localSsh.canRequestEnable) {
          await requestLocalSshEnable(localSshPort);
        }
      } catch {
        // Startup permission checks must never surface as app errors.
      } finally {
        remoteLoginPromptInFlight.current = false;
      }
    };

    void requestLocalSshPermission();
  }, [
    appSettings.remoteLoginPromptedForPort,
    settingsReady,
    t,
    vdsSystemStatus,
  ]);

  useEffect(() => {
    let cancelled = false;

    const syncStatus = async (): Promise<void> => {
      try {
        const [nextLocalStatus, nextReverseStatus] = await Promise.all([
          getLocalTunnelStatus(),
          getServerSessionStatus(),
        ]);
        if (!cancelled) {
          setLocalTunnelStatuses(statusesById(nextLocalStatus));
          setReverseTunnelStatuses(statusesById(nextReverseStatus));
        }
      } catch (error) {
        if (!cancelled) {
          void logError(
            "SETTINGS_APP",
            `Failed to sync server session status: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    };

    void syncStatus();
    const timer = window.setInterval(() => void syncStatus(), 4000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!settingsReady) {
      return;
    }

    let cancelled = false;

    const restoreRunningTunnels = async (): Promise<void> => {
      const rememberedByProfile = pruneRememberedRunningTunnels(
        appSettings.serverSessionProfiles,
        appSettings.rememberedRunningTunnelsByProfile,
      );

      for (const profile of appSettings.serverSessionProfiles) {
        const remembered = rememberedRunningTunnelsForProfile(
          rememberedByProfile,
          profile.id,
        );

        for (const tunnel of profile.config.localTunnels) {
          if (!remembered.localTunnelIds.includes(tunnel.id)) {
            continue;
          }

          if (!tunnelIsReady(profile, tunnel)) {
            continue;
          }

          if (isLiveTunnelStatus(localTunnelStatuses[tunnel.id])) {
            continue;
          }

          const autostartKey = makeTunnelAutostartKey({
            profile,
            tunnel,
            kind: "local",
          });

          if (attemptedTunnelAutostartKeysRef.current.has(autostartKey)) {
            continue;
          }

          attemptedTunnelAutostartKeysRef.current.add(autostartKey);

          try {
            const nextStatus = await startLocalTunnel(profile.config, tunnel);
            if (!cancelled) {
              setLocalTunnelStatuses((current) => ({
                ...current,
                [tunnel.id]: nextStatus,
              }));
            }
          } catch (error) {
            const message = messageFromError(error);
            if (!cancelled) {
              setLocalTunnelStatuses((current) => ({
                ...current,
                [tunnel.id]: errorStatusForTunnel({ tunnel, message }),
              }));
            }
            void logError(
              "SETTINGS_APP",
              `Failed to autostart local SSH tunnel (${tunnel.id}): ${message}`,
            );
          }
        }

        for (const tunnel of profile.config.reverseTunnels) {
          if (!remembered.reverseTunnelIds.includes(tunnel.id)) {
            continue;
          }

          if (!tunnelIsReady(profile, tunnel)) {
            continue;
          }

          if (isLiveTunnelStatus(reverseTunnelStatuses[tunnel.id])) {
            continue;
          }

          const autostartKey = makeTunnelAutostartKey({
            profile,
            tunnel,
            kind: "reverse",
          });

          if (attemptedTunnelAutostartKeysRef.current.has(autostartKey)) {
            continue;
          }

          attemptedTunnelAutostartKeysRef.current.add(autostartKey);

          try {
            const nextStatus = await startServerSessionTunnel(
              profile.config,
              tunnel,
            );
            if (!cancelled) {
              setReverseTunnelStatuses((current) => ({
                ...current,
                [tunnel.id]: nextStatus,
              }));
            }
          } catch (error) {
            const message = messageFromError(error);
            if (!cancelled) {
              setReverseTunnelStatuses((current) => ({
                ...current,
                [tunnel.id]: errorStatusForTunnel({ tunnel, message }),
              }));
            }
            void logError(
              "SETTINGS_APP",
              `Failed to autostart reverse SSH tunnel (${tunnel.id}): ${message}`,
            );
          }
        }
      }
    };

    void restoreRunningTunnels();

    return () => {
      cancelled = true;
    };
  }, [
    appSettings.rememberedRunningTunnelsByProfile,
    appSettings.serverSessionProfiles,
    localTunnelStatuses,
    reverseTunnelStatuses,
    settingsReady,
  ]);

  const updateServerSession = async (
    patch: Partial<ServerSessionSettings>,
  ): Promise<void> => {
    if (!openedProfile) {
      return;
    }

    const currentRemoteLoginPort = getLocalSshPort(activeServerSession);
    const nextServerSession = {
      ...activeServerSession,
      ...patch,
    };
    const nextProfiles = appSettings.serverSessionProfiles.map((profile) =>
      profile.id === openedProfile.id
        ? { ...profile, config: nextServerSession }
        : profile,
    );
    const nextRemoteLoginPort = getLocalSshPort(nextServerSession);
    const shouldResetRemoteLoginPrompt =
      nextRemoteLoginPort !== currentRemoteLoginPort;
    const nextRememberedRunningTunnels = pruneRememberedRunningTunnels(
      nextProfiles,
      appSettings.rememberedRunningTunnelsByProfile,
    );
    const nextSettings = {
      ...appSettings,
      serverSession: nextServerSession,
      serverSessionProfiles: nextProfiles,
      remoteLoginPromptedForPort: shouldResetRemoteLoginPrompt
        ? null
        : appSettings.remoteLoginPromptedForPort,
      rememberedRunningTunnelsByProfile: nextRememberedRunningTunnels,
    };

    setAppSettings(nextSettings);
    await saveSettings({
      serverSession: nextServerSession,
      serverSessionProfiles: nextProfiles,
      remoteLoginPromptedForPort: nextSettings.remoteLoginPromptedForPort,
      rememberedRunningTunnelsByProfile: nextRememberedRunningTunnels,
    });
    await emit(SETTINGS_UPDATED_EVENT).catch((error) => {
      void logError(
        "SETTINGS_APP",
        `Failed to emit settings update event: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };

  const saveServerSessionProfiles = async (
    profiles: ServerSessionProfile[],
    activeProfileId: string,
  ): Promise<void> => {
    if (profiles.length === 0) {
      return;
    }

    const nextActiveProfile =
      profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0];
    const nextRememberedRunningTunnels = pruneRememberedRunningTunnels(
      profiles,
      appSettings.rememberedRunningTunnelsByProfile,
    );
    const nextPinnedProfileIds = prunePinnedProfileIds(
      profiles,
      appSettings.pinnedServerSessionProfileIds,
    );
    const nextSettings = {
      ...appSettings,
      serverSession: nextActiveProfile.config,
      serverSessionProfiles: profiles,
      activeServerSessionProfileId: nextActiveProfile.id,
      pinnedServerSessionProfileIds: nextPinnedProfileIds,
      rememberedRunningTunnelsByProfile: nextRememberedRunningTunnels,
    };

    setAppSettings(nextSettings);
    await saveSettings({
      serverSession: nextActiveProfile.config,
      serverSessionProfiles: profiles,
      activeServerSessionProfileId: nextActiveProfile.id,
      pinnedServerSessionProfileIds: nextPinnedProfileIds,
      rememberedRunningTunnelsByProfile: nextRememberedRunningTunnels,
    });
    await emit(SETTINGS_UPDATED_EVENT).catch((error) => {
      void logError(
        "SETTINGS_APP",
        `Failed to emit settings update event: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };

  const selectServerSessionProfile = async (
    profileId: string,
  ): Promise<void> => {
    setVdsHealthLoading(false);
    setOpenedProfileId(profileId);
    setActiveView("vds");

    if (profileId !== appSettings.activeServerSessionProfileId) {
      await saveServerSessionProfiles(
        appSettings.serverSessionProfiles,
        profileId,
      );
    }
  };

  const refreshVdsHealth = useCallback((): void => {
    setVdsHealthRefreshNonce((current) => current + 1);
  }, []);

  const openVdsReferral = async (): Promise<void> => {
    try {
      await openUrl(VDS_REFERRAL_URL);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      showErrorNotification(t("session.vdsReferralOpenError"));
      void logError(
        "SETTINGS_APP",
        `Failed to open VDS referral URL: ${message}`,
      );
    }
  };

  const openAppRepository = async (): Promise<void> => {
    try {
      await openUrl(APP_REPOSITORY_URL);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      showErrorNotification(t("app.repositoryOpenError"));
      void logError(
        "SETTINGS_APP",
        `Failed to open Shared VDS GitHub URL: ${message}`,
      );
    }
  };

  const addServerSessionProfile = async (): Promise<void> => {
    const nextProfile = createServerSessionProfile(
      appSettings.serverSessionProfiles.length + 1,
    );

    await saveServerSessionProfiles(
      [...appSettings.serverSessionProfiles, nextProfile],
      nextProfile.id,
    );
    setOpenedProfileId(nextProfile.id);
    setActiveView("vds");
  };

  const renameServerSessionProfile = async (
    profileId: string,
    name: string,
  ): Promise<void> => {
    const normalizedName = name.trim().slice(0, 80) || "VDS";
    const nextProfiles = appSettings.serverSessionProfiles.map((profile) =>
      profile.id === profileId ? { ...profile, name: normalizedName } : profile,
    );

    await saveServerSessionProfiles(nextProfiles, profileId);
  };

  const togglePinnedServerSessionProfile = async (
    profileId: string,
  ): Promise<void> => {
    if (
      !appSettings.serverSessionProfiles.some(
        (profile) => profile.id === profileId,
      )
    ) {
      return;
    }

    const currentlyPinned =
      appSettings.pinnedServerSessionProfileIds.includes(profileId);
    const nextPinnedProfileIds = prunePinnedProfileIds(
      appSettings.serverSessionProfiles,
      currentlyPinned
        ? appSettings.pinnedServerSessionProfileIds.filter(
            (pinnedProfileId) => pinnedProfileId !== profileId,
          )
        : [...appSettings.pinnedServerSessionProfileIds, profileId],
    );
    const nextSettings = {
      ...appSettings,
      pinnedServerSessionProfileIds: nextPinnedProfileIds,
    };

    setAppSettings(nextSettings);
    await saveSettings({
      pinnedServerSessionProfileIds: nextPinnedProfileIds,
    });
    await emit(SETTINGS_UPDATED_EVENT).catch((error) => {
      void logError(
        "SETTINGS_APP",
        `Failed to emit settings update event: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };

  const removeServerSessionProfile = async (
    profileId: string,
  ): Promise<void> => {
    if (appSettings.serverSessionProfiles.length <= 1) {
      return;
    }

    const profile = appSettings.serverSessionProfiles.find(
      (item) => item.id === profileId,
    );

    if (
      !profile ||
      profileHasLiveTunnels(profile, localTunnelStatuses, reverseTunnelStatuses)
    ) {
      return;
    }

    const nextProfiles = appSettings.serverSessionProfiles.filter(
      (item) => item.id !== profileId,
    );
    const nextActiveProfileId =
      appSettings.activeServerSessionProfileId === profileId
        ? nextProfiles[0].id
        : appSettings.activeServerSessionProfileId;
    const removingOpenedProfile = openedProfileId === profileId;

    await saveServerSessionProfiles(nextProfiles, nextActiveProfileId);
    if (removingOpenedProfile) {
      setOpenedProfileId(null);
      setActiveView("empty");
    }
  };

  const startLocalSshTunnel = async (
    tunnel: LocalTunnelSettings,
  ): Promise<void> => {
    if (!openedProfile) {
      return;
    }

    setLocalTunnelBusyId(tunnel.id);

    try {
      const nextStatus = await startLocalTunnel(activeServerSession, tunnel);
      setLocalTunnelStatuses((current) => ({
        ...current,
        [tunnel.id]: nextStatus,
      }));
      if (isLiveTunnelStatus(nextStatus)) {
        await updateRememberedRunningTunnels(
          openedProfile.id,
          (remembered) => ({
            ...remembered,
            localTunnelIds: [...remembered.localTunnelIds, tunnel.id],
          }),
        ).catch((error) => {
          void logError(
            "SETTINGS_APP",
            `Failed to remember local tunnel state: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showErrorNotification(message);
      void logError(
        "SETTINGS_APP",
        `Failed to start local SSH tunnel: ${message}`,
      );
    } finally {
      setLocalTunnelBusyId(null);
    }
  };

  const stopLocalSshTunnel = async (tunnelId: string): Promise<void> => {
    setLocalTunnelBusyId(tunnelId);

    try {
      const nextStatus = await stopLocalTunnel(tunnelId);
      setLocalTunnelStatuses((current) => ({
        ...current,
        [tunnelId]: nextStatus,
      }));
      if (openedProfile) {
        await updateRememberedRunningTunnels(
          openedProfile.id,
          (remembered) => ({
            ...remembered,
            localTunnelIds: remembered.localTunnelIds.filter(
              (id) => id !== tunnelId,
            ),
          }),
        ).catch((error) => {
          void logError(
            "SETTINGS_APP",
            `Failed to forget local tunnel state: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showErrorNotification(message);
      void logError(
        "SETTINGS_APP",
        `Failed to stop local SSH tunnel: ${message}`,
      );
    } finally {
      setLocalTunnelBusyId(null);
    }
  };

  const startReverseSshTunnel = async (
    tunnel: ReverseTunnelSettings,
  ): Promise<void> => {
    if (!openedProfile) {
      return;
    }

    setReverseTunnelBusyId(tunnel.id);

    try {
      const nextStatus = await startServerSessionTunnel(
        activeServerSession,
        tunnel,
      );
      setReverseTunnelStatuses((current) => ({
        ...current,
        [tunnel.id]: nextStatus,
      }));
      if (isLiveTunnelStatus(nextStatus)) {
        await updateRememberedRunningTunnels(
          openedProfile.id,
          (remembered) => ({
            ...remembered,
            reverseTunnelIds: [...remembered.reverseTunnelIds, tunnel.id],
          }),
        ).catch((error) => {
          void logError(
            "SETTINGS_APP",
            `Failed to remember reverse tunnel state: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showErrorNotification(message);
      void logError(
        "SETTINGS_APP",
        `Failed to start reverse SSH tunnel: ${message}`,
      );
    } finally {
      setReverseTunnelBusyId(null);
    }
  };

  const stopReverseSshTunnel = async (tunnelId: string): Promise<void> => {
    setReverseTunnelBusyId(tunnelId);

    try {
      const nextStatus = await stopServerSessionTunnel(tunnelId);
      setReverseTunnelStatuses((current) => ({
        ...current,
        [tunnelId]: nextStatus,
      }));
      if (openedProfile) {
        await updateRememberedRunningTunnels(
          openedProfile.id,
          (remembered) => ({
            ...remembered,
            reverseTunnelIds: remembered.reverseTunnelIds.filter(
              (id) => id !== tunnelId,
            ),
          }),
        ).catch((error) => {
          void logError(
            "SETTINGS_APP",
            `Failed to forget reverse tunnel state: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showErrorNotification(message);
      void logError(
        "SETTINGS_APP",
        `Failed to stop reverse SSH tunnel: ${message}`,
      );
    } finally {
      setReverseTunnelBusyId(null);
    }
  };

  const showVdsReferral =
    appSettings.appLaunchCount >= VDS_REFERRAL_MIN_LAUNCH_COUNT &&
    !(import.meta.env.DEV && referralDismissedForDevSession);

  return (
    <div className="app-root">
      <div className="settings-window-shell">
        <TitleBar />

        <div className="settings-layout">
          <VdsSidebar
            profiles={appSettings.serverSessionProfiles}
            pinnedProfileIds={appSettings.pinnedServerSessionProfileIds}
            activeView={activeView}
            openedProfileId={openedProfileId}
            localTunnelStatuses={localTunnelStatuses}
            reverseTunnelStatuses={reverseTunnelStatuses}
            onOpenProfile={(profileId) => {
              void selectServerSessionProfile(profileId);
            }}
            onAdd={() => {
              void addServerSessionProfile();
            }}
            onRename={(profileId, name) => {
              void renameServerSessionProfile(profileId, name);
            }}
            onTogglePinned={(profileId) => {
              void togglePinnedServerSessionProfile(profileId);
            }}
            onRemove={(profileId) => {
              void removeServerSessionProfile(profileId);
            }}
            onOpenSettings={() => {
              setActiveView("settings");
            }}
            showReferral={showVdsReferral}
            onOpenReferral={() => {
              void openVdsReferral();
            }}
            onOpenRepository={() => {
              void openAppRepository();
            }}
            onDismissReferral={
              import.meta.env.DEV
                ? () => setReferralDismissedForDevSession(true)
                : undefined
            }
            onError={showErrorNotification}
          />

          <main className="settings-content-shell">
            <div className="settings-content-scroll">
              {activeView === "empty" && (
                <section className="settings-empty-shell">
                  <Server size={26} strokeWidth={1.7} aria-hidden="true" />
                  <div>
                    <h1>{t("session.emptyShellTitle")}</h1>
                    <p>{t("session.emptyShellDescription")}</p>
                  </div>
                </section>
              )}

              {activeView === "vds" && openedProfile && (
                <ProxyTab
                  profileId={openedProfile.id}
                  config={activeServerSession}
                  settingsReady={settingsReady}
                  localTunnelStatuses={localTunnelStatuses}
                  reverseTunnelStatuses={reverseTunnelStatuses}
                  localTunnelBusyId={localTunnelBusyId}
                  reverseTunnelBusyId={reverseTunnelBusyId}
                  vdsSystemStatus={vdsSystemStatus}
                  vdsHealthStatus={vdsHealthStatus}
                  vdsHealthHistory={vdsHealthHistory}
                  vdsHealthLoading={vdsHealthLoading}
                  vdsConnectionReady={isVdsConnectionReady(activeServerSession)}
                  onRefreshVdsHealth={refreshVdsHealth}
                  onConfigChange={(patch) => {
                    void updateServerSession(patch);
                  }}
                  onStartLocalTunnel={(tunnel) => {
                    void startLocalSshTunnel(tunnel);
                  }}
                  onStopLocalTunnel={(tunnelId) => {
                    void stopLocalSshTunnel(tunnelId);
                  }}
                  onStartReverseTunnel={(tunnel) => {
                    void startReverseSshTunnel(tunnel);
                  }}
                  onStopReverseTunnel={(tunnelId) => {
                    void stopReverseSshTunnel(tunnelId);
                  }}
                  onError={showErrorNotification}
                />
              )}

              {activeView === "settings" && <SettingsTab />}
            </div>
          </main>
        </div>
      </div>
      <AppNotifications
        notifications={notifications}
        onClose={dismissNotification}
      />
    </div>
  );
}
