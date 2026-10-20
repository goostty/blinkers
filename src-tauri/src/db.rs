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
    init_commitment_schema(&pool).await?;

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
    // Eisenhower urgency of deep/routine blocks. Nullable on purpose: old rows and rest blocks
    // have none, and NULL is how the scheduler recognises them (no cap, no reserve, no carry-over).
    add_column_if_missing(pool, "containers", "urgency", "TEXT").await?;
    // The apps/websites to open when the block starts, as a JSON array. Older blocks have none.
    add_column_if_missing(pool, "containers", "apps", "TEXT").await?;

    // A block has a length (minutes, as entered) and sits in a linked list: `parent_kind` is
    // 'cue' or 'block' and `parent_id` says which one it follows. The link only means anything
    // for the day it was made for (`scheduled_on`): a cue repeats every week, and a block that
    // is carried over to a new day has to be attached again. Older blocks have none of these.
    add_column_if_missing(pool, "containers", "duration_min", "INTEGER").await?;
    add_column_if_missing(pool, "containers", "parent_kind", "TEXT").await?;
    add_column_if_missing(pool, "containers", "parent_id", "TEXT").await?;
    add_column_if_missing(pool, "containers", "scheduled_on", "TEXT").await?;
    // A dismissed block was dropped (for example, it ran out of time unfinished). It is not
    // "completed", so the difference between finished and abandoned is never lost.
    add_column_if_missing(pool, "focus_blocks", "dismissed", "INTEGER NOT NULL DEFAULT 0").await?;

    // A list has one "next": at most one block may follow any node on a given day.
    sqlx::query(
        "CREATE UNIQUE INDEX IF NOT EXISTS containers_one_child
         ON containers (scheduled_on, parent_kind, parent_id) WHERE parent_kind IS NOT NULL",
    )
    .execute(pool)
    .await?;

    Ok(())
}

// A commitment is one block's place in today's timeline made durable: "this block starts at
// start_min and runs for duration_min, in the chain after this cue". Reminders fire against it,
// so it must survive a restart. A cue holds a whole chain of blocks, so several commitments can
// share a cue; what stays unique is one commitment per block per day.
//   planned  - decided, no reminder sent yet; a re-plan may still move it
//   nagging  - the first reminder went out and it repeats until the user acts
//   started  - the user pressed Start (they committed)
//   finished - the user pressed Finish
//   lapsed   - they started but the time ran out unfinished
//   missed   - the clock moved on and they never started
// started_at / finished_at are unix seconds; finished_min is the local minute of the day, which
// is what the timeline needs to pull later blocks forward.
fn commitments_table_sql(name: &str) -> String {
    format!(
        "CREATE TABLE {name} (
            id TEXT PRIMARY KEY NOT NULL,
            block_id TEXT NOT NULL,
            on_date TEXT NOT NULL,
            cue_id TEXT NOT NULL,
            start_min INTEGER NOT NULL,
            duration_min INTEGER NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('planned', 'nagging', 'started', 'finished', 'lapsed', 'missed')),
            nag_count INTEGER NOT NULL DEFAULT 0,
            last_nag_at INTEGER,
            started_at INTEGER,
            finished_at INTEGER,
            finished_min INTEGER
        );"
    )
}

pub async fn init_commitment_schema(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query(&commitments_table_sql("IF NOT EXISTS commitments")).execute(pool).await?;

    // The first version of this table had no lengths and allowed one block per cue. SQLite cannot
    // change a CHECK in place, so rebuild it, keeping every row (their length is unknown: 30).
    if !column_exists(pool, "commitments", "duration_min").await? {
        let mut tx = pool.begin().await?;
        sqlx::query("DROP INDEX IF EXISTS commitments_cue_day").execute(&mut *tx).await?;
        sqlx::query("DROP INDEX IF EXISTS commitments_block_day").execute(&mut *tx).await?;
        sqlx::query(&commitments_table_sql("commitments_new")).execute(&mut *tx).await?;
        sqlx::query(
            "INSERT INTO commitments_new (id, block_id, on_date, cue_id, start_min, duration_min, status, nag_count, last_nag_at)
             SELECT id, block_id, on_date, cue_id, start_min, 30, status, nag_count, last_nag_at FROM commitments",
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query("DROP TABLE commitments").execute(&mut *tx).await?;
        sqlx::query("ALTER TABLE commitments_new RENAME TO commitments").execute(&mut *tx).await?;
        tx.commit().await?;
    }

    sqlx::query("DROP INDEX IF EXISTS commitments_cue_day").execute(pool).await?;
    sqlx::query("CREATE UNIQUE INDEX IF NOT EXISTS commitments_block_day ON commitments (block_id, on_date)")
        .execute(pool)
        .await?;

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

    // A cue marked as the end of the day (like "bedtime") closes the chain before it and
    // cannot hold blocks itself.
    add_column_if_missing(pool, "cues", "ends_day", "INTEGER NOT NULL DEFAULT 0").await?;

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

// Inserts inside a transaction the caller owns, so that a block and the re-linking that goes with
// it (the follower it pushes down the chain) are saved together or not at all.
pub async fn insert_container_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    focus_block: &FocusBlock,
) -> Result<(), String> {
    sqlx::query("INSERT INTO focus_blocks (id, is_completed) VALUES ($1, $2)")
        .bind(&focus_block.id)
        .bind(focus_block.is_completed as i32)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;

    let container = &focus_block.container;
    let apps = crate::containers::apps_to_json(&container.apps)?;

    sqlx::query(
        "INSERT INTO containers (id, focus_block_id, order_index, notes, task_title, action_trigger, definition_of_done, block_type, created_on, urgency, apps, duration_min, parent_kind, parent_id, scheduled_on)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)",
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
    .bind(&container.urgency)
    .bind(&apps)
    .bind(container.duration_min)
    .bind(container.parent.as_ref().map(|p| p.kind.as_str()))
    .bind(container.parent.as_ref().map(|p| p.id.as_str()))
    .bind(&container.scheduled_on)
    .execute(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;

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
        assert_eq!(table_names(&state.pool).await, vec!["commitments", "containers", "cues", "focus_blocks", "settings"]);
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
        assert_eq!(columns, vec!["id", "label", "time_min", "days", "flex_min", "ends_day"]);

        let rows: Vec<(String, i32, String, i32)> = sqlx::query_as("SELECT id, time_min, days, flex_min FROM cues ORDER BY id").fetch_all(&pool).await.unwrap();
        // The old end time is dropped; flex above the new 120 cap is clamped.
        assert_eq!(rows, vec![
            ("a".to_string(), 930, "[1,2,3,4,5]".to_string(), 10),
            ("b".to_string(), 600, "[0]".to_string(), 120),
        ]);
    }

    #[tokio::test]
    async fn blocks_saved_before_urgency_existed_get_a_null_urgency() {
        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        // The schema as it was before urgency existed.
        sqlx::query("CREATE TABLE focus_blocks (id TEXT PRIMARY KEY NOT NULL, is_completed INTEGER NOT NULL)").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE containers (id TEXT PRIMARY KEY NOT NULL, focus_block_id TEXT NOT NULL, order_index INTEGER NOT NULL, notes TEXT, task_title TEXT NOT NULL, action_trigger TEXT, definition_of_done TEXT, block_type TEXT NOT NULL DEFAULT 'deep', created_on TEXT NOT NULL DEFAULT '')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO containers (id, focus_block_id, order_index, task_title, created_on) VALUES ('c1', 'b1', 0, 'old', '2026-10-01')").execute(&pool).await.unwrap();

        init_container_schema(&pool).await.unwrap();
        init_container_schema(&pool).await.unwrap(); // running twice must be harmless

        let urgency: Option<String> = sqlx::query_scalar("SELECT urgency FROM containers WHERE id = 'c1'").fetch_one(&pool).await.unwrap();
        assert_eq!(urgency, None);
    }

    async fn memory_pool() -> SqlitePool {
        SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap()
    }

    async fn commit(pool: &SqlitePool, id: &str, block: &str, date: &str, cue: &str, status: &str) -> Result<(), sqlx::Error> {
        sqlx::query("INSERT INTO commitments (id, block_id, on_date, cue_id, start_min, duration_min, status) VALUES ($1, $2, $3, $4, 600, 30, $5)")
            .bind(id)
            .bind(block)
            .bind(date)
            .bind(cue)
            .bind(status)
            .execute(pool)
            .await
            .map(|_| ())
    }

    #[tokio::test]
    async fn the_commitments_table_has_the_expected_columns_and_defaults() {
        let pool = memory_pool().await;
        init_commitment_schema(&pool).await.unwrap();
        init_commitment_schema(&pool).await.unwrap(); // running twice must be harmless

        let columns: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('commitments') ORDER BY cid").fetch_all(&pool).await.unwrap();
        assert_eq!(
            columns,
            vec!["id", "block_id", "on_date", "cue_id", "start_min", "duration_min", "status", "nag_count", "last_nag_at", "started_at", "finished_at", "finished_min"]
        );

        commit(&pool, "c1", "b1", "2026-10-12", "cue1", "planned").await.unwrap();
        let row: (i32, Option<i64>, Option<i64>, Option<i64>, Option<i32>) =
            sqlx::query_as("SELECT nag_count, last_nag_at, started_at, finished_at, finished_min FROM commitments WHERE id = 'c1'").fetch_one(&pool).await.unwrap();
        assert_eq!(row, (0, None, None, None, None));
    }

    #[tokio::test]
    async fn commitments_made_before_blocks_had_lengths_are_kept_with_a_default_length() {
        let pool = memory_pool().await;
        // The table as it was when a cue could hold only one block.
        sqlx::query("CREATE TABLE commitments (id TEXT PRIMARY KEY NOT NULL, block_id TEXT NOT NULL, on_date TEXT NOT NULL, cue_id TEXT NOT NULL, start_min INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('planned', 'nagging', 'started', 'missed')), nag_count INTEGER NOT NULL DEFAULT 0, last_nag_at INTEGER)").execute(&pool).await.unwrap();
        sqlx::query("CREATE UNIQUE INDEX commitments_block_day ON commitments (block_id, on_date)").execute(&pool).await.unwrap();
        sqlx::query("CREATE UNIQUE INDEX commitments_cue_day ON commitments (on_date, cue_id) WHERE status <> 'missed'").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO commitments VALUES ('c1', 'b1', '2026-10-12', 'cue1', 600, 'nagging', 2, 1700000000)").execute(&pool).await.unwrap();

        init_commitment_schema(&pool).await.unwrap();
        init_commitment_schema(&pool).await.unwrap(); // running twice must be harmless

        let row: (String, i32, i32, String, i32, Option<i64>) =
            sqlx::query_as("SELECT block_id, start_min, duration_min, status, nag_count, last_nag_at FROM commitments").fetch_one(&pool).await.unwrap();
        assert_eq!(row, ("b1".into(), 600, 30, "nagging".into(), 2, Some(1_700_000_000)));

        // The new rules apply to the rebuilt table: a cue may hold several blocks, and finished is a status.
        assert!(commit(&pool, "c2", "b2", "2026-10-12", "cue1", "finished").await.is_ok());
        assert!(commit(&pool, "c3", "b1", "2026-10-12", "cue2", "planned").await.is_err()); // still one per block per day
    }

    #[tokio::test]
    async fn a_block_has_at_most_one_commitment_per_day_but_may_have_one_on_another_day() {
        let pool = memory_pool().await;
        init_commitment_schema(&pool).await.unwrap();
        commit(&pool, "c1", "b1", "2026-10-12", "cue1", "planned").await.unwrap();
        assert!(commit(&pool, "c2", "b1", "2026-10-12", "cue2", "planned").await.is_err());
        assert!(commit(&pool, "c3", "b1", "2026-10-13", "cue1", "planned").await.is_ok()); // carried over
    }

    #[tokio::test]
    async fn a_cue_can_hold_a_whole_chain_of_blocks_in_one_day() {
        let pool = memory_pool().await;
        init_commitment_schema(&pool).await.unwrap();
        commit(&pool, "c1", "b1", "2026-10-12", "cue1", "planned").await.unwrap();
        assert!(commit(&pool, "c2", "b2", "2026-10-12", "cue1", "planned").await.is_ok());
        assert!(commit(&pool, "c3", "b3", "2026-10-12", "cue1", "planned").await.is_ok());
    }

    #[tokio::test]
    async fn status_can_only_be_one_of_the_six_states() {
        let pool = memory_pool().await;
        init_commitment_schema(&pool).await.unwrap();
        for (i, ok) in ["planned", "nagging", "started", "finished", "lapsed", "missed"].iter().enumerate() {
            commit(&pool, &format!("c{i}"), &format!("b{i}"), "2026-10-12", "cue1", ok).await.unwrap();
        }
        assert!(commit(&pool, "bad", "bx", "2026-10-12", "cuex", "done").await.is_err());
        assert!(commit(&pool, "bad2", "by", "2026-10-12", "cuey", "").await.is_err());
    }

    async fn old_blocks_pool() -> SqlitePool {
        let pool = memory_pool().await;
        // The schema as it was before blocks had lengths and links.
        sqlx::query("CREATE TABLE focus_blocks (id TEXT PRIMARY KEY NOT NULL, is_completed INTEGER NOT NULL)").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE containers (id TEXT PRIMARY KEY NOT NULL, focus_block_id TEXT NOT NULL, order_index INTEGER NOT NULL, notes TEXT, task_title TEXT NOT NULL, action_trigger TEXT, definition_of_done TEXT, block_type TEXT NOT NULL DEFAULT 'deep', created_on TEXT NOT NULL DEFAULT '', urgency TEXT, apps TEXT)").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO focus_blocks (id, is_completed) VALUES ('b1', 0)").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO containers (id, focus_block_id, order_index, task_title, created_on, urgency) VALUES ('c1', 'b1', 0, 'old', '2026-10-12', 'important')").execute(&pool).await.unwrap();
        pool
    }

    #[tokio::test]
    async fn older_blocks_gain_a_length_a_link_and_a_dismissed_flag_without_losing_anything() {
        let pool = old_blocks_pool().await;
        init_container_schema(&pool).await.unwrap();
        init_container_schema(&pool).await.unwrap(); // running twice must be harmless

        let row: (Option<i32>, Option<String>, Option<String>, Option<String>) =
            sqlx::query_as("SELECT duration_min, parent_kind, parent_id, scheduled_on FROM containers WHERE id = 'c1'").fetch_one(&pool).await.unwrap();
        assert_eq!(row, (None, None, None, None)); // no length, not attached
        let dismissed: i32 = sqlx::query_scalar("SELECT dismissed FROM focus_blocks WHERE id = 'b1'").fetch_one(&pool).await.unwrap();
        assert_eq!(dismissed, 0);
    }

    async fn add_linked(pool: &SqlitePool, n: &str, kind: Option<&str>, parent: Option<&str>, day: Option<&str>) -> Result<(), sqlx::Error> {
        sqlx::query("INSERT INTO focus_blocks (id, is_completed) VALUES ($1, 0)").bind(format!("b{n}")).execute(pool).await?;
        sqlx::query("INSERT INTO containers (id, focus_block_id, order_index, task_title, parent_kind, parent_id, scheduled_on) VALUES ($1, $2, 0, 't', $3, $4, $5)")
            .bind(format!("c{n}"))
            .bind(format!("b{n}"))
            .bind(kind)
            .bind(parent)
            .bind(day)
            .execute(pool)
            .await
            .map(|_| ())
    }

    #[tokio::test]
    async fn only_one_block_may_follow_a_node_on_a_given_day() {
        let pool = memory_pool().await;
        init_container_schema(&pool).await.unwrap();
        add_linked(&pool, "1", Some("cue"), Some("school"), Some("2026-10-12")).await.unwrap();
        assert!(add_linked(&pool, "2", Some("cue"), Some("school"), Some("2026-10-12")).await.is_err()); // second child, same cue and day
        assert!(add_linked(&pool, "3", Some("cue"), Some("school"), Some("2026-10-13")).await.is_ok()); // a cue repeats on other days
        assert!(add_linked(&pool, "4", Some("block"), Some("b1"), Some("2026-10-12")).await.is_ok());
        assert!(add_linked(&pool, "5", Some("block"), Some("b1"), Some("2026-10-12")).await.is_err()); // a block has one next block too
    }

    #[tokio::test]
    async fn blocks_that_are_not_attached_are_not_limited() {
        let pool = memory_pool().await;
        init_container_schema(&pool).await.unwrap();
        for n in ["1", "2", "3"] {
            add_linked(&pool, n, None, None, None).await.unwrap();
        }
    }

    #[tokio::test]
    async fn older_cues_are_not_end_of_day_cues() {
        let pool = memory_pool().await;
        sqlx::query("CREATE TABLE cues (id TEXT PRIMARY KEY NOT NULL, label TEXT NOT NULL, time_min INTEGER NOT NULL, days TEXT NOT NULL, flex_min INTEGER NOT NULL DEFAULT 0)").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO cues VALUES ('a', 'After school', 930, '[1]', 10)").execute(&pool).await.unwrap();
        init_cue_schema(&pool).await.unwrap();
        init_cue_schema(&pool).await.unwrap();
        let ends: i32 = sqlx::query_scalar("SELECT ends_day FROM cues WHERE id = 'a'").fetch_one(&pool).await.unwrap();
        assert_eq!(ends, 0);
    }

    #[tokio::test]
    async fn blocks_saved_before_apps_were_stored_get_no_apps() {
        let pool = memory_pool().await;
        sqlx::query("CREATE TABLE focus_blocks (id TEXT PRIMARY KEY NOT NULL, is_completed INTEGER NOT NULL)").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE containers (id TEXT PRIMARY KEY NOT NULL, focus_block_id TEXT NOT NULL, order_index INTEGER NOT NULL, notes TEXT, task_title TEXT NOT NULL, action_trigger TEXT, definition_of_done TEXT, block_type TEXT NOT NULL DEFAULT 'deep', created_on TEXT NOT NULL DEFAULT '', urgency TEXT)").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO containers (id, focus_block_id, order_index, task_title) VALUES ('c1', 'b1', 0, 'old')").execute(&pool).await.unwrap();

        init_container_schema(&pool).await.unwrap();
        init_container_schema(&pool).await.unwrap();

        let apps: Option<String> = sqlx::query_scalar("SELECT apps FROM containers WHERE id = 'c1'").fetch_one(&pool).await.unwrap();
        assert_eq!(apps, None);
    }

    #[tokio::test]
    async fn a_fresh_database_gets_the_fixed_time_cues_table() {
        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        init_cue_schema(&pool).await.unwrap();
        let columns: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('cues') ORDER BY cid").fetch_all(&pool).await.unwrap();
        assert_eq!(columns, vec!["id", "label", "time_min", "days", "flex_min", "ends_day"]);
    }
}
