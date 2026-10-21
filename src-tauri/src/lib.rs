use tauri::Manager;
mod commitments;
mod containers;
mod cues;
mod db;
mod notifier;
mod ntfy;
mod reminder;
mod sync;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            let app_handle = app.handle().clone();
            let data_dir = app.path().app_data_dir()?;
            let db_file = db::db_path(&data_dir)?;
            tauri::async_runtime::block_on(async move {
                let db_state = db::db_init(&db_file)
                    .await
                    .expect("Failed to initialize DB!");
                app_handle.manage(db_state);
            });
            app.manage(notifier::NtfyClient(ntfy::make_client(ntfy::SEND_TIMEOUT)));
            app.manage(sync::SyncDir(data_dir));
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            containers::create_container,
            containers::attach_block,
            containers::dismiss_block,
            containers::reschedule_block,
            containers::get_block_details,
            containers::update_block,
            containers::list_day_blocks,
            containers::fetch_container,
            commitments::sync_commitments,
            commitments::start_block,
            commitments::continue_block,
            commitments::finish_block,
            commitments::lapse_block,
            commitments::list_commitments,
            db::get_next_order_index,
            cues::create_cue,
            cues::update_cue,
            cues::list_cues,
            cues::delete_cue,
            cues::prune_expired_cues,
            cues::get_profile,
            cues::set_profile,
            ntfy::get_ntfy_topic,
            ntfy::set_ntfy_topic,
            notifier::tick_reminders,
            sync::get_sync_status,
            sync::set_sync_folder,
            sync::run_sync,
            sync::sync_resolve,
            sync::get_synced_setting,
            sync::set_synced_setting
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
