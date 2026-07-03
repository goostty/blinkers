use crate::containers::FocusBlock;
use sqlx::sqlite::{SqlitePoolOptions, SqliteConnectOptions, SqlitePool};
use tauri::State;
use std::str::FromStr;
use std::time::Duration;

pub struct DbState {
    pub pool: SqlitePool,
}

pub async fn db_init() -> Result<DbState, Box<dyn std::error::Error>> { 

    let connection_options = SqliteConnectOptions::from_str("sqlite://blinkers.db")?
    .create_if_missing(true)
    .busy_timeout(Duration::from_secs(5));

    // 3. Connect to the SQLite instance (creates file if missing)
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(connection_options)
        .await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS focus_blocks (
            id TEXT PRIMARY KEY NOT NULL,
            is_completed INTEGER NOT NULL
        );" 
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS containers (
            id TEXT PRIMARY KEY NOT NULL,
            focus_block_id TEXT NOT NULL,
            container_type TEXT NOT NULL,
            order_index INTEGER NOT NULL,
            notes TEXT,
            setup_tasks TEXT,     
            primary_tasks TEXT,    
            backup_tasks TEXT,     
            break_tasks TEXT
        );"
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

    // 2. Insert the parent FocusBlock metadata
    sqlx::query("INSERT INTO focus_blocks (id, is_completed) VALUES ($1, $2)")
        .bind(&focus_block.id)
        .bind(focus_block.is_completed as i32)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

    let containers = [
        &focus_block.setup_container,
        &focus_block.work_container,
        &focus_block.break_container,
    ];

    for container in containers {
        let serialized_type = serde_json::to_string(&container.container_type)
            .map_err(|e| e.to_string())?;
        sqlx::query(
            "INSERT INTO containers (id, focus_block_id, container_type, order_index, notes)
            VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(&container.id)
        .bind(&focus_block.id)
        .bind(serialized_type)
        .bind(container.order_index)
        .bind(&container.notes)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub async fn get_next_order_index(pool: tauri::State<'_, sqlx::SqlitePool>) -> Result<i32, String> {
    // 1. Execute query and store the raw result in a variable
    let max_index: i32 = sqlx::query_scalar::<_, i32>("SELECT COALESCE(MAX(order_index), -1) as \"order_index: i32\" FROM containers")
        .fetch_one(&*pool)
        .await
        .map_err(|e| e.to_string())?;

    // 2. Return the next index in line
    Ok(max_index + 1)
}
