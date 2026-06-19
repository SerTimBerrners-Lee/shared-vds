import ReactDOM from "react-dom/client";
import "./index.css";
import { SettingsApp } from "./windows/settings/SettingsApp";
import { applySavedTheme, applyThemePreference } from "./lib/theme";
import { applySavedInterfaceLanguage } from "./lib/i18n";

applyThemePreference("system");
void applySavedTheme();
void applySavedInterfaceLanguage();

ReactDOM.createRoot(document.getElementById("root")!).render(<SettingsApp />);
