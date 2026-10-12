use tauri::Manager;
mod containers;
mod cues;
mod db;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            let app_handle = app.handle().clone();
            let db_file = db::db_path(&app.path().app_data_dir()?)?;
            tauri::async_runtime::block_on(async move {
                let db_state = db::db_init(&db_file)
                    .await
                    .expect("Failed to initialize DB!");
                app_handle.manage(db_state);
            });
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            containers::create_container,
            containers::fetch_container,
            containers::list_pending_blocks,
            db::get_next_order_index,
            cues::create_cue,
            cues::update_cue,
            cues::list_cues,
            cues::delete_cue,
            cues::get_profile,
            cues::set_profile
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
