use crate::containers::FocusBlock;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::State;

pub struct DbState {
    pub pool: SqlitePool,
}

// The database lives in the per-user app-data folder. A relative path like "blinkers.db"
// resolves against wherever the app happened to be launched from, so an installed app would
// scatter databases around (or fail on a read-only folder) and users would lose their data.
pub fn db_path(app_data_dir: &Path) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(app_data_dir)?;
    Ok(app_data_dir.join("blinkers.db"))
}

pub async fn db_init(path: &Path) -> Result<DbState, Box<dyn std::error::Error>> {
    // .filename() takes the path as-is; building a "sqlite://..." string would break on
    // spaces and special characters in the user's profile folder.
    let connection_options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .busy_timeout(Duration::from_secs(5));

    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(connection_options)
        .await?;

    init_container_schema(&pool).await?;
    init_cue_schema(&pool).await?;

    Ok(DbState { pool })
}

pub async fn init_container_schema(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS focus_blocks (
            id TEXT PRIMARY KEY NOT NULL,
            is_completed INTEGER NOT NULL
        );",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS containers (
            id TEXT PRIMARY KEY NOT NULL,
            focus_block_id TEXT NOT NULL,
            order_index INTEGER NOT NULL,
            notes TEXT,
            task_title TEXT NOT NULL,
            action_trigger TEXT,
            definition_of_done TEXT
        );",
    )
    .execute(pool)
    .await?;

    // Older databases were created before these columns existed. Their rows get the defaults:
    // created_on = '' never equals a real date, so old blocks are never treated as "today".
    add_column_if_missing(pool, "containers", "block_type", "TEXT NOT NULL DEFAULT 'deep'").await?;
    add_column_if_missing(pool, "containers", "created_on", "TEXT NOT NULL DEFAULT ''").await?;

    Ok(())
}

async fn column_exists(pool: &SqlitePool, table: &str, column: &str) -> Result<bool, sqlx::Error> {
    let found: Option<String> =
        sqlx::query_scalar(&format!("SELECT name FROM pragma_table_info('{table}') WHERE name = $1"))
            .bind(column)
            .fetch_optional(pool)
            .await?;
    Ok(found.is_some())
}

// SQLite has no "ADD COLUMN IF NOT EXISTS", so check the table's columns first. Table and
// column names are constants from this file, never user input.
async fn add_column_if_missing(
    pool: &SqlitePool,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), sqlx::Error> {
    if !column_exists(pool, table, column).await? {
        sqlx::query(&format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"))
            .execute(pool)
            .await?;
    }
    Ok(())
}

// A cue is a fixed time of day that repeats on some weekdays; `days` is a JSON array of
// weekday numbers (0 = Sunday). `settings` is a key/value table so one-off user preferences
// (the profile) need no table each.
pub async fn init_cue_schema(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS cues (
            id TEXT PRIMARY KEY NOT NULL,
            label TEXT NOT NULL,
            time_min INTEGER NOT NULL,
            days TEXT NOT NULL,
            flex_min INTEGER NOT NULL DEFAULT 0
        );",
    )
    .execute(pool)
    .await?;

    // Cues used to be a from-to range (start_min / end_min). Rebuild such a table: the start
    // becomes the fixed time, the end is dropped, and flex is clamped to the new 120 minute cap.
    if column_exists(pool, "cues", "end_min").await? {
        let mut tx = pool.begin().await?;
        sqlx::query(
            "CREATE TABLE cues_new (
                id TEXT PRIMARY KEY NOT NULL,
                label TEXT NOT NULL,
                time_min INTEGER NOT NULL,
                days TEXT NOT NULL,
                flex_min INTEGER NOT NULL DEFAULT 0
            );",
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO cues_new (id, label, time_min, days, flex_min)
             SELECT id, label, start_min, days, MIN(flex_min, 120) FROM cues",
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query("DROP TABLE cues").execute(&mut *tx).await?;
        sqlx::query("ALTER TABLE cues_new RENAME TO cues").execute(&mut *tx).await?;
        tx.commit().await?;
    }

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY NOT NULL,
            value TEXT NOT NULL
        );",
    )
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn insert_container_in(pool: &SqlitePool, focus_block: &FocusBlock) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;

    sqlx::query("INSERT INTO focus_blocks (id, is_completed) VALUES ($1, $2)")
        .bind(&focus_block.id)
        .bind(focus_block.is_completed as i32)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

    let container = &focus_block.container;

    sqlx::query(
        "INSERT INTO containers (id, focus_block_id, order_index, notes, task_title, action_trigger, definition_of_done, block_type, created_on)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(&container.id)
    .bind(&focus_block.id)
    .bind(container.order_index)
    .bind(&container.notes)
    .bind(&container.primary_task.title)
    .bind(&container.primary_task.action_trigger)
    .bind(&container.primary_task.definition_of_done)
    .bind(&container.block_type)
    .bind(&container.created_on)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;

    tx.commit().await.map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn get_next_order_index(db_state: State<'_, DbState>) -> Result<i32, String> {
    let max_index: Option<i32> = sqlx::query_scalar("SELECT MAX(order_index) FROM containers")
        .fetch_optional(&db_state.pool)
        .await
        .map_err(|e| e.to_string())?;

    Ok(max_index.unwrap_or(-1) + 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    // A fresh, unique folder per test so runs never see each other's files.
    fn scratch() -> PathBuf {
        std::env::temp_dir().join(format!("blinkers-test-{}", uuid::Uuid::new_v4()))
    }

    async fn table_names(pool: &SqlitePool) -> Vec<String> {
        sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .fetch_all(pool)
            .await
            .unwrap()
    }

    #[test]
    fn db_path_creates_missing_folders_and_names_the_file() {
        let dir = scratch().join("a").join("b");
        let path = db_path(&dir).unwrap();
        assert!(dir.is_dir());
        assert_eq!(path, dir.join("blinkers.db"));
        std::fs::remove_dir_all(dir.parent().unwrap().parent().unwrap()).ok();
    }

    #[tokio::test]
    async fn a_first_launch_creates_the_file_and_every_table() {
        let dir = scratch();
        let path = db_path(&dir).unwrap();
        let state = db_init(&path).await.unwrap();
        assert!(path.is_file());
        assert_eq!(table_names(&state.pool).await, vec!["containers", "cues", "focus_blocks", "settings"]);
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn folders_with_spaces_and_non_ascii_characters_work() {
        // Windows users routinely have a space in their profile folder name.
        let dir = scratch().join("John Doe").join("données");
        let path = db_path(&dir).unwrap();
        assert!(db_init(&path).await.is_ok());
        std::fs::remove_dir_all(dir.parent().unwrap().parent().unwrap()).ok();
    }

    #[tokio::test]
    async fn data_survives_closing_and_reopening_the_app() {
        let dir = scratch();
        let path = db_path(&dir).unwrap();

        let first = db_init(&path).await.unwrap();
        sqlx::query("INSERT INTO settings (key, value) VALUES ('k', 'v')").execute(&first.pool).await.unwrap();
        first.pool.close().await;

        let second = db_init(&path).await.unwrap();
        let value: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'k'").fetch_one(&second.pool).await.unwrap();
        assert_eq!(value, "v");
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn cues_saved_in_the_old_range_format_keep_their_start_time() {
        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE cues (id TEXT PRIMARY KEY NOT NULL, label TEXT NOT NULL, start_min INTEGER NOT NULL, end_min INTEGER NOT NULL, days TEXT NOT NULL, flex_min INTEGER NOT NULL DEFAULT 0)").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO cues VALUES ('a', 'After school', 930, 1020, '[1,2,3,4,5]', 10)").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO cues VALUES ('b', 'Huge flex', 600, 900, '[0]', 200)").execute(&pool).await.unwrap();

        init_cue_schema(&pool).await.unwrap();
        init_cue_schema(&pool).await.unwrap(); // running twice must be harmless

        let columns: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('cues') ORDER BY cid").fetch_all(&pool).await.unwrap();
        assert_eq!(columns, vec!["id", "label", "time_min", "days", "flex_min"]);

        let rows: Vec<(String, i32, String, i32)> = sqlx::query_as("SELECT id, time_min, days, flex_min FROM cues ORDER BY id").fetch_all(&pool).await.unwrap();
        // The old end time is dropped; flex above the new 120 cap is clamped.
        assert_eq!(rows, vec![
            ("a".to_string(), 930, "[1,2,3,4,5]".to_string(), 10),
            ("b".to_string(), 600, "[0]".to_string(), 120),
        ]);
    }

    #[tokio::test]
    async fn a_fresh_database_gets_the_fixed_time_cues_table() {
        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        init_cue_schema(&pool).await.unwrap();
        let columns: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('cues') ORDER BY cid").fetch_all(&pool).await.unwrap();
        assert_eq!(columns, vec!["id", "label", "time_min", "days", "flex_min"]);
    }
}
