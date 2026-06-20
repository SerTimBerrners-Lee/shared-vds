mod commands;
mod logger;

use commands::settings_window;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(commands::server_session::ServerSessionManager::new())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            logger::log_info("INIT", "Application starting...");

            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                None,
            ))?;

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                let _ = settings_window::open_settings(handle).await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings_window::open_settings,
            commands::server_session::get_server_session_status,
            commands::server_session::get_vds_system_status,
            commands::server_session::get_vds_health,
            commands::server_session::get_vds_location,
            commands::server_session::generate_ssh_key,
            commands::server_session::read_ssh_public_key,
            commands::server_session::test_server_connection,
            commands::server_session::check_local_ssh_access,
            commands::server_session::get_available_terminals,
            commands::server_session::open_remote_login_settings,
            commands::server_session::request_remote_login,
            commands::server_session::open_server_terminal,
            commands::server_session::open_server_terminal_command,
            commands::server_session::open_server_key_install_terminal,
            commands::server_session::get_local_tunnel_status,
            commands::server_session::start_local_tunnel,
            commands::server_session::stop_local_tunnel,
            commands::server_session::start_server_session_tunnel,
            commands::server_session::stop_server_session_tunnel,
            logger::log_event,
            logger::get_log_path_cmd,
            logger::open_log_file_cmd,
            logger::reveal_log_file_cmd,
            logger::clear_logs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Shared VDS");
}
