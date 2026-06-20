import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { getSettings, type InterfaceLanguage } from "./store";
import { SETTINGS_UPDATED_EVENT } from "./settingsEvents";

export type { InterfaceLanguage } from "./store";

export type TranslationKey = keyof (typeof translations)["ru"];

export const INTERFACE_LANGUAGES: Array<{
  id: InterfaceLanguage;
  label: string;
  nativeLabel: string;
}> = [
  { id: "ru", label: "Русский", nativeLabel: "Русский" },
  { id: "en", label: "English", nativeLabel: "English" },
];

export const DEFAULT_INTERFACE_LANGUAGE: InterfaceLanguage = "ru";

type DurationUnit = "year" | "month" | "week" | "day" | "hour" | "minute";
type DurationPluralCategory = "one" | "few" | "many" | "other";

const durationTranslations: Record<
  InterfaceLanguage,
  Record<DurationUnit, Partial<Record<DurationPluralCategory, string>>>
> = {
  ru: {
    year: {
      one: "{value} год",
      few: "{value} года",
      many: "{value} лет",
      other: "{value} года",
    },
    month: {
      one: "{value} месяц",
      few: "{value} месяца",
      many: "{value} месяцев",
      other: "{value} месяца",
    },
    week: {
      one: "{value} неделя",
      few: "{value} недели",
      many: "{value} недель",
      other: "{value} недели",
    },
    day: {
      one: "{value} день",
      few: "{value} дня",
      many: "{value} дней",
      other: "{value} дня",
    },
    hour: {
      one: "{value} час",
      few: "{value} часа",
      many: "{value} часов",
      other: "{value} часа",
    },
    minute: {
      one: "{value} минута",
      few: "{value} минуты",
      many: "{value} минут",
      other: "{value} минуты",
    },
  },
  en: {
    year: { one: "{value} year", other: "{value} years" },
    month: { one: "{value} month", other: "{value} months" },
    week: { one: "{value} week", other: "{value} weeks" },
    day: { one: "{value} day", other: "{value} days" },
    hour: { one: "{value} hour", other: "{value} hours" },
    minute: { one: "{value} minute", other: "{value} minutes" },
  },
};

const translations = {
  ru: {
    "common.enabled": "Включен",
    "common.disabled": "Выключен",
    "window.close": "Закрыть",
    "window.minimize": "Свернуть",
    "window.maximize": "Развернуть",
    "app.repositoryOpenError": "Не удалось открыть GitHub",
    "nav.serverSession": "Серверная сессия",
    "nav.settings": "Настройки",
    "nav.sections": "Разделы",
    "session.startLocalTunnel": "Поднять обычный туннель",
    "session.stopLocalTunnel": "Остановить обычный туннель",
    "session.startReverseTunnel": "Поднять обратный туннель",
    "session.stopReverseTunnel": "Остановить обратный туннель",
    "session.vdsSidebarBrand": "Shared VDS",
    "session.vdsSidebarTitle": "VDS",
    "session.vdsProfilesTitle": "Конфиги VDS",
    "session.addVdsProfile": "Добавить VDS",
    "session.vdsProfileName": "Название конфига",
    "session.vdsProfileActions": "Действия VDS",
    "session.pinVdsProfile": "Закрепить",
    "session.unpinVdsProfile": "Открепить",
    "session.renameVdsProfile": "Редактировать",
    "session.removeVdsProfile": "Удалить",
    "session.removeVdsProfileBlocked":
      "Остановите туннели этого VDS перед удалением",
    "session.vdsReferralTitle": "Надежные VDS",
    "session.vdsReferralBenefitIp": "Качественный IP Адресса",
    "session.vdsReferralBenefitConfig":
      "Удобная конфигурация под любой проект",
    "session.vdsReferralBenefitProxy": "Подходит для VPN и Proxy",
    "session.vdsReferralAction": "Выбрать VDS",
    "session.vdsReferralOpenError": "Не удалось открыть ссылку на серверы VDS",
    "session.emptyShellTitle": "Выберите VDS",
    "session.emptyShellDescription":
      "Откройте VDS слева или добавьте новый сервер для настройки туннелей.",
    "session.vdsTitle": "VDS",
    "session.healthStatus": "Статус",
    "session.healthStatusOk": "Доступен",
    "session.healthStatusDegraded": "Частично",
    "session.healthStatusError": "Недоступен",
    "session.healthStatusChecking": "Проверка",
    "session.healthStatusIdle": "Не настроен",
    "session.healthCpuLoad": "CPU",
    "session.healthRam": "Память",
    "session.healthDisk": "Диск",
    "session.healthUptime": "Время работы",
    "session.healthLocation": "Локация",
    "session.healthLastUpdated": "Обновлено",
    "session.healthRefresh": "Обновить",
    "session.healthLoading": "Проверяем VDS",
    "session.healthNotConfigured": "Нет VDS-конфига.",
    "session.healthTimeline": "Доступность",
    "session.host": "IP сервера",
    "session.sshPort": "Порт",
    "session.username": "Пользователь",
    "session.identityFile": "SSH ключ",
    "session.chooseIdentityFile": "Выбрать SSH ключ",
    "session.createKey": "Создать",
    "session.installPublicKeyCommand": "Команды для записи ключа",
    "session.vdsConfig": "Конфиг VDS",
    "session.vdsTunnelsTitle": "Туннели",
    "session.reverseTunnelsTitle": "Обратные туннели",
    "session.tunnelName": "Название",
    "session.macPort": "Локальный порт",
    "session.vdsPort": "VDS порт",
    "session.addTunnel": "Добавить",
    "session.removeTunnel": "Удалить туннель",
    "session.startTunnel": "Включить",
    "session.stopTunnel": "Отключить",
    "session.tunnelStatusConnected": "Работает",
    "session.tunnelStatusDegraded": "Порт недоступен",
    "session.tunnelStatusStopped": "Остановлен",
    "session.tunnelStatusError": "Ошибка",
    "session.tunnelStatusDetails": "Детали статуса",
    "session.localAccessTitle": "Доступ к этому компьютеру",
    "session.remoteTunnelPort": "Порт на VDS",
    "session.localSshPort": "Локальный SSH порт",
    "session.choose": "Выбрать",
    "session.testConnection": "Тестировать",
    "session.openServerTerminal": "Открыть",
    "session.terminalSystem": "Системный",
    "session.chooseTerminal": "Выбрать терминал",
    "session.installSshKey": "Записать ключ",
    "session.runCommand": "Запустить",
    "session.copy": "Копировать",
    "session.copied": "Скопировано",
    "session.localSshPromptTitle": "Настроить Local SSH",
    "session.localSshNeedsSettings.macos":
      "Локальный SSH выключен. Открыть System Settings -> Sharing для Remote Login?",
    "session.localSshNeedsSettings.windows":
      "Локальный SSH выключен. Открыть Windows Optional Features или Services для OpenSSH Server?",
    "session.localSshNeedsSettings.linux":
      "Локальный SSH выключен. Открыть терминал с инструкциями для openssh-server/sshd?",
    "session.localSshNeedsSettings.unknown":
      "Локальный SSH выключен. Настройте OpenSSH Server для вашей OS.",
    "session.openLocalSshSettings": "Открыть настройки",
    "session.openLocalSshInstructions": "Открыть инструкцию",
    "session.localSshInstructions.macos":
      "Включите Remote Login: System Settings -> General -> Sharing -> Remote Login. Приложение может запросить системное подтверждение администратора.",
    "session.localSshInstructions.windows":
      "Включите OpenSSH Server: Settings -> System -> Optional features -> OpenSSH Server, затем запустите службу sshd в Services или PowerShell от администратора.",
    "session.localSshInstructions.linux":
      "Установите и запустите openssh-server/sshd через пакетный менеджер дистрибутива. Для systemd обычно используется sudo systemctl enable --now ssh или sshd.",
    "session.localSshInstructions.unknown":
      "Установите и запустите OpenSSH Server для вашей OS, затем проверьте доступность локального SSH порта.",
    "session.systemToolMissingSsh.macos":
      "Не найдена системная команда ssh. Установите OpenSSH Client через Xcode Command Line Tools или Homebrew.",
    "session.systemToolMissingSsh.linux":
      "Не найдена системная команда ssh. Установите openssh-client через пакетный менеджер дистрибутива.",
    "session.systemToolMissingSsh.windows":
      "Не найдена системная команда ssh. Включите OpenSSH Client в Windows Optional Features.",
    "session.systemToolMissingSsh.unknown":
      "Не найдена системная команда ssh. Установите OpenSSH Client для вашей OS.",
    "session.systemToolMissingSshKeygen.macos":
      "Не найдена системная команда ssh-keygen. Установите OpenSSH через Xcode Command Line Tools или Homebrew.",
    "session.systemToolMissingSshKeygen.linux":
      "Не найдена системная команда ssh-keygen. Установите openssh-client через пакетный менеджер дистрибутива.",
    "session.systemToolMissingSshKeygen.windows":
      "Не найдена системная команда ssh-keygen. Включите OpenSSH Client в Windows Optional Features.",
    "session.systemToolMissingSshKeygen.unknown":
      "Не найдена системная команда ssh-keygen. Установите OpenSSH Client для вашей OS.",
    "session.terminalNotFound":
      "Терминал не найден. Скопируйте команду и выполните её вручную.",
    "session.terminalFallbackCommand": "Команда для ручного запуска",
    "session.remoteLoginPromptTitle": "Настроить Local SSH",
    "session.remoteLoginNeedsSettings":
      "Локальный SSH выключен. Открыть настройки Local SSH?",
    "session.openRemoteLoginSettings": "Открыть настройки",
    "session.remoteLoginPromptCancel": "Не сейчас",
    "update.installing": "Устанавливаем...",
    "update.install": "Установить обновление {version}",
    "update.error": "Не удалось установить обновление",
    "settings.generalTab": "Основные",
    "settings.logsTab": "Логи",
    "settings.theme": "Тема",
    "settings.themeSystem": "Системная",
    "settings.themeLight": "Светлая",
    "settings.themeDark": "Темная",
    "settings.interfaceLanguage": "Язык интерфейса",
    "settings.statsRefresh": "Обновление статистики",
    "settings.statsRefresh5s": "5 секунд",
    "settings.statsRefresh10s": "10 секунд",
    "settings.statsRefresh30s": "30 секунд",
    "settings.statsRefresh1m": "1 минута",
    "settings.statsRefresh5m": "5 минут",
    "settings.statsRefresh10m": "10 минут",
    "settings.autostart": "Автозапуск",
    "settings.autostartBusy": "Применяем...",
    "settings.logsPathLabel": "Файл логов",
    "settings.logsPathDescription":
      "Текущий путь к app log. Файл создается автоматически при открытии.",
    "settings.logsOpenFile": "Открыть файл",
    "settings.logsRevealFile": "Показать в папке",
    "settings.logsOpenFileError": "Не удалось открыть файл логов",
    "settings.logsRevealFileError": "Не удалось показать файл в папке",
  },
  en: {
    "common.enabled": "Enabled",
    "common.disabled": "Disabled",
    "window.close": "Close",
    "window.minimize": "Minimize",
    "window.maximize": "Maximize",
    "app.repositoryOpenError": "Failed to open GitHub",
    "nav.serverSession": "Server session",
    "nav.settings": "Settings",
    "nav.sections": "Sections",
    "session.startLocalTunnel": "Start regular tunnel",
    "session.stopLocalTunnel": "Stop regular tunnel",
    "session.startReverseTunnel": "Start reverse tunnel",
    "session.stopReverseTunnel": "Stop reverse tunnel",
    "session.vdsSidebarBrand": "Shared VDS",
    "session.vdsSidebarTitle": "VDS",
    "session.vdsProfilesTitle": "VDS configs",
    "session.addVdsProfile": "Add VDS",
    "session.vdsProfileName": "Config name",
    "session.vdsProfileActions": "VDS actions",
    "session.pinVdsProfile": "Pin",
    "session.unpinVdsProfile": "Unpin",
    "session.renameVdsProfile": "Edit",
    "session.removeVdsProfile": "Delete",
    "session.removeVdsProfileBlocked":
      "Stop this VDS tunnels before removing it",
    "session.vdsReferralTitle": "VDS servers",
    "session.vdsReferralBenefitIp": "Quality IP addresses",
    "session.vdsReferralBenefitConfig":
      "Convenient configuration for any project",
    "session.vdsReferralBenefitProxy": "Works for VPN and Proxy",
    "session.vdsReferralAction": "Choose VDS",
    "session.vdsReferralOpenError": "Failed to open the VDS servers link",
    "session.emptyShellTitle": "Choose a VDS",
    "session.emptyShellDescription":
      "Open a VDS from the sidebar or add a new server to configure tunnels.",
    "session.vdsTitle": "VDS",
    "session.healthStatus": "Status",
    "session.healthStatusOk": "Reachable",
    "session.healthStatusDegraded": "Partial",
    "session.healthStatusError": "Unavailable",
    "session.healthStatusChecking": "Checking",
    "session.healthStatusIdle": "Not configured",
    "session.healthCpuLoad": "CPU/load",
    "session.healthRam": "RAM",
    "session.healthDisk": "Disk",
    "session.healthUptime": "Uptime",
    "session.healthLocation": "Location",
    "session.healthLastUpdated": "Updated",
    "session.healthRefresh": "Refresh",
    "session.healthLoading": "Checking VDS",
    "session.healthNotConfigured": "No VDS config.",
    "session.healthTimeline": "Availability",
    "session.host": "Server IP",
    "session.sshPort": "Port",
    "session.username": "User",
    "session.identityFile": "SSH key",
    "session.chooseIdentityFile": "Choose SSH key",
    "session.createKey": "Create",
    "session.installPublicKeyCommand": "Key installation commands",
    "session.vdsConfig": "VDS config",
    "session.vdsTunnelsTitle": "Tunnels",
    "session.reverseTunnelsTitle": "Reverse tunnels",
    "session.tunnelName": "Name",
    "session.macPort": "Local port",
    "session.vdsPort": "VDS port",
    "session.addTunnel": "Add",
    "session.removeTunnel": "Remove tunnel",
    "session.startTunnel": "Enable",
    "session.stopTunnel": "Disable",
    "session.tunnelStatusConnected": "Running",
    "session.tunnelStatusDegraded": "Port unavailable",
    "session.tunnelStatusStopped": "Stopped",
    "session.tunnelStatusError": "Error",
    "session.tunnelStatusDetails": "Status details",
    "session.localAccessTitle": "Access to this computer",
    "session.remoteTunnelPort": "VDS port",
    "session.localSshPort": "Local SSH port",
    "session.choose": "Choose",
    "session.testConnection": "Test",
    "session.openServerTerminal": "Open",
    "session.terminalSystem": "System",
    "session.chooseTerminal": "Choose terminal",
    "session.installSshKey": "Install key",
    "session.runCommand": "Run",
    "session.copy": "Copy",
    "session.copied": "Copied",
    "session.localSshPromptTitle": "Set up Local SSH",
    "session.localSshNeedsSettings.macos":
      "Local SSH is off. Open System Settings -> Sharing for Remote Login?",
    "session.localSshNeedsSettings.windows":
      "Local SSH is off. Open Windows Optional Features or Services for OpenSSH Server?",
    "session.localSshNeedsSettings.linux":
      "Local SSH is off. Open a terminal with openssh-server/sshd instructions?",
    "session.localSshNeedsSettings.unknown":
      "Local SSH is off. Configure OpenSSH Server for your OS.",
    "session.openLocalSshSettings": "Open settings",
    "session.openLocalSshInstructions": "Open instructions",
    "session.localSshInstructions.macos":
      "Enable Remote Login: System Settings -> General -> Sharing -> Remote Login. The app can request the system administrator prompt.",
    "session.localSshInstructions.windows":
      "Enable OpenSSH Server: Settings -> System -> Optional features -> OpenSSH Server, then start the sshd service in Services or administrator PowerShell.",
    "session.localSshInstructions.linux":
      "Install and start openssh-server/sshd with your distribution package manager. On systemd distributions this is usually sudo systemctl enable --now ssh or sshd.",
    "session.localSshInstructions.unknown":
      "Install and start OpenSSH Server for your OS, then verify that the local SSH port is reachable.",
    "session.systemToolMissingSsh.macos":
      "System command ssh was not found. Install OpenSSH Client with Xcode Command Line Tools or Homebrew.",
    "session.systemToolMissingSsh.linux":
      "System command ssh was not found. Install openssh-client with your distribution package manager.",
    "session.systemToolMissingSsh.windows":
      "System command ssh was not found. Enable OpenSSH Client in Windows Optional Features.",
    "session.systemToolMissingSsh.unknown":
      "System command ssh was not found. Install OpenSSH Client for your OS.",
    "session.systemToolMissingSshKeygen.macos":
      "System command ssh-keygen was not found. Install OpenSSH with Xcode Command Line Tools or Homebrew.",
    "session.systemToolMissingSshKeygen.linux":
      "System command ssh-keygen was not found. Install openssh-client with your distribution package manager.",
    "session.systemToolMissingSshKeygen.windows":
      "System command ssh-keygen was not found. Enable OpenSSH Client in Windows Optional Features.",
    "session.systemToolMissingSshKeygen.unknown":
      "System command ssh-keygen was not found. Install OpenSSH Client for your OS.",
    "session.terminalNotFound":
      "No terminal app was found. Copy the command and run it manually.",
    "session.terminalFallbackCommand": "Manual command",
    "session.remoteLoginPromptTitle": "Set up Local SSH",
    "session.remoteLoginNeedsSettings":
      "Local SSH is off. Open Local SSH settings?",
    "session.openRemoteLoginSettings": "Open settings",
    "session.remoteLoginPromptCancel": "Not now",
    "update.installing": "Installing...",
    "update.install": "Install update {version}",
    "update.error": "Could not install update",
    "settings.generalTab": "General",
    "settings.logsTab": "Logs",
    "settings.theme": "Theme",
    "settings.themeSystem": "System",
    "settings.themeLight": "Light",
    "settings.themeDark": "Dark",
    "settings.interfaceLanguage": "Interface language",
    "settings.statsRefresh": "Stats refresh",
    "settings.statsRefresh5s": "5 seconds",
    "settings.statsRefresh10s": "10 seconds",
    "settings.statsRefresh30s": "30 seconds",
    "settings.statsRefresh1m": "1 minute",
    "settings.statsRefresh5m": "5 minutes",
    "settings.statsRefresh10m": "10 minutes",
    "settings.autostart": "Autostart",
    "settings.autostartBusy": "Applying...",
    "settings.logsPathLabel": "Log file",
    "settings.logsPathDescription":
      "Current app log path. The file is created automatically before opening.",
    "settings.logsOpenFile": "Open file",
    "settings.logsRevealFile": "Show in folder",
    "settings.logsOpenFileError": "Could not open the log file",
    "settings.logsRevealFileError": "Could not show the file in its folder",
  },
} as const;

export function normalizeInterfaceLanguage(
  language: unknown,
): InterfaceLanguage {
  return language === "en" ? "en" : DEFAULT_INTERFACE_LANGUAGE;
}

export function applyInterfaceLanguage(language: InterfaceLanguage): void {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.lang = language;
  document.documentElement.dataset.locale = language;
}

export async function applySavedInterfaceLanguage(): Promise<InterfaceLanguage> {
  try {
    const settings = await getSettings({ reload: true });
    const language = normalizeInterfaceLanguage(settings.interfaceLanguage);
    applyInterfaceLanguage(language);
    return language;
  } catch {
    applyInterfaceLanguage(DEFAULT_INTERFACE_LANGUAGE);
    return DEFAULT_INTERFACE_LANGUAGE;
  }
}

export function translate(
  language: InterfaceLanguage,
  key: TranslationKey,
  values: Record<string, string> = {},
): string {
  const template: string =
    translations[language][key] ?? translations.ru[key] ?? key;
  return Object.entries(values).reduce<string>(
    (text, [name, value]) => text.split(`{${name}}`).join(value),
    template,
  );
}

export function formatDurationUnit(
  language: InterfaceLanguage,
  unit: DurationUnit,
  value: number,
): string {
  const category = new Intl.PluralRules(language).select(
    value,
  ) as DurationPluralCategory;
  const template =
    durationTranslations[language][unit][category] ??
    durationTranslations[language][unit].other ??
    durationTranslations.en[unit].other ??
    "{value}";

  return template.split("{value}").join(String(value));
}

export function useI18n(): {
  language: InterfaceLanguage;
  t: (key: TranslationKey, values?: Record<string, string>) => string;
} {
  const language = useAppLocale();

  return {
    language,
    t: (key, values) => translate(language, key, values),
  };
}

export function useAppLocale(): InterfaceLanguage {
  const [language, setLanguage] = useState<InterfaceLanguage>(
    DEFAULT_INTERFACE_LANGUAGE,
  );

  useEffect(() => {
    let mounted = true;

    const sync = async (reload = false): Promise<void> => {
      const settings = await getSettings({ reload });
      const nextLanguage = normalizeInterfaceLanguage(
        settings.interfaceLanguage,
      );

      if (!mounted) {
        return;
      }

      applyInterfaceLanguage(nextLanguage);
      setLanguage(nextLanguage);
    };

    void sync(true);

    const unlistenPromise = listen(SETTINGS_UPDATED_EVENT, () => {
      void sync(true);
    });

    return () => {
      mounted = false;
      unlistenPromise.then((dispose) => dispose());
    };
  }, []);

  return language;
}

export function useT(): (
  key: TranslationKey,
  values?: Record<string, string>,
) => string {
  const language = useAppLocale();
  return (key, values) => translate(language, key, values);
}
