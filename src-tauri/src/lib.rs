mod engine;
mod logic;

use tauri::Emitter;

#[tauri::command]
async fn snapshot() -> Result<engine::Snapshot, String> {
    tauri::async_runtime::spawn_blocking(engine::snapshot)
        .await
        .map_err(|error| format!("поток состояния оборвался: {error}"))?
}

#[tauri::command]
async fn install(app: tauri::AppHandle, req: engine::InstallRequest) -> Result<engine::Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = engine::try_lock()?;
        engine::install(req, &|stage, status, message, percent| {
            let _ = app.emit(
                "progress",
                engine::ProgressEvent {
                    stage: stage.to_string(),
                    status: status.to_string(),
                    message: message.to_string(),
                    percent,
                },
            );
        })
    })
    .await
    .map_err(|error| format!("поток установки оборвался: {error}"))?
}

#[tauri::command]
async fn start_tavern(app: tauri::AppHandle) -> Result<engine::Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = engine::try_lock()?;
        engine::start_tavern(&|stage, status, message, percent| {
            let _ = app.emit(
                "progress",
                engine::ProgressEvent {
                    stage: stage.to_string(),
                    status: status.to_string(),
                    message: message.to_string(),
                    percent,
                },
            );
        })
    })
    .await
    .map_err(|error| format!("поток запуска оборвался: {error}"))?
}

#[tauri::command]
async fn stop_tavern() -> Result<engine::Snapshot, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let _guard = engine::try_lock()?;
        engine::stop_tavern()
    })
    .await
    .map_err(|error| format!("поток остановки оборвался: {error}"))?
}

#[tauri::command]
async fn save_settings(req: engine::SaveRequest) -> Result<engine::Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = engine::try_lock()?;
        engine::save_settings(req)
    })
    .await
    .map_err(|error| format!("поток настроек оборвался: {error}"))?
}

#[tauri::command]
async fn open_url(url: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || engine::open_url(url))
        .await
        .map_err(|error| format!("поток браузера оборвался: {error}"))?
}

#[tauri::command]
async fn open_folder(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || engine::open_folder(path))
        .await
        .map_err(|error| format!("поток каталога оборвался: {error}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            snapshot,
            install,
            start_tavern,
            stop_tavern,
            save_settings,
            open_url,
            open_folder
        ])
        .run(tauri::generate_context!())
        .expect("окно WuTavern не открылось");
}
