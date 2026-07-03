use crate::db;
use crate::db::DbState;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use tauri::State;
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LifeAnchor {
    pub anchor_id: i32,
    pub anchor_name: String,
    pub time_window: String
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ContainerType {
    Setup {
        setup_tasks: VecDeque<String>,
    },
    Work {
        primary_tasks: VecDeque<String>,
        backup_tasks: VecDeque<String>,
    },
    Break {
        break_tasks: VecDeque<String>,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Container {
    pub id: String,
    pub focus_block_id: String,
    pub container_type: ContainerType,
    pub order_index: i32,
    pub notes: Option<String>
}

#[derive(Serialize, Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusBlock {
    pub id : String,
    pub setup_container : Container,
    pub work_container : Container,
    pub break_container : Container,
    pub is_completed : bool
}

#[derive(Debug, sqlx::FromRow)] // Allows SQLx to automatically map columns to this struct
struct RawContainerRow {
    id: String,
    focus_block_id: String,
    container_type: String, 
    order_index: i32,
    notes: Option<String>,
    setup_tasks: Option<String>,
    primary_tasks: Option<String>,
    backup_tasks: Option<String>,
    break_tasks: Option<String>,
}

#[cfg(not(target_arch = "wasm32"))]
#[tauri::command]
pub async fn create_container(
    setup: VecDeque<String>,
    tasks: VecDeque<String>,
    breaks: VecDeque<String>,
    mut order_index: i32,
    db_state: State<'_, DbState>,
) -> Result<(), String> { 
    
    // Create the IDs of all containers
    let main_id = Uuid::new_v4().to_string();
    let setup_id = Uuid::new_v4().to_string();
    let work_id = Uuid::new_v4().to_string();
    let break_id = Uuid::new_v4().to_string();

    if order_index < 0 {
        order_index += 1;
    }

    // Create Setup Container
    let container_setup = Container {
        id: setup_id,
        focus_block_id: main_id.clone(),
        container_type: ContainerType::Setup {
            setup_tasks: setup
        },
        order_index: order_index,
        notes: None
    };

    order_index += 1;

    // Create Work Container
    let container_work = Container {
        id: work_id,
        focus_block_id: main_id.clone(),
        container_type: ContainerType::Work {
            primary_tasks: tasks,
            backup_tasks: VecDeque::new()
        },
        order_index: order_index,
        notes: None
    };

    order_index += 1;

    // Create Break Container
    let container_break = Container {
        id: break_id,
        focus_block_id: main_id.clone(),
        container_type: ContainerType::Break {
            break_tasks: breaks
        },
        order_index: order_index,
        notes: None
    };
    
    // Create The New FocusBlock
    let newblock = FocusBlock {
        id: main_id,
        setup_container: container_setup,   
        work_container: container_work,
        break_container: container_break,
        is_completed: false
    };
    db::insert_container(db_state, &newblock).await?;
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
#[tauri::command]
pub async fn fetch_container(state: tauri::State<'_, DbState>) -> Result<Option<FocusBlock>, String> {
    let pool = &state.pool; 
    let block_id: Option<String> = sqlx::query_scalar::<_, String>(
        "SELECT id FROM focus_blocks WHERE is_completed = 0 LIMIT 1"
    )
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    let target_id = match block_id {
        Some(id) => id,
        None => return Ok(None), // No pending focus blocks left!
    };

    // 2. Fetch all 3 containers belonging to this specific focus block
    let rows = sqlx::query_as::<_, RawContainerRow>(
        "SELECT id, focus_block_id, container_type, notes, order_index FROM containers WHERE focus_block_id = ? ORDER BY order_index ASC"
    )
    .bind(&target_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
   

    // 3. Initialize placeholders for the three containers
    let mut setup_container: Option<Container> = None;
    let mut work_container: Option<Container> = None;
    let mut break_container: Option<Container> = None;

    for row in rows {
        // Map the string column back to your rich enum types
        let c_type = match row.container_type.as_str() {
            "Setup" => ContainerType::Setup { 
                setup_tasks: VecDeque::new() // Parse your actual JSON string array here if applicable
            },
            "Work" => ContainerType::Work { 
                primary_tasks: VecDeque::new(), 
                backup_tasks: VecDeque::new() 
            },
            "Break" => ContainerType::Break { 
                break_tasks: VecDeque::new() 
            },
            _ => return Err(format!("Unknown container type: {}", row.container_type)),
        };

        let container = Container {
            id: row.id,
            focus_block_id: row.focus_block_id,
            container_type: c_type,
            order_index: row.order_index,
            notes: row.notes,
        };

        match container.container_type {
            ContainerType::Setup { .. } => setup_container = Some(container),
            ContainerType::Work { .. } => work_container = Some(container),
            ContainerType::Break { .. } => break_container = Some(container),
        }
    }

    // 5. Build and return the final FocusBlock
    if let (Some(setup), Some(work), Some(r#break)) = (setup_container, work_container, break_container) {
        Ok(Some(FocusBlock {
            id: target_id,
            setup_container: setup,
            work_container: work,
            break_container: r#break,
            is_completed: false,
        }))
    } else {
        Err("Database integrity error: FocusBlock is missing one of its 3 core containers.".to_string())
    }
}
