use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

static LOG_MUTEX: Mutex<()> = Mutex::new(());

pub fn get_log_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".shared-vds")
}

pub fn get_log_path() -> PathBuf {
    get_log_dir().join("shared-vds.log")
}

fn ensure_log_file() -> Result<PathBuf, String> {
    let path = get_log_path();

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;

    Ok(path)
}

pub fn log(level: &str, tag: &str, message: &str) {
    let _guard = LOG_MUTEX.lock().unwrap_or_else(|e| e.into_inner());

    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let line = format!("[{}] [{}] [{}] {}\n", timestamp, level, tag, message);

    if let Some(parent) = get_log_path().parent() {
        let _ = fs::create_dir_all(parent);
    }

    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(get_log_path())
    {
        let _ = file.write_all(line.as_bytes());
    }

    println!("{}", line.trim());
}

pub fn log_info(tag: &str, message: &str) {
    log("INFO", tag, message);
}

pub fn log_error(tag: &str, message: &str) {
    log("ERROR", tag, message);
}

#[tauri::command]
pub fn log_event(level: String, tag: String, message: String) {
    log(&level, &tag, &message);
}

#[tauri::command]
pub fn get_log_path_cmd() -> String {
    get_log_path().to_string_lossy().to_string()
}

#[tauri::command]
pub fn open_log_file_cmd() -> Result<(), String> {
    let path = ensure_log_file()?;
    tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reveal_log_file_cmd() -> Result<(), String> {
    let path = ensure_log_file()?;
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_logs() -> Result<(), String> {
    let path = get_log_path();
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
