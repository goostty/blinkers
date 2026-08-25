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
}

#[cfg(not(target_arch = "wasm32"))]
#[tauri::command]
pub async fn create_container(
    task: TaskItem,
    mut order_index: i32,
    db_state: State<'_, DbState>,
) -> Result<(), String> {
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
    };

    let new_block = FocusBlock {
        id: main_id,
        container,
        is_completed: false,
    };

    crate::db::insert_container(db_state, &new_block).await?;
    Ok(())
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
        "SELECT id, focus_block_id, order_index, notes, task_title, action_trigger, definition_of_done FROM containers WHERE focus_block_id = ? LIMIT 1"
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
