use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::logger;

fn show_and_focus_window(win: &tauri::WebviewWindow) {
    if let Err(err) = win.show() {
        logger::log_error(
            "WINDOW",
            &format!("Failed to show settings window: {}", err),
        );
    }

    if let Err(err) = win.set_focus() {
        logger::log_error(
            "WINDOW",
            &format!("Failed to focus settings window: {}", err),
        );
    }
}

fn create_settings_window(app: &AppHandle, url: &str) -> Result<tauri::WebviewWindow, String> {
    let mut builder = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App(url.into()))
        .title("Shared VDS")
        .inner_size(960.0, 720.0)
        .min_inner_size(760.0, 560.0)
        .decorations(false)
        .center();

    #[cfg(target_os = "linux")]
    {
        builder = builder.transparent(false);
    }

    #[cfg(not(target_os = "linux"))]
    {
        builder = builder.transparent(true);
    }

    let win = builder.build().map_err(|e| e.to_string())?;
    show_and_focus_window(&win);
    Ok(win)
}

#[tauri::command]
pub async fn open_settings(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("settings") {
        show_and_focus_window(&win);
        return Ok(());
    }

    create_settings_window(&app, "index.html?window=settings")?;
    Ok(())
}
