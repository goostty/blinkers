use tauri::Manager;
mod containers;
mod db;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_handle = app.handle().clone();
            tauri::async_runtime::block_on(async move {
                let db_state = db::db_init()
                    .await
                    .expect("Failed to initialize DB!");
                app_handle.manage(db_state);
            });
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![containers::create_container, containers::fetch_container, db::get_next_order_index])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
