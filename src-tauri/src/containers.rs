use crate::db::DbState;
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskItem {
    pub title: String,
    pub action_trigger: Option<String>,
    pub definition_of_done: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Container {
    pub id: String,
    pub focus_block_id: String,
    pub primary_task: TaskItem,
    pub order_index: i32,
    pub notes: Option<String>,
    pub block_type: String,
    pub created_on: String,
}

#[derive(Serialize, Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusBlock {
    pub id: String,
    pub container: Container,
    pub is_completed: bool,
}

#[derive(Debug, sqlx::FromRow)]
struct RawContainerRow {
    id: String,
    focus_block_id: String,
    order_index: i32,
    notes: Option<String>,
    task_title: Option<String>,
    action_trigger: Option<String>,
    definition_of_done: Option<String>,
    block_type: String,
    created_on: String,
}

// A block waiting to be scheduled; the scheduler only needs these four fields.
#[derive(Clone, Debug, PartialEq, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct PendingBlock {
    pub id: String,
    pub block_type: String,
    pub order_index: i32,
    pub title: String,
}

const BLOCK_TYPES: [&str; 4] = ["deep", "routine", "reset", "recharge"];

pub fn validate_block_type(block_type: &str) -> Result<(), String> {
    if BLOCK_TYPES.contains(&block_type) {
        Ok(())
    } else {
        Err(format!("Unknown block type \"{block_type}\"."))
    }
}

// `created_on` is the user's LOCAL calendar date (YYYY-MM-DD) chosen by the UI, so "today"
// means today where the user is, not in UTC. It is only a day key, so month lengths and leap
// years are not checked.
pub fn validate_created_on(created_on: &str) -> Result<(), String> {
    let bytes = created_on.as_bytes();
    let shaped = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes.iter().enumerate().all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit());
    if !shaped {
        return Err("Date must look like YYYY-MM-DD.".into());
    }
    let month: u32 = created_on[5..7].parse().unwrap_or(0);
    let day: u32 = created_on[8..10].parse().unwrap_or(0);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return Err("Date must look like YYYY-MM-DD.".into());
    }
    Ok(())
}

pub async fn create_container_in(
    pool: &sqlx::SqlitePool,
    task: TaskItem,
    mut order_index: i32,
    block_type: String,
    created_on: String,
) -> Result<String, String> {
    validate_block_type(&block_type)?;
    validate_created_on(&created_on)?;

    let main_id = Uuid::new_v4().to_string();
    let container_id = Uuid::new_v4().to_string();

    if order_index < 0 {
        order_index += 1;
    }

    let container = Container {
        id: container_id,
        focus_block_id: main_id.clone(),
        primary_task: task,
        order_index,
        notes: None,
        block_type,
        created_on,
    };

    let new_block = FocusBlock {
        id: main_id,
        container,
        is_completed: false,
    };

    let block_id = new_block.id.clone();
    crate::db::insert_container_in(pool, &new_block).await?;
    Ok(block_id)
}

// Only today's unfinished blocks are scheduled. Older unfinished blocks do not carry over yet.
pub async fn list_pending_blocks_in(
    pool: &sqlx::SqlitePool,
    on: &str,
) -> Result<Vec<PendingBlock>, String> {
    sqlx::query_as::<_, PendingBlock>(
        "SELECT fb.id AS id, c.block_type AS block_type, c.order_index AS order_index, c.task_title AS title
         FROM focus_blocks fb
         JOIN containers c ON c.focus_block_id = fb.id
         WHERE fb.is_completed = 0 AND c.created_on = $1
         ORDER BY c.order_index",
    )
    .bind(on)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())
}

#[cfg(not(target_arch = "wasm32"))]
#[tauri::command]
pub async fn create_container(
    task: TaskItem,
    order_index: i32,
    block_type: String,
    created_on: String,
    db_state: State<'_, DbState>,
) -> Result<String, String> {
    create_container_in(&db_state.pool, task, order_index, block_type, created_on).await
}

#[cfg(not(target_arch = "wasm32"))]
#[tauri::command]
pub async fn list_pending_blocks(
    on: String,
    db_state: State<'_, DbState>,
) -> Result<Vec<PendingBlock>, String> {
    list_pending_blocks_in(&db_state.pool, &on).await
}

#[cfg(not(target_arch = "wasm32"))]
#[tauri::command]
pub async fn fetch_container(state: State<'_, DbState>) -> Result<Option<FocusBlock>, String> {
    let pool = &state.pool;
    let block_id: Option<String> = sqlx::query_scalar::<_, String>(
        "SELECT id FROM focus_blocks WHERE is_completed = 0 LIMIT 1",
    )
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    let target_id = match block_id {
        Some(id) => id,
        None => return Ok(None),
    };

    let row = sqlx::query_as::<_, RawContainerRow>(
        "SELECT id, focus_block_id, order_index, notes, task_title, action_trigger, definition_of_done, block_type, created_on FROM containers WHERE focus_block_id = ? LIMIT 1"
    )
    .bind(&target_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    if let Some(r) = row {
        let container = Container {
            id: r.id,
            focus_block_id: r.focus_block_id,
            primary_task: TaskItem {
                title: r.task_title.unwrap_or_default(),
                action_trigger: r.action_trigger,
                definition_of_done: r.definition_of_done,
            },
            order_index: r.order_index,
            notes: r.notes,
            block_type: r.block_type,
            created_on: r.created_on,
        };

        Ok(Some(FocusBlock {
            id: target_id,
            container,
            is_completed: false,
        }))
    } else {
        Err("Database integrity error: FocusBlock is missing its core container.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::SqlitePool;

    async fn pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::init_container_schema(&pool).await.unwrap();
        pool
    }

    fn task(title: &str) -> TaskItem {
        TaskItem { title: title.into(), action_trigger: None, definition_of_done: None }
    }

    async fn add(pool: &SqlitePool, title: &str, order: i32, kind: &str, on: &str) {
        create_container_in(pool, task(title), order, kind.into(), on.into()).await.unwrap();
    }

    #[test]
    fn block_type_accepts_the_four_kinds_only() {
        for ok in ["deep", "routine", "reset", "recharge"] {
            assert!(validate_block_type(ok).is_ok(), "{ok}");
        }
        for bad in ["", "Deep", "focus", "deep "] {
            assert!(validate_block_type(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn created_on_must_be_a_yyyy_mm_dd_date() {
        assert!(validate_created_on("2026-10-12").is_ok());
        for bad in ["", "2026-1-2", "12/10/2026", "2026-13-01", "2026-10-32", "not-a-date"] {
            assert!(validate_created_on(bad).is_err(), "{bad:?}");
        }
    }

    #[tokio::test]
    async fn pending_blocks_are_limited_to_the_given_day() {
        let pool = pool().await;
        add(&pool, "today", 0, "deep", "2026-10-12").await;
        add(&pool, "yesterday", 1, "deep", "2026-10-11").await;
        let titles: Vec<String> = list_pending_blocks_in(&pool, "2026-10-12").await.unwrap().into_iter().map(|b| b.title).collect();
        assert_eq!(titles, vec!["today"]);
    }

    #[tokio::test]
    async fn pending_blocks_carry_their_type_and_come_back_in_order() {
        let pool = pool().await;
        add(&pool, "second", 1, "routine", "2026-10-12").await;
        add(&pool, "first", 0, "deep", "2026-10-12").await;
        let got = list_pending_blocks_in(&pool, "2026-10-12").await.unwrap();
        let pairs: Vec<(String, String)> = got.into_iter().map(|b| (b.title, b.block_type)).collect();
        assert_eq!(pairs, vec![("first".into(), "deep".into()), ("second".into(), "routine".into())]);
    }

    #[tokio::test]
    async fn creating_a_container_returns_the_id_of_the_new_block() {
        let pool = pool().await;
        let id = create_container_in(&pool, task("x"), 0, "deep".into(), "2026-10-12".into()).await.unwrap();
        let pending = list_pending_blocks_in(&pool, "2026-10-12").await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, id);
    }

    #[tokio::test]
    async fn completed_blocks_are_not_pending() {
        let pool = pool().await;
        add(&pool, "done", 0, "deep", "2026-10-12").await;
        sqlx::query("UPDATE focus_blocks SET is_completed = 1").execute(&pool).await.unwrap();
        assert!(list_pending_blocks_in(&pool, "2026-10-12").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn invalid_input_is_rejected_and_nothing_is_stored() {
        let pool = pool().await;
        assert!(create_container_in(&pool, task("x"), 0, "nope".into(), "2026-10-12".into()).await.is_err());
        assert!(create_container_in(&pool, task("x"), 0, "deep".into(), "bad".into()).await.is_err());
        assert!(list_pending_blocks_in(&pool, "2026-10-12").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn rows_from_before_the_migration_never_count_as_today() {
        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        // The schema as it was before block_type / created_on existed.
        sqlx::query("CREATE TABLE focus_blocks (id TEXT PRIMARY KEY NOT NULL, is_completed INTEGER NOT NULL)").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE containers (id TEXT PRIMARY KEY NOT NULL, focus_block_id TEXT NOT NULL, order_index INTEGER NOT NULL, notes TEXT, task_title TEXT NOT NULL, action_trigger TEXT, definition_of_done TEXT)").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO focus_blocks (id, is_completed) VALUES ('b1', 0)").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO containers (id, focus_block_id, order_index, task_title) VALUES ('c1', 'b1', 0, 'old')").execute(&pool).await.unwrap();

        crate::db::init_container_schema(&pool).await.unwrap();
        crate::db::init_container_schema(&pool).await.unwrap(); // running twice must be harmless

        assert!(list_pending_blocks_in(&pool, "2026-10-12").await.unwrap().is_empty());
        add(&pool, "new", 1, "deep", "2026-10-12").await;
        assert_eq!(list_pending_blocks_in(&pool, "2026-10-12").await.unwrap().len(), 1);
    }
}
