import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { dirname, homeDir, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import * as echarts from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import { GridComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import {
  ChevronDown,
  ChevronUp,
  CircleHelp,
  Copy,
  KeyRound,
  Loader2,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Sliders,
  SquareTerminal,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import {
  formatDurationUnit,
  useI18n,
  useT,
  type InterfaceLanguage,
  type TranslationKey,
} from "../../../lib/i18n";
import type {
  LocalTunnelSettings,
  ReverseTunnelSettings,
  ServerSessionSettings,
} from "../../../lib/store";
import {
  generateSshKey,
  isLocalSshUnavailableMessage,
  messageFromError,
  openLocalSshSettings,
  openServerKeyInstallTerminal,
  openServerTerminal,
  readSshPublicKey,
  terminalFallbackCommandFromError,
  type DesktopPlatform,
  testServerConnection,
  type SshKeyInfo,
  type SshConnectionTestResult,
  type ServerSessionStatus,
  type VdsHealthSample,
  type VdsHealthStatus,
  type VdsSystemStatus,
} from "../../../lib/serverSessionClient";

type NumericServerSessionField = "sshPort";

echarts.use([GridComponent, LineChart, BarChart, CanvasRenderer]);

const CONTROL_STYLE = {
  minHeight: 38,
  height: 38,
  padding: "0 10px",
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "var(--control-bg)",
  color: "var(--text-hi)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)",
} as const;
const CHART_AXIS_FONT_SIZE = 11;
const CHART_VALUE_FONT_SIZE = 12;

function asPort(value: string): number {
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
}

function buildInstallPublicKeyCommand(publicKey: string): string {
  const escapedPublicKey = publicKey.split("'").join("'\\''");

  return [
    "mkdir -p ~/.ssh",
    `echo '${escapedPublicKey}' >> ~/.ssh/authorized_keys`,
    "chmod 700 ~/.ssh",
    "chmod 600 ~/.ssh/authorized_keys",
  ].join("\n");
}

function isSshKeyRejectedMessage(message: string): boolean {
  const normalized = message.toLocaleLowerCase();

  return (
    normalized.includes("ssh ключ не принят") ||
    (normalized.includes("permission denied") &&
      normalized.includes("publickey"))
  );
}

async function resolveIdentityFileDialogPath(
  currentPath: string,
): Promise<string> {
  const homePath = await homeDir();
  const trimmedPath = currentPath.trim();

  if (!trimmedPath) {
    return await join(homePath, ".ssh");
  }

  const expandedPath =
    trimmedPath === "~"
      ? homePath
      : trimmedPath.startsWith("~/") || trimmedPath.startsWith("~\\")
        ? await join(homePath, trimmedPath.slice(2))
        : trimmedPath;

  try {
    return await dirname(expandedPath);
  } catch {
    return await join(homePath, ".ssh");
  }
}

function PathPickerField({
  label,
  value,
  placeholder,
  chooseLabel,
  createLabel,
  onChoose,
  onCreate,
}: {
  label: string;
  value: string;
  placeholder: string;
  chooseLabel: string;
  createLabel: string;
  onChoose: () => void;
  onCreate: () => void;
}): ReactElement {
  return (
    <label className="server-session-field server-session-field-wide">
      <span>{label}</span>
      <div className="server-session-key-picker">
        <input
          className="input"
          type="text"
          readOnly
          value={value}
          placeholder={placeholder}
          style={CONTROL_STYLE}
        />
        <button type="button" className="btn" onClick={onChoose}>
          {chooseLabel}
        </button>
        <button type="button" className="btn" onClick={onCreate}>
          {createLabel}
        </button>
      </div>
    </label>
  );
}

function Field({
  label,
  value,
  placeholder,
  type = "text",
  className = "",
  onChange,
}: {
  label: string;
  value: string | number;
  placeholder?: string;
  type?: "text" | "number";
  className?: string;
  onChange: (value: string) => void;
}): ReactElement {
  return (
    <label className={`server-session-field ${className}`}>
      <span>{label}</span>
      <input
        className="input"
        type={type}
        inputMode={type === "number" ? "numeric" : undefined}
        min={type === "number" ? 1 : undefined}
        max={type === "number" ? 65535 : undefined}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.currentTarget.value)}
        style={CONTROL_STYLE}
      />
    </label>
  );
}

function makeTunnelId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back to a selectable textarea for older or restricted WebViews.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.inset = "0 auto auto 0";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    if (!document.execCommand("copy")) {
      throw new Error("Copy command failed");
    }
  } finally {
    textarea.remove();
  }
}

function TunnelStatusBadge({
  status,
}: {
  status: ServerSessionStatus;
}): ReactElement {
  const t = useT();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const visualStatus = status.status;
  const statusLabel =
    visualStatus === "connected"
      ? t("session.tunnelStatusConnected")
      : visualStatus === "degraded"
        ? t("session.tunnelStatusDegraded")
        : visualStatus === "error"
        ? t("session.tunnelStatusError")
        : t("session.tunnelStatusStopped");
  const errorMessage = status.errorMessage?.trim() ?? "";
  const hasDetails = errorMessage.length > 0;

  useEffect(() => {
    if (!hasDetails) {
      setDetailsOpen(false);
      setCopied(false);
    }
  }, [hasDetails]);

  useEffect(() => {
    setCopied(false);
  }, [errorMessage]);

  useEffect(() => {
    if (!detailsOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setDetailsOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setDetailsOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [detailsOpen]);

  return (
    <span
      className="server-session-tunnel-status-wrap"
      ref={rootRef}
      onClick={(event) => event.stopPropagation()}
    >
      <span
        className={`server-session-tunnel-status is-${visualStatus}`}
        title={hasDetails ? undefined : statusLabel}
        aria-label={statusLabel}
      >
        <span aria-hidden="true" />
        <span>{statusLabel}</span>
      </span>
      {hasDetails && (
        <>
          <button
            type="button"
            className="server-session-tunnel-status-help"
            title={t("session.tunnelStatusDetails")}
            aria-label={t("session.tunnelStatusDetails")}
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((open) => !open)}
          >
            <CircleHelp size={12} strokeWidth={2.2} aria-hidden="true" />
          </button>
          {detailsOpen && (
            <span
              className="server-session-tunnel-status-popover"
              role="dialog"
              aria-label={t("session.tunnelStatusDetails")}
            >
              <span className="server-session-tunnel-status-popover-title">
                {t("session.tunnelStatusDetails")}
              </span>
              <span className="server-session-tunnel-status-message">
                {errorMessage}
              </span>
              <button
                type="button"
                className="btn server-session-tunnel-status-copy"
                onClick={() => {
                  void copyTextToClipboard(errorMessage)
                    .then(() => {
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1200);
                    })
                    .catch(() => undefined);
                }}
              >
                <Copy size={12} strokeWidth={2} aria-hidden="true" />
                <span>{copied ? t("session.copied") : t("session.copy")}</span>
              </button>
            </span>
          )}
        </>
      )}
    </span>
  );
}

function TunnelTextInput({
  label,
  value,
  placeholder,
  disabled = false,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}): ReactElement {
  return (
    <label className="server-session-tunnel-field">
      <span>{label}</span>
      <input
        className="input"
        type="text"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value)}
        style={CONTROL_STYLE}
      />
    </label>
  );
}

function TunnelPortInput({
  label,
  value,
  disabled = false,
  onChange,
}: {
  label: string;
  value: number;
  disabled?: boolean;
  onChange: (value: string) => void;
}): ReactElement {
  return (
    <label className="server-session-tunnel-field">
      <span>{label}</span>
      <input
        className="input"
        type="number"
        inputMode="numeric"
        min={1}
        max={65535}
        value={value || ""}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value)}
        style={CONTROL_STYLE}
      />
    </label>
  );
}

function TunnelActionButton({
  connected,
  busy,
  ready,
  onStart,
  onStop,
}: {
  connected: boolean;
  busy: boolean;
  ready: boolean;
  onStart: () => void;
  onStop: () => void;
}): ReactElement {
  const t = useT();

  return (
    <button
      type="button"
      className={`btn server-session-tunnel-action ${
        connected ? "btn-connector-danger" : "btn-connector-primary"
      }`}
      disabled={busy || (!connected && !ready)}
      onClick={connected ? onStop : onStart}
    >
      {busy ? (
        <Loader2 className="loading-soft-icon" size={14} />
      ) : connected ? (
        <PowerOff size={14} strokeWidth={2.1} />
      ) : (
        <Power size={14} strokeWidth={2.1} />
      )}
      <span>
        {connected ? t("session.stopTunnel") : t("session.startTunnel")}
      </span>
    </button>
  );
}

function emptyStatus(): ServerSessionStatus {
  return { status: "stopped" };
}

function formatBytes(
  value: number | null | undefined,
  language: InterfaceLanguage,
): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }

  const units =
    language === "ru"
      ? ["Б", "КБ", "МБ", "ГБ", "ТБ"]
      : ["B", "KB", "MB", "GB", "TB"];
  let normalized = value;
  let unitIndex = 0;

  while (normalized >= 1024 && unitIndex < units.length - 1) {
    normalized /= 1024;
    unitIndex += 1;
  }

  const maximumFractionDigits = normalized >= 10 || unitIndex === 0 ? 0 : 1;

  return `${new Intl.NumberFormat(language, {
    maximumFractionDigits,
  }).format(normalized)} ${units[unitIndex]}`;
}

function formatPercent(
  used: number | null | undefined,
  total: number | null | undefined,
): string | null {
  if (
    typeof used !== "number" ||
    typeof total !== "number" ||
    !Number.isFinite(used) ||
    !Number.isFinite(total) ||
    total <= 0
  ) {
    return null;
  }

  return `${Math.round((used / total) * 100)}%`;
}

function ratioPercent(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`
    : "—";
}

function formatUsedTotal(
  used: number | null | undefined,
  total: number | null | undefined,
  language: InterfaceLanguage,
): string {
  const usedText = formatBytes(used, language);
  const totalText = formatBytes(total, language);
  const percentText = formatPercent(used, total);

  if (usedText && totalText && percentText) {
    return `${usedText} / ${totalText} (${percentText})`;
  }

  if (usedText && totalText) {
    return `${usedText} / ${totalText}`;
  }

  return "—";
}

function formatLoad(status: VdsHealthStatus | null): string {
  const load = status?.metrics?.loadAverage;
  const cores = status?.metrics?.cpuCores;

  if (typeof load !== "number" || !Number.isFinite(load)) {
    return "—";
  }

  const loadText = load.toFixed(2);
  return typeof cores === "number" && cores > 0
    ? `${loadText} / ${cores}`
    : loadText;
}

function loadRatioFromStatus(status: VdsHealthStatus | null): number | null {
  const load = status?.metrics?.loadAverage;
  const cores = status?.metrics?.cpuCores;

  if (typeof load !== "number" || !Number.isFinite(load)) {
    return null;
  }

  return typeof cores === "number" && cores > 0
    ? Math.max(0, Math.min(1, load / cores))
    : Math.max(0, Math.min(1, load));
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

function formatCheckedAt(
  value: string | null | undefined,
  language: InterfaceLanguage,
): string | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toLocaleTimeString(language, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

type UptimeUnit = Parameters<typeof formatDurationUnit>[1];

const UPTIME_UNIT_ALIASES: Record<string, UptimeUnit> = {
  y: "year",
  yr: "year",
  yrs: "year",
  year: "year",
  years: "year",
  month: "month",
  months: "month",
  w: "week",
  week: "week",
  weeks: "week",
  d: "day",
  day: "day",
  days: "day",
  h: "hour",
  hr: "hour",
  hrs: "hour",
  hour: "hour",
  hours: "hour",
  m: "minute",
  min: "minute",
  mins: "minute",
  minute: "minute",
  minutes: "minute",
};

function formatRemoteUptime(
  value: string | null | undefined,
  language: InterfaceLanguage,
): string {
  const normalized = value?.trim().replace(/^up\s+/i, "") ?? "";

  if (!normalized) {
    return "—";
  }

  const parts = Array.from(
    normalized.matchAll(/(\d+)\s*([a-z]+)/gi),
    (match) => {
      const amount = Number.parseInt(match[1], 10);
      const unit = UPTIME_UNIT_ALIASES[match[2].toLowerCase()];

      return Number.isFinite(amount) && amount >= 0 && unit
        ? { amount, unit }
        : null;
    },
  ).filter((part): part is { amount: number; unit: UptimeUnit } =>
    Boolean(part),
  );

  if (parts.length === 0) {
    return normalized;
  }

  return parts
    .map((part) => formatDurationUnit(language, part.unit, part.amount))
    .join(" ");
}

function formatVdsLocation(status: VdsHealthStatus | null): string {
  const country = status?.location?.country?.trim();
  const city = status?.location?.city?.trim();
  const parts = [country, city].filter(
    (part): part is string => Boolean(part),
  );

  return parts.length > 0 ? parts.join(", ") : "—";
}

function healthStatusLabelKey(
  status: VdsHealthStatus | null,
  connectionReady: boolean,
): TranslationKey {
  if (!connectionReady) {
    return "session.healthStatusIdle";
  }

  if (!status) {
    return "session.healthStatusChecking";
  }

  if (status.status === "ok") {
    return "session.healthStatusOk";
  }

  return "session.healthStatusError";
}

type ChartPalette = {
  textHi: string;
  textLow: string;
  borderStrong: string;
  controlTrack: string;
};

function readChartPalette(host: HTMLElement): ChartPalette {
  const computedStyle = window.getComputedStyle(host);

  return {
    textHi: computedStyle.getPropertyValue("--text-hi").trim() || "#111111",
    textLow: computedStyle.getPropertyValue("--text-low").trim() || "#666666",
    borderStrong:
      computedStyle.getPropertyValue("--border-strong").trim() || "#999999",
    controlTrack:
      computedStyle.getPropertyValue("--control-track").trim() || "#e5e5e5",
  };
}

function EChartsHealthChart({
  className,
  buildOption,
}: {
  className: string;
  buildOption: (palette: ChartPalette) => echarts.EChartsCoreOption;
}): ReactElement {
  const chartHostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    const chartHost = chartHostRef.current;

    if (!chartHost) {
      return;
    }

    const chart = echarts.init(chartHost, undefined, {
      renderer: "canvas",
    });
    const resizeObserver = new ResizeObserver(() => chart.resize());

    chartRef.current = chart;
    resizeObserver.observe(chartHost);

    return () => {
      resizeObserver.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const chartHost = chartHostRef.current;

    if (!chart || !chartHost) {
      return;
    }

    chart.setOption(buildOption(readChartPalette(chartHost)), true);
  }, [buildOption]);

  return (
    <div
      ref={chartHostRef}
      className={className}
      aria-hidden="true"
    />
  );
}

function sampleRatio(
  sample: VdsHealthSample,
  value: (sample: VdsHealthSample) => number | null,
): number | null {
  const item = value(sample);

  return typeof item === "number" && Number.isFinite(item)
    ? Math.max(0, Math.min(1, item))
    : null;
}

function LoadHistoryChart({
  samples,
}: {
  samples: VdsHealthSample[];
}): ReactElement {
  const values = useMemo(() => {
    const items = samples
      .map((sample) =>
        sampleRatio(sample, (item) => {
          if (typeof item.loadAverage !== "number") {
            return null;
          }

          return typeof item.cpuCores === "number" && item.cpuCores > 0
            ? item.loadAverage / item.cpuCores
            : item.loadAverage;
        }),
      )
      .filter((item): item is number => item !== null)
      .slice(-24)
      .map((item) => Math.round(item * 100));

    return items.length === 1 ? [items[0], items[0]] : items;
  }, [samples]);
  const buildOption = useMemo(
    () => (palette: ChartPalette): echarts.EChartsCoreOption => ({
      animation: false,
      backgroundColor: "transparent",
      grid: {
        top: 8,
        right: 20,
        bottom: 18,
        left: 28,
      },
      xAxis: {
        type: "category",
        boundaryGap: false,
        data: values.map((_, index) => index.toString()),
        axisLabel: { show: false },
        axisTick: { show: false },
        axisLine: { show: false },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        min: 0,
        max: 100,
        interval: 50,
        axisLabel: {
          color: palette.textLow,
          fontSize: CHART_AXIS_FONT_SIZE,
          formatter: "{value}%",
        },
        axisTick: { show: false },
        axisLine: { show: false },
        splitLine: {
          lineStyle: {
            color: palette.borderStrong,
            opacity: 0.22,
          },
        },
      },
      series: [
        {
          type: "line",
          data: values,
          smooth: true,
          symbol: "none",
          lineStyle: {
            width: 2,
            color: palette.textHi,
          },
          areaStyle: {
            color: palette.textHi,
            opacity: 0.12,
          },
        },
      ],
    }),
    [values],
  );

  return (
    <EChartsHealthChart
      className="vds-health-line-chart"
      buildOption={buildOption}
    />
  );
}

function HorizontalUsageChart({
  ratio,
}: {
  ratio: number | null;
}): ReactElement {
  const value =
    typeof ratio === "number" && Number.isFinite(ratio)
      ? Math.round(Math.max(0, Math.min(1, ratio)) * 100)
      : 0;
  const buildOption = useMemo(
    () => (palette: ChartPalette): echarts.EChartsCoreOption => ({
      animation: false,
      backgroundColor: "transparent",
      grid: {
        top: 8,
        right: 8,
        bottom: 8,
        left: 8,
        containLabel: false,
      },
      xAxis: {
        type: "value",
        min: 0,
        max: 100,
        show: false,
      },
      yAxis: {
        type: "category",
        data: [""],
        show: false,
      },
      series: [
        {
          type: "bar",
          data: [value],
          barWidth: 18,
          showBackground: true,
          backgroundStyle: {
            color: palette.controlTrack,
            borderRadius: 5,
          },
          itemStyle: {
            color: palette.textHi,
            borderRadius: 5,
          },
          label: {
            show: true,
            position: "insideRight",
            color: palette.textHi,
            fontSize: CHART_VALUE_FONT_SIZE,
            fontWeight: 700,
            formatter: `${value}%`,
          },
        },
      ],
    }),
    [value],
  );

  return (
    <EChartsHealthChart
      className="vds-health-usage-chart"
      buildOption={buildOption}
    />
  );
}

function CpuChartCard({
  label,
  value,
  ratio,
  samples,
}: {
  label: string;
  value: string;
  ratio: number | null;
  samples: VdsHealthSample[];
}): ReactElement {
  return (
    <div className="vds-health-chart-card is-cpu">
      <div className="vds-health-monitor-top">
        <span>{label}</span>
        <strong>
          {value === "—" ? value : `${value} (${ratioPercent(ratio)})`}
        </strong>
      </div>
      <LoadHistoryChart samples={samples} />
    </div>
  );
}

function UsageChartCard({
  label,
  value,
  ratio,
}: {
  label: string;
  value: string;
  ratio: number | null;
}): ReactElement {
  return (
    <div className="vds-health-chart-card is-usage">
      <div className="vds-health-monitor-top">
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
      <HorizontalUsageChart ratio={ratio} />
    </div>
  );
}

function HealthHeatmap({ samples }: { samples: VdsHealthSample[] }): ReactElement {
  const { language, t } = useI18n();
  const samplesByCell = samples.slice(-360);
  const cells = Array.from(
    { length: 360 },
    (_, index) => samplesByCell[index] ?? null,
  );

  return (
    <div className="vds-health-heatmap">
      <div className="vds-health-heatmap-head">
        <span>{t("session.healthTimeline")}</span>
      </div>
      <div className="vds-health-heatmap-grid">
        {cells.map((sample, index) => {
          const checkedAt = formatCheckedAt(sample?.checkedAt, language);
          const ok = sample ? sample.status !== "error" : false;

          return (
            <span
              key={`${sample?.checkedAt ?? "empty"}-${index}`}
              className={
                sample ? (ok ? "is-ok" : "is-error") : "is-unknown"
              }
              title={
                sample
                  ? `${checkedAt ?? sample.checkedAt} · ${
                      ok
                        ? t("session.healthStatusOk")
                        : t("session.healthStatusError")
                    }`
                  : t("session.healthStatusIdle")
              }
              aria-label={
                sample
                  ? ok
                    ? t("session.healthStatusOk")
                    : t("session.healthStatusError")
                  : t("session.healthStatusIdle")
              }
            />
          );
        })}
      </div>
    </div>
  );
}

function VdsHealthBlock({
  status,
  history,
  loading,
  connectionReady,
  onRefresh,
}: {
  status: VdsHealthStatus | null;
  history: VdsHealthSample[];
  loading: boolean;
  connectionReady: boolean;
  onRefresh: () => void;
}): ReactElement {
  const { language, t } = useI18n();
  const checkedAt = formatCheckedAt(status?.checkedAt, language);
  const visualStatus = !connectionReady
    ? "idle"
    : (status?.status ?? "degraded");
  const message = !connectionReady
    ? t("session.healthNotConfigured")
    : status?.message;
  const loadRatio = loadRatioFromStatus(status);
  const memoryRatio = metricRatio(
    status?.metrics?.memoryUsedBytes,
    status?.metrics?.memoryTotalBytes,
  );
  const diskRatio = metricRatio(
    status?.metrics?.diskUsedBytes,
    status?.metrics?.diskTotalBytes,
  );

  return (
    <div className={`vds-health-panel is-${visualStatus}`}>
      <div className="vds-health-head">
        <div className="vds-health-title">
          <span className="vds-health-dot" aria-hidden="true" />
          <strong>{t(healthStatusLabelKey(status, connectionReady))}</strong>
        </div>
        <div className="vds-health-actions">
          {checkedAt && (
            <span className="vds-health-checked">
              {t("session.healthLastUpdated")} {checkedAt}
            </span>
          )}
          <button
            type="button"
            className="btn vds-health-refresh"
            disabled={!connectionReady || loading}
            title={t("session.healthRefresh")}
            aria-label={t("session.healthRefresh")}
            onClick={onRefresh}
          >
            {loading ? (
              <Loader2 className="loading-soft-icon" size={13} />
            ) : (
              <RefreshCw size={13} strokeWidth={2} aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {loading && !status ? (
        <div
          className="vds-health-skeleton"
          aria-label={t("session.healthLoading")}
        >
          <span />
          <span />
          <span />
        </div>
      ) : (
        <>
          {message && (
            <div
              className={`proxy-inline-warning ${
                status?.status === "error" || !connectionReady ? "is-error" : ""
              }`}
              role="status"
            >
              <span>{message}</span>
            </div>
          )}
          <HealthHeatmap samples={history} />
          <div className="vds-health-charts-grid">
            <CpuChartCard
              label={t("session.healthCpuLoad")}
              value={formatLoad(status)}
              ratio={loadRatio}
              samples={history}
            />
            <UsageChartCard
              label={t("session.healthRam")}
              value={formatUsedTotal(
                status?.metrics?.memoryUsedBytes,
                status?.metrics?.memoryTotalBytes,
                language,
              )}
              ratio={memoryRatio}
            />
            <UsageChartCard
              label={t("session.healthDisk")}
              value={formatUsedTotal(
                status?.metrics?.diskUsedBytes,
                status?.metrics?.diskTotalBytes,
                language,
              )}
              ratio={diskRatio}
            />
          </div>
          <div className="vds-health-meta-row">
            <p className="vds-health-uptime-text">
              <span>{t("session.healthUptime")}</span>
              <strong>
                {formatRemoteUptime(status?.metrics?.uptime, language)}
              </strong>
            </p>
            <p
              className="vds-health-uptime-text is-location"
              title={status?.location?.ip ?? undefined}
            >
              <span>{t("session.healthLocation")}</span>
              <strong>{formatVdsLocation(status)}</strong>
            </p>
          </div>
        </>
      )}
    </div>
  );
}

function isEmptyVdsConfig(config: ServerSessionSettings): boolean {
  return (
    !config.host.trim() &&
    !config.username.trim() &&
    !config.identityFile.trim() &&
    (config.sshPort === 0 || config.sshPort === 22)
  );
}

function makeVdsConfigTestIdentity(
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

function normalizePlatform(
  platform: DesktopPlatform | undefined,
): DesktopPlatform {
  return platform ?? "unknown";
}

function localSshInstructionsKey(
  status: VdsSystemStatus | null,
): TranslationKey {
  const key = status?.localSsh.instructionsKey;

  if (key === "session.localSshInstructions.macos") {
    return key;
  }

  if (key === "session.localSshInstructions.windows") {
    return key;
  }

  if (key === "session.localSshInstructions.linux") {
    return key;
  }

  return "session.localSshInstructions.unknown";
}

function localSshActionLabelKey(
  status: VdsSystemStatus | null,
): TranslationKey {
  return status?.platform === "linux"
    ? "session.openLocalSshInstructions"
    : "session.openLocalSshSettings";
}

function missingSshKey(platform: DesktopPlatform | undefined): TranslationKey {
  const normalized = normalizePlatform(platform);

  if (normalized === "macos") {
    return "session.systemToolMissingSsh.macos";
  }

  if (normalized === "windows") {
    return "session.systemToolMissingSsh.windows";
  }

  if (normalized === "linux") {
    return "session.systemToolMissingSsh.linux";
  }

  return "session.systemToolMissingSsh.unknown";
}

function missingSshKeygenKey(
  platform: DesktopPlatform | undefined,
): TranslationKey {
  const normalized = normalizePlatform(platform);

  if (normalized === "macos") {
    return "session.systemToolMissingSshKeygen.macos";
  }

  if (normalized === "windows") {
    return "session.systemToolMissingSshKeygen.windows";
  }

  if (normalized === "linux") {
    return "session.systemToolMissingSshKeygen.linux";
  }

  return "session.systemToolMissingSshKeygen.unknown";
}

function CommandBox({
  title,
  command,
  showHeader = true,
  onRun,
}: {
  title: string;
  command: string;
  showHeader?: boolean;
  onRun?: () => Promise<void>;
}): ReactElement {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [running, setRunning] = useState(false);

  const runCommand = async (): Promise<void> => {
    if (!onRun || running) {
      return;
    }

    setRunning(true);

    try {
      await onRun();
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="server-session-command">
      {showHeader && (
        <div className="server-session-command-head">
          <span>{title}</span>
          <button
            type="button"
            className="btn"
            onClick={() => {
              void navigator.clipboard.writeText(command).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
              });
            }}
          >
            <Copy size={13} strokeWidth={2} aria-hidden="true" />
            <span>{copied ? t("session.copied") : t("session.copy")}</span>
          </button>
        </div>
      )}
      <pre>{command}</pre>
      {onRun && (
        <button
          type="button"
          className="btn server-session-run-button"
          disabled={running}
          onClick={() => {
            void runCommand();
          }}
        >
          {running ? (
            <Loader2 className="loading-soft-icon" size={14} />
          ) : (
            <SquareTerminal size={14} strokeWidth={2} />
          )}
          <span>{t("session.runCommand")}</span>
        </button>
      )}
    </div>
  );
}

export function ProxyTab({
  profileId,
  config,
  settingsReady,
  localTunnelStatuses,
  reverseTunnelStatuses,
  localTunnelBusyId,
  reverseTunnelBusyId,
  vdsSystemStatus,
  vdsHealthStatus,
  vdsHealthHistory,
  vdsHealthLoading,
  vdsConnectionReady,
  onRefreshVdsHealth,
  onConfigChange,
  onStartLocalTunnel,
  onStopLocalTunnel,
  onStartReverseTunnel,
  onStopReverseTunnel,
  onError,
}: {
  profileId: string;
  config: ServerSessionSettings;
  settingsReady: boolean;
  localTunnelStatuses: Record<string, ServerSessionStatus>;
  reverseTunnelStatuses: Record<string, ServerSessionStatus>;
  localTunnelBusyId: string | null;
  reverseTunnelBusyId: string | null;
  vdsSystemStatus: VdsSystemStatus | null;
  vdsHealthStatus: VdsHealthStatus | null;
  vdsHealthHistory: VdsHealthSample[];
  vdsHealthLoading: boolean;
  vdsConnectionReady: boolean;
  onRefreshVdsHealth: () => void;
  onConfigChange: (patch: Partial<ServerSessionSettings>) => void;
  onStartLocalTunnel: (tunnel: LocalTunnelSettings) => void;
  onStopLocalTunnel: (tunnelId: string) => void;
  onStartReverseTunnel: (tunnel: ReverseTunnelSettings) => void;
  onStopReverseTunnel: (tunnelId: string) => void;
  onError?: (message: string) => void;
}): ReactElement {
  const t = useT();
  const [sshKeyInfo, setSshKeyInfo] = useState<SshKeyInfo | null>(null);
  const [sshKeyError, setSshKeyError] = useState<string | null>(null);
  const [showVdsCommand, setShowVdsCommand] = useState(false);
  const [vdsConfigExpanded, setVdsConfigExpanded] = useState(false);
  const [sshKeyExpanded, setSshKeyExpanded] = useState(true);
  const [testBusy, setTestBusy] = useState(false);
  const [openServerBusy, setOpenServerBusy] = useState(false);
  const [remoteLoginSettingsBusy, setRemoteLoginSettingsBusy] = useState(false);
  const [terminalFallbackCommand, setTerminalFallbackCommand] = useState<
    string | null
  >(null);
  const [testResult, setTestResult] = useState<SshConnectionTestResult | null>(
    null,
  );
  const testedVdsConfigIdentities = useRef<Set<string>>(new Set());
  const autoExpandedProfileId = useRef<string | null>(null);
  const previousVdsConfigTestIdentity = useRef<string | null>(null);
  const retestVdsOnFocusRef = useRef(false);
  const retestVdsOnFocusTimeoutRef = useRef<number | null>(null);
  const testConnectionRef = useRef<(() => Promise<void>) | null>(null);

  const showError = (message: string): void => {
    const normalizedMessage = message.trim();

    if (!normalizedMessage) {
      return;
    }

    onError?.(normalizedMessage);
  };
  const vdsConfigTestIdentity = useMemo(
    () => makeVdsConfigTestIdentity(profileId, config),
    [
      config.host,
      config.identityFile,
      config.sshPort,
      config.username,
      profileId,
    ],
  );
  const vdsConfigIsEmpty = useMemo(
    () => isEmptyVdsConfig(config),
    [config.host, config.identityFile, config.sshPort, config.username],
  );
  const installPublicKeyCommand = useMemo(
    () =>
      sshKeyInfo ? buildInstallPublicKeyCommand(sshKeyInfo.publicKey) : "",
    [sshKeyInfo],
  );
  const sshKeyInstallSuggested =
    Boolean(testResult) &&
    !testResult?.ok &&
    Boolean(installPublicKeyCommand) &&
    isSshKeyRejectedMessage(testResult?.message ?? "");
  const openServerActionLabel = sshKeyInstallSuggested
    ? t("session.installSshKey")
    : t("session.openServerTerminal");
  const sshUnavailableMessage =
    vdsSystemStatus?.tools.sshAvailable === false
      ? t(missingSshKey(vdsSystemStatus.platform))
      : null;
  const sshKeygenUnavailableMessage =
    vdsSystemStatus?.tools.sshKeygenAvailable === false
      ? t(missingSshKeygenKey(vdsSystemStatus.platform))
      : null;

  const messageFromActionError = (error: unknown): string => {
    const fallbackCommand = terminalFallbackCommandFromError(error);

    if (fallbackCommand) {
      setTerminalFallbackCommand(fallbackCommand);
      return t("session.terminalNotFound");
    }

    return messageFromError(error);
  };

  const updateString = (
    field: keyof ServerSessionSettings,
    value: string,
  ): void => {
    onConfigChange({ [field]: value } as Partial<ServerSessionSettings>);
  };

  const updatePort = (
    field: NumericServerSessionField,
    value: string,
  ): void => {
    onConfigChange({
      [field]: asPort(value),
    } as Partial<ServerSessionSettings>);
  };

  const updateLocalTunnels = (localTunnels: LocalTunnelSettings[]): void => {
    onConfigChange({ localTunnels });
  };

  const updateReverseTunnels = (
    reverseTunnels: ReverseTunnelSettings[],
  ): void => {
    const firstTunnel = reverseTunnels[0];

    onConfigChange({
      reverseTunnels,
      remoteTunnelPort: firstTunnel?.remotePort ?? config.remoteTunnelPort,
      localSshPort: firstTunnel?.localPort ?? config.localSshPort,
    });
  };

  const patchLocalTunnel = (
    tunnelId: string,
    patch: Partial<LocalTunnelSettings>,
  ): void => {
    updateLocalTunnels(
      config.localTunnels.map((tunnel) =>
        tunnel.id === tunnelId ? { ...tunnel, ...patch } : tunnel,
      ),
    );
  };

  const patchReverseTunnel = (
    tunnelId: string,
    patch: Partial<ReverseTunnelSettings>,
  ): void => {
    updateReverseTunnels(
      config.reverseTunnels.map((tunnel) =>
        tunnel.id === tunnelId ? { ...tunnel, ...patch } : tunnel,
      ),
    );
  };

  const addLocalTunnel = (): void => {
    updateLocalTunnels([
      ...config.localTunnels,
      {
        id: makeTunnelId("local"),
        label: "",
        localPort: 0,
        remotePort: 0,
      },
    ]);
  };

  const addReverseTunnel = (): void => {
    updateReverseTunnels([
      ...config.reverseTunnels,
      {
        id: makeTunnelId("reverse"),
        label: "",
        remotePort: 0,
        localPort: 0,
      },
    ]);
  };

  const serverTerminalReady = Boolean(
    config.host.trim() && config.username.trim() && config.sshPort > 0,
  );

  useEffect(() => {
    if (!settingsReady || autoExpandedProfileId.current === profileId) {
      return;
    }

    autoExpandedProfileId.current = profileId;
    setVdsConfigExpanded(
      vdsConfigIsEmpty &&
        !testedVdsConfigIdentities.current.has(vdsConfigTestIdentity),
    );
  }, [profileId, settingsReady, vdsConfigIsEmpty, vdsConfigTestIdentity]);

  useEffect(() => {
    if (previousVdsConfigTestIdentity.current === null) {
      previousVdsConfigTestIdentity.current = vdsConfigTestIdentity;
      return;
    }

    if (previousVdsConfigTestIdentity.current !== vdsConfigTestIdentity) {
      previousVdsConfigTestIdentity.current = vdsConfigTestIdentity;
      retestVdsOnFocusRef.current = false;
      if (retestVdsOnFocusTimeoutRef.current !== null) {
        window.clearTimeout(retestVdsOnFocusTimeoutRef.current);
        retestVdsOnFocusTimeoutRef.current = null;
      }
      setTestResult(null);
    }
  }, [vdsConfigTestIdentity]);

  useEffect(() => {
    const identityFile = config.identityFile.trim();
    let cancelled = false;

    if (!identityFile) {
      setSshKeyInfo(null);
      return () => {
        cancelled = true;
      };
    }

    void readSshPublicKey(identityFile)
      .then((keyInfo) => {
        if (cancelled) {
          return;
        }

        setSshKeyInfo(keyInfo);
        setShowVdsCommand(true);
      })
      .catch(() => {
        if (!cancelled) {
          setSshKeyInfo(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [config.identityFile]);

  const chooseIdentityFile = async (): Promise<void> => {
    const defaultPath = await resolveIdentityFileDialogPath(
      config.identityFile,
    );
    const selected = await open({
      directory: false,
      multiple: false,
      defaultPath,
      title: t("session.chooseIdentityFile"),
    });

    if (typeof selected !== "string") {
      return;
    }

    updateString("identityFile", selected);
    setSshKeyError(null);

    try {
      setSshKeyInfo(await readSshPublicKey(selected));
      setShowVdsCommand(true);
      setSshKeyExpanded(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSshKeyInfo(null);
      setSshKeyError(message);
      showError(message);
    }
  };

  const createIdentityFile = async (): Promise<void> => {
    setSshKeyError(null);
    setTerminalFallbackCommand(null);

    if (sshKeygenUnavailableMessage) {
      setSshKeyInfo(null);
      setSshKeyError(sshKeygenUnavailableMessage);
      showError(sshKeygenUnavailableMessage);
      return;
    }

    try {
      const keyInfo = await generateSshKey();
      setSshKeyInfo(keyInfo);
      setShowVdsCommand(true);
      setSshKeyExpanded(false);
      updateString("identityFile", keyInfo.privateKeyPath);
    } catch (error) {
      const message = messageFromActionError(error);
      setSshKeyInfo(null);
      setSshKeyError(message);
      showError(message);
    }
  };

  const testConnection = async (): Promise<void> => {
    const testedIdentity = vdsConfigTestIdentity;

    setTestBusy(true);
    setTestResult(null);
    setTerminalFallbackCommand(null);

    try {
      if (sshUnavailableMessage) {
        showError(sshUnavailableMessage);
        setTestResult({
          ok: false,
          message: sshUnavailableMessage,
        });
        return;
      }

      const result = await testServerConnection(config);
      setTestResult(result);

      if (!result.ok && isSshKeyRejectedMessage(result.message) && sshKeyInfo) {
        setShowVdsCommand(true);
        setSshKeyExpanded(true);
      }

      if (!result.ok) {
        showError(result.message);
      }
    } catch (error) {
      const message = messageFromActionError(error);
      setTestResult({
        ok: false,
        message,
      });
      showError(message);
    } finally {
      testedVdsConfigIdentities.current.add(testedIdentity);
      setTestBusy(false);
    }
  };
  testConnectionRef.current = testConnection;

  useEffect(() => {
    return () => {
      if (retestVdsOnFocusTimeoutRef.current !== null) {
        window.clearTimeout(retestVdsOnFocusTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const retestOnFocus = (): void => {
      if (!retestVdsOnFocusRef.current || testBusy) {
        return;
      }

      retestVdsOnFocusRef.current = false;
      if (retestVdsOnFocusTimeoutRef.current !== null) {
        window.clearTimeout(retestVdsOnFocusTimeoutRef.current);
      }

      retestVdsOnFocusTimeoutRef.current = window.setTimeout(() => {
        retestVdsOnFocusTimeoutRef.current = null;
        void testConnectionRef.current?.();
      }, 800);
    };

    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "visible") {
        retestOnFocus();
      }
    };

    window.addEventListener("focus", retestOnFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("focus", retestOnFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [testBusy]);

  const openKeyInstallTerminalAndRetestOnFocus = async (): Promise<void> => {
    if (!installPublicKeyCommand) {
      return;
    }

    retestVdsOnFocusRef.current = true;
    try {
      await openServerKeyInstallTerminal({
        config,
        command: installPublicKeyCommand,
      });
    } catch (error) {
      retestVdsOnFocusRef.current = false;
      throw error;
    }
  };

  const openLocalSshSettingsFromResult = async (): Promise<void> => {
    setRemoteLoginSettingsBusy(true);
    setTerminalFallbackCommand(null);

    try {
      await openLocalSshSettings();
    } catch (error) {
      const message = messageFromActionError(error);
      setTestResult({
        ok: false,
        message,
      });
      showError(message);
    } finally {
      setRemoteLoginSettingsBusy(false);
    }
  };

  const openServerSsh = async (): Promise<void> => {
    setOpenServerBusy(true);
    setTerminalFallbackCommand(null);

    try {
      if (sshUnavailableMessage) {
        showError(sshUnavailableMessage);
        setTestResult({
          ok: false,
          message: sshUnavailableMessage,
        });
        return;
      }

      if (sshKeyInstallSuggested) {
        await openKeyInstallTerminalAndRetestOnFocus();
        return;
      }

      await openServerTerminal(config);
    } catch (error) {
      const message = messageFromActionError(error);
      setTestResult({
        ok: false,
        message,
      });
      showError(message);
    } finally {
      setOpenServerBusy(false);
    }
  };

  const runCommand = async (runner: () => Promise<void>): Promise<void> => {
    setTerminalFallbackCommand(null);

    try {
      if (sshUnavailableMessage) {
        showError(sshUnavailableMessage);
        setTestResult({
          ok: false,
          message: sshUnavailableMessage,
        });
        return;
      }

      await runner();
    } catch (error) {
      const message = messageFromActionError(error);
      setTestResult({
        ok: false,
        message,
      });
      showError(message);
    }
  };

  return (
    <div className="proxy-stack">
      <article className="proxy-card">
        {(sshUnavailableMessage || sshKeygenUnavailableMessage) && (
          <div className="proxy-inline-warning is-error" role="status">
            <KeyRound size={15} strokeWidth={2} aria-hidden="true" />
            <span>
              {[sshUnavailableMessage, sshKeygenUnavailableMessage]
                .filter(Boolean)
                .join(" ")}
            </span>
          </div>
        )}

        <VdsHealthBlock
          status={vdsHealthStatus}
          history={vdsHealthHistory}
          loading={vdsHealthLoading}
          connectionReady={vdsConnectionReady}
          onRefresh={onRefreshVdsHealth}
        />

        <button
          type="button"
          className="btn server-session-config-toggle"
          aria-expanded={vdsConfigExpanded}
          aria-controls="server-session-vds-config"
          onClick={() => setVdsConfigExpanded((current) => !current)}
        >
          <span>{t("session.vdsConfig")}</span>
          {vdsConfigExpanded ? (
            <ChevronUp size={15} strokeWidth={2} aria-hidden="true" />
          ) : (
            <ChevronDown size={15} strokeWidth={2} aria-hidden="true" />
          )}
        </button>

        {vdsConfigExpanded && (
          <div
            className="server-session-config-panel"
            id="server-session-vds-config"
          >
            <div className="server-session-grid server-session-vds-grid">
              <Field
                className="server-session-field-half"
                label={t("session.host")}
                value={config.host}
                placeholder="123.123.123.123"
                onChange={(value) => updateString("host", value)}
              />
              <Field
                className="server-session-field-quarter"
                label={t("session.sshPort")}
                type="number"
                value={config.sshPort || ""}
                onChange={(value) => updatePort("sshPort", value)}
              />
              <Field
                className="server-session-field-quarter"
                label={t("session.username")}
                value={config.username}
                placeholder="root"
                onChange={(value) => updateString("username", value)}
              />
              <PathPickerField
                label={t("session.identityFile")}
                value={config.identityFile}
                placeholder="~/.ssh/id_ed25519"
                chooseLabel={t("session.choose")}
                createLabel={t("session.createKey")}
                onChoose={() => {
                  void chooseIdentityFile();
                }}
                onCreate={() => {
                  void createIdentityFile();
                }}
              />
            </div>

            {((showVdsCommand && sshKeyInfo) || sshKeyError) && (
              <div className="server-session-key-result">
                {showVdsCommand && sshKeyInfo && (
                  <>
                    <div className="server-session-command-head">
                      <span>{t("session.installPublicKeyCommand")}</span>
                      <div className="server-session-command-actions">
                        <button
                          type="button"
                          className="btn"
                          aria-label={t("session.copy")}
                          onClick={() => {
                            void navigator.clipboard.writeText(
                              installPublicKeyCommand,
                            );
                          }}
                        >
                          <Copy size={14} strokeWidth={2} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => {
                            setSshKeyExpanded((current) => !current);
                          }}
                          aria-expanded={sshKeyExpanded}
                        >
                          {sshKeyExpanded ? (
                            <ChevronUp
                              size={14}
                              strokeWidth={2}
                              aria-hidden="true"
                            />
                          ) : (
                            <ChevronDown
                              size={14}
                              strokeWidth={2}
                              aria-hidden="true"
                            />
                          )}
                        </button>
                      </div>
                    </div>
                    {sshKeyExpanded && (
                      <CommandBox
                        title={t("session.installPublicKeyCommand")}
                        command={installPublicKeyCommand}
                        showHeader={false}
                        onRun={() =>
                          runCommand(openKeyInstallTerminalAndRetestOnFocus)
                        }
                      />
                    )}
                  </>
                )}

                {sshKeyError && (
                  <div className="proxy-inline-warning is-error">
                    <KeyRound size={15} strokeWidth={2} aria-hidden="true" />
                    <span>{sshKeyError}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div className="server-session-tail-actions">
          <button
            type="button"
            className="btn"
            disabled={testBusy}
            onClick={() => {
              void testConnection();
            }}
          >
            {testBusy ? (
              <Loader2 className="loading-soft-icon" size={15} />
            ) : (
              <KeyRound size={15} strokeWidth={2} />
            )}
            <span>{t("session.testConnection")}</span>
          </button>
          <button
            type="button"
            className="btn"
            disabled={openServerBusy || !serverTerminalReady}
            onClick={() => {
              void openServerSsh();
            }}
          >
            {openServerBusy ? (
              <Loader2 className="loading-soft-icon" size={15} />
            ) : sshKeyInstallSuggested ? (
              <KeyRound size={15} strokeWidth={2} />
            ) : (
              <SquareTerminal size={15} strokeWidth={2} />
            )}
            <span>{openServerActionLabel}</span>
          </button>
        </div>

        {testResult && (
          <div
            className={`proxy-inline-warning server-session-result-warning ${
              testResult.ok ? "is-success" : "is-error"
            }`}
          >
            <span>{testResult.message}</span>
            {!testResult.ok &&
              isLocalSshUnavailableMessage(testResult.message) &&
              vdsSystemStatus?.localSsh.canOpenSettings && (
                <button
                  type="button"
                  className="btn server-session-inline-action"
                  disabled={remoteLoginSettingsBusy}
                  onClick={() => {
                    void openLocalSshSettingsFromResult();
                  }}
                >
                  {remoteLoginSettingsBusy ? (
                    <Loader2 className="loading-soft-icon" size={13} />
                  ) : (
                    <Sliders size={13} strokeWidth={2} />
                  )}
                  <span>{t(localSshActionLabelKey(vdsSystemStatus))}</span>
                </button>
              )}
          </div>
        )}

        {terminalFallbackCommand && (
          <CommandBox
            title={t("session.terminalFallbackCommand")}
            command={terminalFallbackCommand}
          />
        )}

        <div className="server-session-tunnel-section">
          <div className="server-session-command-head">
            <span>{t("session.vdsTunnelsTitle")}</span>
            <button type="button" className="btn" onClick={addLocalTunnel}>
              <Plus size={13} strokeWidth={2} aria-hidden="true" />
              <span>{t("session.addTunnel")}</span>
            </button>
          </div>

          <div className="server-session-tunnel-list">
            {config.localTunnels.map((tunnel) => {
              const status = localTunnelStatuses[tunnel.id] ?? emptyStatus();
              const connected =
                status.status === "connected" || status.status === "degraded";
              const busy = localTunnelBusyId === tunnel.id;
              const ready = Boolean(
                vdsConnectionReady &&
                tunnel.localPort > 0 &&
                tunnel.remotePort > 0,
              );

              return (
                <div className="server-session-tunnel-row" key={tunnel.id}>
                  <TunnelTextInput
                    label={t("session.tunnelName")}
                    value={tunnel.label}
                    placeholder="codex-lb"
                    disabled={connected || busy}
                    onChange={(value) =>
                      patchLocalTunnel(tunnel.id, { label: value })
                    }
                  />
                  <TunnelPortInput
                    label={t("session.macPort")}
                    value={tunnel.localPort}
                    disabled={connected || busy}
                    onChange={(value) =>
                      patchLocalTunnel(tunnel.id, { localPort: asPort(value) })
                    }
                  />
                  <TunnelPortInput
                    label={t("session.vdsPort")}
                    value={tunnel.remotePort}
                    disabled={connected || busy}
                    onChange={(value) =>
                      patchLocalTunnel(tunnel.id, { remotePort: asPort(value) })
                    }
                  />
                  <div className="server-session-tunnel-controls">
                    <TunnelStatusBadge status={status} />
                    <div className="server-session-tunnel-actions">
                      <TunnelActionButton
                        connected={connected}
                        busy={busy}
                        ready={ready}
                        onStart={() => onStartLocalTunnel(tunnel)}
                        onStop={() => onStopLocalTunnel(tunnel.id)}
                      />
                      <button
                        type="button"
                        className="btn server-session-tunnel-icon-action"
                        disabled={connected || busy}
                        aria-label={t("session.removeTunnel")}
                        onClick={() => {
                          updateLocalTunnels(
                            config.localTunnels.filter(
                              (item) => item.id !== tunnel.id,
                            ),
                          );
                        }}
                      >
                        <Trash2 size={13} strokeWidth={2} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {vdsSystemStatus && !vdsSystemStatus.localSsh.available && (
          <div className="proxy-inline-warning is-error" role="status">
            <TerminalSquare size={15} strokeWidth={2} aria-hidden="true" />
            <span>{t(localSshInstructionsKey(vdsSystemStatus))}</span>
            {vdsSystemStatus.localSsh.canOpenSettings && (
              <button
                type="button"
                className="btn server-session-inline-action"
                disabled={remoteLoginSettingsBusy}
                onClick={() => {
                  void openLocalSshSettingsFromResult();
                }}
              >
                {remoteLoginSettingsBusy ? (
                  <Loader2 className="loading-soft-icon" size={13} />
                ) : (
                  <Sliders size={13} strokeWidth={2} />
                )}
                <span>{t(localSshActionLabelKey(vdsSystemStatus))}</span>
              </button>
            )}
          </div>
        )}

        <div className="server-session-tunnel-section">
          <div className="server-session-command-head">
            <span>{t("session.reverseTunnelsTitle")}</span>
            <button type="button" className="btn" onClick={addReverseTunnel}>
              <Plus size={13} strokeWidth={2} aria-hidden="true" />
              <span>{t("session.addTunnel")}</span>
            </button>
          </div>

          <div className="server-session-tunnel-list">
            {config.reverseTunnels.map((tunnel) => {
              const status = reverseTunnelStatuses[tunnel.id] ?? emptyStatus();
              const connected =
                status.status === "connected" || status.status === "degraded";
              const busy = reverseTunnelBusyId === tunnel.id;
              const ready = Boolean(
                vdsConnectionReady &&
                tunnel.remotePort > 0 &&
                tunnel.localPort > 0,
              );

              return (
                <div className="server-session-tunnel-row" key={tunnel.id}>
                  <TunnelTextInput
                    label={t("session.tunnelName")}
                    value={tunnel.label}
                    placeholder="Локальный SSH"
                    disabled={connected || busy}
                    onChange={(value) =>
                      patchReverseTunnel(tunnel.id, { label: value })
                    }
                  />
                  <TunnelPortInput
                    label={t("session.vdsPort")}
                    value={tunnel.remotePort}
                    disabled={connected || busy}
                    onChange={(value) =>
                      patchReverseTunnel(tunnel.id, {
                        remotePort: asPort(value),
                      })
                    }
                  />
                  <TunnelPortInput
                    label={t("session.macPort")}
                    value={tunnel.localPort}
                    disabled={connected || busy}
                    onChange={(value) =>
                      patchReverseTunnel(tunnel.id, {
                        localPort: asPort(value),
                      })
                    }
                  />
                  <div className="server-session-tunnel-controls">
                    <TunnelStatusBadge status={status} />
                    <div className="server-session-tunnel-actions">
                      <TunnelActionButton
                        connected={connected}
                        busy={busy}
                        ready={ready}
                        onStart={() => onStartReverseTunnel(tunnel)}
                        onStop={() => onStopReverseTunnel(tunnel.id)}
                      />
                      <button
                        type="button"
                        className="btn server-session-tunnel-icon-action"
                        disabled={connected || busy}
                        aria-label={t("session.removeTunnel")}
                        onClick={() => {
                          updateReverseTunnels(
                            config.reverseTunnels.filter(
                              (item) => item.id !== tunnel.id,
                            ),
                          );
                        }}
                      >
                        <Trash2 size={13} strokeWidth={2} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </article>
    </div>
  );
}
