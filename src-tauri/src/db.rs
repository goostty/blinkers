use crate::containers::FocusBlock;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use std::str::FromStr;
use std::time::Duration;
use tauri::State;

pub struct DbState {
    pub pool: SqlitePool,
}

pub async fn db_init() -> Result<DbState, Box<dyn std::error::Error>> {
    let connection_options = SqliteConnectOptions::from_str("sqlite://blinkers.db")?
        .create_if_missing(true)
        .busy_timeout(Duration::from_secs(5));

    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(connection_options)
        .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS focus_blocks (
            id TEXT PRIMARY KEY NOT NULL,
            is_completed INTEGER NOT NULL
        );",
    )
    .execute(&pool)
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
    .execute(&pool)
    .await?;

    Ok(DbState { pool })
}

pub async fn insert_container(
    db_state: State<'_, DbState>,
    focus_block: &FocusBlock,
) -> Result<(), String> {
    let mut tx = db_state.pool.begin().await.map_err(|e| e.to_string())?;

    sqlx::query("INSERT INTO focus_blocks (id, is_completed) VALUES ($1, $2)")
        .bind(&focus_block.id)
        .bind(focus_block.is_completed as i32)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

    let container = &focus_block.container;

    sqlx::query(
        "INSERT INTO containers (id, focus_block_id, order_index, notes, task_title, action_trigger, definition_of_done)
        VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(&container.id)
    .bind(&focus_block.id)
    .bind(container.order_index)
    .bind(&container.notes)
    .bind(&container.primary_task.title)
    .bind(&container.primary_task.action_trigger)
    .bind(&container.primary_task.definition_of_done)
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
