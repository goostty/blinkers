use crate::containers::{apps_from_json, dismiss_block_in, validate_created_on, AppEntry};
use crate::db::DbState;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use tauri::State;
use uuid::Uuid;

const MINUTES_PER_DAY: i32 = 1440;

// A block can only be finished early once half of the length the user entered has passed since
// they pressed Start. Mirrors FINISH_FRACTION in src/finish.ts.
const FINISH_FRACTION: f64 = 0.5;

// One block's place in today's timeline. `start_min` is minutes since local midnight and
// `duration_min` is the length the user entered.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedBlock {
    pub block_id: String,
    pub cue_id: String,
    pub start_min: i32,
    pub duration_min: i32,
}

#[derive(Clone, Debug, PartialEq, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Commitment {
    pub id: String,
    pub block_id: String,
    pub on_date: String,
    pub cue_id: String,
    pub start_min: i32,
    pub duration_min: i32,
    pub status: String,
    pub nag_count: i32,
    pub last_nag_at: Option<i64>,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub finished_min: Option<i32>,
}

// Everything needed to begin a block: what to show and what to open.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartedBlock {
    pub title: String,
    pub action_trigger: Option<String>,
    pub definition_of_done: Option<String>,
    pub apps: Vec<AppEntry>,
}

#[derive(Debug, sqlx::FromRow)]
struct BlockDetails {
    task_title: String,
    action_trigger: Option<String>,
    definition_of_done: Option<String>,
    apps: Option<String>,
}

// Replaces the day's plan with the latest one, but only where that is still safe. Once a reminder
// has gone out (nagging), the user has acted (started, finished, lapsed) or the day moved on
// (missed), moving the block would make the phone and the app disagree, so those rows are frozen:
// they are kept as they are and the plan's entry for them is ignored. Everything still `planned`
// is deleted and rewritten, which also lets blocks swap places in one go. It all happens in one
// transaction, so a plan that cannot be stored leaves the old one untouched.
pub async fn sync_commitments_in(
    pool: &sqlx::SqlitePool,
    on: &str,
    plan: Vec<PlannedBlock>,
) -> Result<(), String> {
    validate_created_on(on)?;

    let mut seen = HashSet::new();
    for p in &plan {
        if !(0..MINUTES_PER_DAY).contains(&p.start_min) {
            return Err(format!("Start time {} is outside the day.", p.start_min));
        }
        if !(1..=MINUTES_PER_DAY).contains(&p.duration_min) {
            return Err(format!("Length {} is not between 1 and {MINUTES_PER_DAY} minutes.", p.duration_min));
        }
        if !seen.insert(p.block_id.as_str()) {
            return Err(format!("Block {} is planned twice.", p.block_id));
        }
    }

    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;

    let frozen: HashSet<String> = sqlx::query_scalar::<_, String>(
        "SELECT block_id FROM commitments WHERE on_date = $1 AND status <> 'planned'",
    )
    .bind(on)
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| e.to_string())?
    .into_iter()
    .collect();

    sqlx::query("DELETE FROM commitments WHERE on_date = $1 AND status = 'planned'")
        .bind(on)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

    for p in plan.iter().filter(|p| !frozen.contains(&p.block_id)) {
        sqlx::query(
            "INSERT INTO commitments (id, block_id, on_date, cue_id, start_min, duration_min, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'planned')",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&p.block_id)
        .bind(on)
        .bind(&p.cue_id)
        .bind(p.start_min)
        .bind(p.duration_min)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    }

    tx.commit().await.map_err(|e| e.to_string())
}

// Pressing Start is the commitment: it stops the reminders and records when the user began, which
// is what the 50% rule for finishing measures from. The block's details come back so the UI can
// show the first step and open its apps. Starting a block that is already started succeeds
// again, so a double tap still opens everything, and keeps the original start time. A missed,
// lapsed or finished commitment cannot be started: its time is over.
pub async fn start_block_in(
    pool: &sqlx::SqlitePool,
    block_id: &str,
    on: &str,
    now_unix: i64,
) -> Result<StartedBlock, String> {
    validate_created_on(on)?;

    let moved = sqlx::query(
        "UPDATE commitments SET status = 'started', started_at = $3
         WHERE block_id = $1 AND on_date = $2 AND status IN ('planned', 'nagging')",
    )
    .bind(block_id)
    .bind(on)
    .bind(now_unix)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    if moved.rows_affected() == 0 {
        let status: Option<String> =
            sqlx::query_scalar("SELECT status FROM commitments WHERE block_id = $1 AND on_date = $2")
                .bind(block_id)
                .bind(on)
                .fetch_optional(pool)
                .await
                .map_err(|e| e.to_string())?;
        match status.as_deref() {
            Some("started") => {}
            Some(_) => return Err("That reminder has expired.".into()),
            None => return Err("No reminder is scheduled for that block today.".into()),
        }
    }

    started_block(pool, block_id).await
}

// What the UI needs once a block has begun: its title, first step and the apps to open.
async fn started_block(pool: &sqlx::SqlitePool, block_id: &str) -> Result<StartedBlock, String> {
    let details = sqlx::query_as::<_, BlockDetails>(
        "SELECT task_title, action_trigger, definition_of_done, apps FROM containers WHERE focus_block_id = $1",
    )
    .bind(block_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "Database integrity error: that block has no container.".to_string())?;

    Ok(StartedBlock {
        title: details.task_title,
        action_trigger: details.action_trigger,
        definition_of_done: details.definition_of_done,
        apps: apps_from_json(details.apps.as_deref()),
    })
}

// Continue is what a missed block gets when the user decides to do it after all: it starts right
// now. The commitment becomes a `started` one whose start is this moment (both the real time and
// the minute of the day), so it is a fact like any other started block and the blocks behind it
// are laid out from here. Only a missed block can be continued, and one that was dropped cannot.
// Continuing twice succeeds again and keeps the first start, as Start does.
pub async fn continue_block_in(
    pool: &sqlx::SqlitePool,
    block_id: &str,
    on: &str,
    now_unix: i64,
    now_min: i32,
) -> Result<StartedBlock, String> {
    validate_created_on(on)?;
    if !(0..MINUTES_PER_DAY).contains(&now_min) {
        return Err(format!("Minute {now_min} is outside the day."));
    }

    let dropped: Option<bool> = sqlx::query_scalar("SELECT dismissed FROM focus_blocks WHERE id = $1")
        .bind(block_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    if dropped == Some(true) {
        return Err("That block was dropped.".into());
    }

    let moved = sqlx::query(
        "UPDATE commitments SET status = 'started', started_at = $3, start_min = $4
         WHERE block_id = $1 AND on_date = $2 AND status = 'missed'",
    )
    .bind(block_id)
    .bind(on)
    .bind(now_unix)
    .bind(now_min)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    if moved.rows_affected() == 0 {
        let status: Option<String> =
            sqlx::query_scalar("SELECT status FROM commitments WHERE block_id = $1 AND on_date = $2")
                .bind(block_id)
                .bind(on)
                .fetch_optional(pool)
                .await
                .map_err(|e| e.to_string())?;
        match status.as_deref() {
            Some("started") => {}
            Some(_) => return Err("Only a missed block can be continued.".into()),
            None => return Err("No reminder is scheduled for that block today.".into()),
        }
    }

    started_block(pool, block_id).await
}

#[derive(Debug, sqlx::FromRow)]
struct FinishState {
    status: String,
    started_at: Option<i64>,
    duration_min: i32,
}

// Finish completes the block, but only for someone who has really been at it: the time since
// they pressed Start must reach half of the length they entered (not the planned start, so
// starting late changes nothing). It records the minute of the day so that the blocks after this
// one can be pulled forward, and marks the block completed so it stops carrying over. Finishing
// twice succeeds again and changes nothing. Nothing is half-done: both rows change or neither.
pub async fn finish_block_in(
    pool: &sqlx::SqlitePool,
    block_id: &str,
    on: &str,
    now_unix: i64,
    now_min: i32,
) -> Result<(), String> {
    validate_created_on(on)?;
    if !(0..MINUTES_PER_DAY).contains(&now_min) {
        return Err(format!("Minute {now_min} is outside the day."));
    }

    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;

    let state = sqlx::query_as::<_, FinishState>(
        "SELECT status, started_at, duration_min FROM commitments WHERE block_id = $1 AND on_date = $2",
    )
    .bind(block_id)
    .bind(on)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| e.to_string())?
    .ok_or("No reminder is scheduled for that block today.")?;

    match state.status.as_str() {
        "finished" => return Ok(()),
        "started" => {}
        "planned" | "nagging" => return Err("Start the block before finishing it.".into()),
        _ => return Err("That block's time is over.".into()),
    }

    let started_at = state.started_at.ok_or("Database integrity error: a started block has no start time.")?;
    let needed = (f64::from(state.duration_min) * 60.0 * FINISH_FRACTION).ceil() as i64;
    let elapsed = (now_unix - started_at).max(0);
    if elapsed < needed {
        let wait_min = (needed - elapsed + 59) / 60;
        return Err(format!("Too early to finish: keep going for {wait_min} more minute(s)."));
    }

    sqlx::query(
        "UPDATE commitments SET status = 'finished', finished_at = $3, finished_min = $4
         WHERE block_id = $1 AND on_date = $2",
    )
    .bind(block_id)
    .bind(on)
    .bind(now_unix)
    .bind(now_min)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;

    sqlx::query("UPDATE focus_blocks SET is_completed = 1 WHERE id = $1")
        .bind(block_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

    tx.commit().await.map_err(|e| e.to_string())
}

// A started block whose time ran out without Finish. It does not carry over: it is dropped, so
// the chain closes up around it. The commitment row stays as `lapsed`, which is how "they
// committed but did not finish" is remembered. Only a started block can lapse; one that was
// never started is `missed`, a different thing.
pub async fn lapse_block_in(pool: &sqlx::SqlitePool, block_id: &str, on: &str) -> Result<(), String> {
    validate_created_on(on)?;

    let moved = sqlx::query(
        "UPDATE commitments SET status = 'lapsed' WHERE block_id = $1 AND on_date = $2 AND status = 'started'",
    )
    .bind(block_id)
    .bind(on)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    if moved.rows_affected() == 0 {
        return Err("Only a block that was started can lapse.".into());
    }
    dismiss_block_in(pool, block_id).await
}

pub async fn list_commitments_in(pool: &sqlx::SqlitePool, on: &str) -> Result<Vec<Commitment>, String> {
    validate_created_on(on)?;
    sqlx::query_as::<_, Commitment>(
        "SELECT id, block_id, on_date, cue_id, start_min, duration_min, status, nag_count, last_nag_at,
                started_at, finished_at, finished_min
         FROM commitments WHERE on_date = $1 ORDER BY start_min, id",
    )
    .bind(on)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())
}

#[cfg(not(target_arch = "wasm32"))]
#[tauri::command]
pub async fn sync_commitments(
    on: String,
    plan: Vec<PlannedBlock>,
    db_state: State<'_, DbState>,
) -> Result<(), String> {
    sync_commitments_in(&db_state.pool, &on, plan).await
}

#[cfg(not(target_arch = "wasm32"))]
#[tauri::command]
pub async fn start_block(
    block_id: String,
    on: String,
    now_unix: i64,
    db_state: State<'_, DbState>,
) -> Result<StartedBlock, String> {
    start_block_in(&db_state.pool, &block_id, &on, now_unix).await
}

#[cfg(not(target_arch = "wasm32"))]
#[tauri::command]
pub async fn continue_block(
    block_id: String,
    on: String,
    now_unix: i64,
    now_min: i32,
    db_state: State<'_, DbState>,
) -> Result<StartedBlock, String> {
    continue_block_in(&db_state.pool, &block_id, &on, now_unix, now_min).await
}

#[cfg(not(target_arch = "wasm32"))]
#[tauri::command]
pub async fn finish_block(
    block_id: String,
    on: String,
    now_unix: i64,
    now_min: i32,
    db_state: State<'_, DbState>,
) -> Result<(), String> {
    finish_block_in(&db_state.pool, &block_id, &on, now_unix, now_min).await
}

#[cfg(not(target_arch = "wasm32"))]
#[tauri::command]
pub async fn lapse_block(block_id: String, on: String, db_state: State<'_, DbState>) -> Result<(), String> {
    lapse_block_in(&db_state.pool, &block_id, &on).await
}

#[cfg(not(target_arch = "wasm32"))]
#[tauri::command]
pub async fn list_commitments(
    on: String,
    db_state: State<'_, DbState>,
) -> Result<Vec<Commitment>, String> {
    list_commitments_in(&db_state.pool, &on).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::containers::{
        create_container_in, list_day_blocks_in, NewBlock, ParentRef, TaskItem,
    };
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::SqlitePool;

    const DAY: &str = "2026-10-12";
    const START: i64 = 1_700_000_000;

    async fn pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        crate::db::init_container_schema(&pool).await.unwrap();
        crate::db::init_cue_schema(&pool).await.unwrap();
        crate::db::init_commitment_schema(&pool).await.unwrap();
        pool
    }

    async fn make(pool: &SqlitePool, title: &str, duration_min: i32, parent: Option<ParentRef>, apps: Vec<AppEntry>) -> String {
        let parent = match parent {
            Some(p) => p,
            None => {
                let id = Uuid::new_v4().to_string();
                sqlx::query("INSERT INTO cues (id, label, time_min, days, flex_min, ends_day) VALUES ($1, $1, 600, '[0,1,2,3,4,5,6]', 0, 0)")
                    .bind(&id)
                    .execute(pool)
                    .await
                    .unwrap();
                ParentRef { kind: "cue".into(), id }
            }
        };
        let task = TaskItem { title: title.into(), action_trigger: Some(format!("open {title}")), definition_of_done: Some(format!("{title} done")) };
        let new = NewBlock {
            task,
            order_index: 0,
            block_type: "deep".into(),
            urgency: Some("important".into()),
            apps,
            duration_min,
            parent: Some(parent),
            created_on: DAY.into(),
        };
        create_container_in(pool, new).await.unwrap()
    }

    async fn block(pool: &SqlitePool, title: &str) -> String {
        make(pool, title, 30, None, vec![]).await
    }

    fn plan(block_id: &str, cue_id: &str, start_min: i32) -> PlannedBlock {
        PlannedBlock { block_id: block_id.into(), cue_id: cue_id.into(), start_min, duration_min: 30 }
    }

    async fn set_status(pool: &SqlitePool, block_id: &str, status: &str) {
        sqlx::query("UPDATE commitments SET status = $1 WHERE block_id = $2").bind(status).bind(block_id).execute(pool).await.unwrap();
    }

    // (block, cue, status) ordered by cue: block ids are random UUIDs, so ordering by them would
    // make the expected lists below pass or fail by chance.
    async fn cues_by_block(pool: &SqlitePool, on: &str) -> Vec<(String, String, String)> {
        let mut rows: Vec<(String, String, String)> = list_commitments_in(pool, on).await.unwrap().into_iter().map(|c| (c.block_id, c.cue_id, c.status)).collect();
        rows.sort_by(|x, y| x.1.cmp(&y.1));
        rows
    }

    async fn one(pool: &SqlitePool, block_id: &str) -> Commitment {
        list_commitments_in(pool, DAY).await.unwrap().into_iter().find(|c| c.block_id == block_id).unwrap()
    }

    // ----- what crosses to and from the frontend -----

    // src/dayPlan.ts sends PlannedBlock and src/ reads Commitment with exactly these names.
    #[test]
    fn the_plan_the_frontend_sends_is_read_by_its_camel_case_names() {
        let json = r#"[{"blockId":"b","cueId":"c","startMin":600,"durationMin":45}]"#;
        let plan: Vec<PlannedBlock> = serde_json::from_str(json).unwrap();
        assert_eq!(plan, vec![PlannedBlock { block_id: "b".into(), cue_id: "c".into(), start_min: 600, duration_min: 45 }]);
    }

    #[test]
    fn a_commitment_is_sent_to_the_frontend_with_camel_case_names() {
        let c = Commitment {
            id: "i".into(),
            block_id: "b".into(),
            on_date: "2026-10-12".into(),
            cue_id: "c".into(),
            start_min: 600,
            duration_min: 30,
            status: "planned".into(),
            nag_count: 0,
            last_nag_at: None,
            started_at: None,
            finished_at: None,
            finished_min: None,
        };
        let json = serde_json::to_value(&c).unwrap();
        let mut keys: Vec<&str> = json.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec!["blockId", "cueId", "durationMin", "finishedAt", "finishedMin", "id", "lastNagAt", "nagCount", "onDate", "startMin", "startedAt", "status"]
        );
    }

    // ----- syncing the plan -----

    #[tokio::test]
    async fn syncing_stores_the_plan_with_lengths_in_start_order() {
        let pool = pool().await;
        let (a, b) = (block(&pool, "a").await, block(&pool, "b").await);
        let mut second = plan(&b, "cue2", 900);
        second.duration_min = 45;
        sync_commitments_in(&pool, DAY, vec![second, plan(&a, "cue1", 600)]).await.unwrap();

        let got = list_commitments_in(&pool, DAY).await.unwrap();
        assert_eq!(got.iter().map(|c| (c.block_id.as_str(), c.start_min, c.duration_min)).collect::<Vec<_>>(), vec![(a.as_str(), 600, 30), (b.as_str(), 900, 45)]);
        assert!(got.iter().all(|c| c.status == "planned" && c.nag_count == 0 && c.last_nag_at.is_none() && c.started_at.is_none() && c.on_date == DAY));
    }

    #[tokio::test]
    async fn several_blocks_can_share_a_cue_because_a_cue_holds_a_chain() {
        let pool = pool().await;
        let (a, b) = (block(&pool, "a").await, block(&pool, "b").await);
        sync_commitments_in(&pool, DAY, vec![plan(&a, "cue1", 600), plan(&b, "cue1", 630)]).await.unwrap();
        assert_eq!(list_commitments_in(&pool, DAY).await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn syncing_again_replaces_the_previous_plan() {
        let pool = pool().await;
        let (a, b) = (block(&pool, "a").await, block(&pool, "b").await);
        sync_commitments_in(&pool, DAY, vec![plan(&a, "cue1", 600), plan(&b, "cue2", 900)]).await.unwrap();
        sync_commitments_in(&pool, DAY, vec![plan(&a, "cue2", 900)]).await.unwrap();

        assert_eq!(cues_by_block(&pool, DAY).await, vec![(a, "cue2".into(), "planned".into())]);
    }

    #[tokio::test]
    async fn a_block_pulled_forward_by_an_early_finish_gets_its_new_start_time() {
        let pool = pool().await;
        let b = block(&pool, "b").await;
        sync_commitments_in(&pool, DAY, vec![plan(&b, "cue1", 960)]).await.unwrap();
        sync_commitments_in(&pool, DAY, vec![plan(&b, "cue1", 930)]).await.unwrap();
        assert_eq!(one(&pool, &b).await.start_min, 930);
    }

    #[tokio::test]
    async fn commitments_that_were_already_acted_on_are_never_rewritten() {
        let pool = pool().await;
        let ids = [block(&pool, "a").await, block(&pool, "b").await, block(&pool, "c").await, block(&pool, "d").await, block(&pool, "e").await, block(&pool, "f").await];
        let original: Vec<PlannedBlock> = ids.iter().enumerate().map(|(i, id)| plan(id, &format!("cue{i}"), 600 + i as i32 * 10)).collect();
        sync_commitments_in(&pool, DAY, original.clone()).await.unwrap();
        for (id, status) in ids.iter().zip(["nagging", "started", "finished", "lapsed", "missed"]) {
            set_status(&pool, id, status).await;
        }

        // The new plan tries to move all of them; only the still-planned one may move.
        let moved: Vec<PlannedBlock> = ids.iter().map(|id| plan(id, "cue9", 100)).collect();
        sync_commitments_in(&pool, DAY, moved).await.unwrap();

        let got = list_commitments_in(&pool, DAY).await.unwrap();
        for (i, id) in ids.iter().enumerate() {
            let c = got.iter().find(|c| &c.block_id == id).unwrap();
            if i < 5 {
                assert_eq!((c.cue_id.as_str(), c.start_min), (original[i].cue_id.as_str(), original[i].start_min), "block {i} must not move");
            } else {
                assert_eq!((c.cue_id.as_str(), c.start_min, c.status.as_str()), ("cue9", 100, "planned"));
            }
        }
    }

    #[tokio::test]
    async fn planned_commitments_not_in_the_new_plan_are_removed_but_frozen_ones_stay() {
        let pool = pool().await;
        let (a, b) = (block(&pool, "a").await, block(&pool, "b").await);
        sync_commitments_in(&pool, DAY, vec![plan(&a, "cue1", 600), plan(&b, "cue2", 700)]).await.unwrap();
        set_status(&pool, &a, "nagging").await;

        sync_commitments_in(&pool, DAY, vec![]).await.unwrap();

        assert_eq!(cues_by_block(&pool, DAY).await, vec![(a, "cue1".into(), "nagging".into())]);
    }

    #[tokio::test]
    async fn syncing_one_day_leaves_other_days_alone() {
        let pool = pool().await;
        let a = block(&pool, "a").await;
        sync_commitments_in(&pool, "2026-10-11", vec![plan(&a, "cue1", 600)]).await.unwrap();
        sync_commitments_in(&pool, DAY, vec![]).await.unwrap();

        assert_eq!(cues_by_block(&pool, "2026-10-11").await.len(), 1);
        assert!(cues_by_block(&pool, DAY).await.is_empty());
    }

    #[tokio::test]
    async fn a_carried_over_block_gets_a_fresh_commitment_next_day_and_keeps_yesterdays() {
        let pool = pool().await;
        let a = block(&pool, "a").await;
        sync_commitments_in(&pool, "2026-10-11", vec![plan(&a, "cue1", 600)]).await.unwrap();
        set_status(&pool, &a, "missed").await;

        sync_commitments_in(&pool, DAY, vec![plan(&a, "cue1", 600)]).await.unwrap();

        assert_eq!(cues_by_block(&pool, "2026-10-11").await, vec![(a.clone(), "cue1".into(), "missed".into())]);
        assert_eq!(cues_by_block(&pool, DAY).await, vec![(a, "cue1".into(), "planned".into())]);
    }

    #[tokio::test]
    async fn bad_input_is_refused_and_the_existing_plan_survives() {
        let pool = pool().await;
        let (a, b) = (block(&pool, "a").await, block(&pool, "b").await);
        sync_commitments_in(&pool, DAY, vec![plan(&a, "cue1", 600)]).await.unwrap();

        let mut zero = plan(&b, "cue2", 700);
        zero.duration_min = 0;
        let mut huge = plan(&b, "cue2", 700);
        huge.duration_min = 1441;
        assert!(sync_commitments_in(&pool, "tomorrow", vec![plan(&b, "cue2", 700)]).await.is_err());
        assert!(sync_commitments_in(&pool, DAY, vec![plan(&b, "cue2", -1)]).await.is_err());
        assert!(sync_commitments_in(&pool, DAY, vec![plan(&b, "cue2", 1440)]).await.is_err());
        assert!(sync_commitments_in(&pool, DAY, vec![zero]).await.is_err());
        assert!(sync_commitments_in(&pool, DAY, vec![huge]).await.is_err());
        assert!(sync_commitments_in(&pool, DAY, vec![plan(&b, "cue2", 700), plan(&b, "cue3", 800)]).await.is_err());

        assert_eq!(cues_by_block(&pool, DAY).await, vec![(a, "cue1".into(), "planned".into())]);
    }

    // ----- starting -----

    #[tokio::test]
    async fn starting_a_planned_block_commits_to_it_and_returns_what_it_needs() {
        let pool = pool().await;
        let apps = vec![AppEntry { label: "Docs".into(), url: "https://example.com".into(), icon: None }];
        let a = make(&pool, "write", 30, None, apps.clone()).await;
        sync_commitments_in(&pool, DAY, vec![plan(&a, "cue1", 600)]).await.unwrap();

        let started = start_block_in(&pool, &a, DAY, START).await.unwrap();

        assert_eq!(started, StartedBlock { title: "write".into(), action_trigger: Some("open write".into()), definition_of_done: Some("write done".into()), apps });
        let c = one(&pool, &a).await;
        assert_eq!((c.status.as_str(), c.started_at), ("started", Some(START)));
    }

    #[tokio::test]
    async fn a_block_with_no_apps_starts_with_an_empty_list() {
        let pool = pool().await;
        let a = block(&pool, "a").await;
        sync_commitments_in(&pool, DAY, vec![plan(&a, "cue1", 600)]).await.unwrap();
        assert!(start_block_in(&pool, &a, DAY, START).await.unwrap().apps.is_empty());
    }

    #[tokio::test]
    async fn a_nagging_block_can_be_started() {
        let pool = pool().await;
        let a = block(&pool, "a").await;
        sync_commitments_in(&pool, DAY, vec![plan(&a, "cue1", 600)]).await.unwrap();
        set_status(&pool, &a, "nagging").await;
        start_block_in(&pool, &a, DAY, START).await.unwrap();
        assert_eq!(one(&pool, &a).await.status, "started");
    }

    #[tokio::test]
    async fn starting_twice_succeeds_again_and_keeps_the_first_start_time() {
        let pool = pool().await;
        let a = block(&pool, "a").await;
        sync_commitments_in(&pool, DAY, vec![plan(&a, "cue1", 600)]).await.unwrap();
        let first = start_block_in(&pool, &a, DAY, START).await.unwrap();
        assert_eq!(start_block_in(&pool, &a, DAY, START + 500).await.unwrap(), first);
        assert_eq!(one(&pool, &a).await.started_at, Some(START));
    }

    #[tokio::test]
    async fn a_block_whose_time_is_over_or_that_was_never_scheduled_cannot_be_started() {
        let pool = pool().await;
        let (a, b) = (block(&pool, "a").await, block(&pool, "b").await);
        sync_commitments_in(&pool, DAY, vec![plan(&a, "cue1", 600)]).await.unwrap();

        for over in ["missed", "lapsed", "finished"] {
            set_status(&pool, &a, over).await;
            assert!(start_block_in(&pool, &a, DAY, START).await.unwrap_err().to_lowercase().contains("expired"), "{over}");
        }
        assert!(start_block_in(&pool, &b, DAY, START).await.is_err()); // never scheduled today
        assert!(start_block_in(&pool, "no-such-block", DAY, START).await.is_err());
        assert!(start_block_in(&pool, &a, "bad", START).await.is_err());
        assert_eq!(one(&pool, &a).await.started_at, None); // nothing was recorded
    }

    // ----- continuing a missed block -----

    #[tokio::test]
    async fn continuing_a_missed_block_starts_it_at_that_moment() {
        let pool = pool().await;
        let apps = vec![AppEntry { label: "Docs".into(), url: "https://example.com".into(), icon: None }];
        let a = make(&pool, "write", 30, None, apps.clone()).await;
        sync_commitments_in(&pool, DAY, vec![plan(&a, "cue1", 600)]).await.unwrap();
        set_status(&pool, &a, "missed").await;

        let started = continue_block_in(&pool, &a, DAY, START, 725).await.unwrap();

        assert_eq!(started, StartedBlock { title: "write".into(), action_trigger: Some("open write".into()), definition_of_done: Some("write done".into()), apps });
        let c = one(&pool, &a).await;
        // it now counts as started at the moment it was continued, not at the time it was planned for
        assert_eq!((c.status.as_str(), c.started_at, c.start_min), ("started", Some(START), 725));
    }

    #[tokio::test]
    async fn only_a_missed_block_can_be_continued_and_a_refusal_changes_nothing() {
        let pool = pool().await;
        let (a, never) = (block(&pool, "a").await, block(&pool, "never").await);
        sync_commitments_in(&pool, DAY, vec![plan(&a, "cue1", 600)]).await.unwrap();

        for status in ["planned", "nagging", "lapsed", "finished"] {
            set_status(&pool, &a, status).await;
            let err = continue_block_in(&pool, &a, DAY, START, 700).await.unwrap_err();
            assert!(err.contains("Only a missed block"), "{status}: {err}");
        }
        assert!(continue_block_in(&pool, &never, DAY, START, 700).await.is_err()); // never scheduled today
        assert!(continue_block_in(&pool, "no-such-block", DAY, START, 700).await.is_err());
        let c = one(&pool, &a).await;
        assert_eq!((c.status.as_str(), c.started_at, c.start_min), ("finished", None, 600));
    }

    #[tokio::test]
    async fn a_missed_block_that_was_dropped_cannot_be_continued() {
        let pool = pool().await;
        let a = block(&pool, "a").await;
        sync_commitments_in(&pool, DAY, vec![plan(&a, "cue1", 600)]).await.unwrap();
        set_status(&pool, &a, "missed").await;
        dismiss_block_in(&pool, &a).await.unwrap();

        assert!(continue_block_in(&pool, &a, DAY, START, 700).await.unwrap_err().contains("dropped"));
        assert_eq!(one(&pool, &a).await.status, "missed");
    }

    #[tokio::test]
    async fn a_minute_outside_the_day_or_a_bad_date_is_refused() {
        let pool = pool().await;
        let a = block(&pool, "a").await;
        sync_commitments_in(&pool, DAY, vec![plan(&a, "cue1", 600)]).await.unwrap();
        set_status(&pool, &a, "missed").await;

        for bad in [-1, 1440, 5000] {
            assert!(continue_block_in(&pool, &a, DAY, START, bad).await.is_err(), "{bad}");
        }
        assert!(continue_block_in(&pool, &a, "bad", START, 700).await.is_err());
        assert_eq!(one(&pool, &a).await.status, "missed");
    }

    #[tokio::test]
    async fn continuing_twice_succeeds_again_and_keeps_the_first_start() {
        let pool = pool().await;
        let a = block(&pool, "a").await;
        sync_commitments_in(&pool, DAY, vec![plan(&a, "cue1", 600)]).await.unwrap();
        set_status(&pool, &a, "missed").await;

        let first = continue_block_in(&pool, &a, DAY, START, 700).await.unwrap();
        assert_eq!(continue_block_in(&pool, &a, DAY, START + 500, 710).await.unwrap(), first);
        let c = one(&pool, &a).await;
        assert_eq!((c.started_at, c.start_min), (Some(START), 700));
    }

    #[tokio::test]
    async fn starting_one_block_does_not_touch_the_others() {
        let pool = pool().await;
        let (a, b) = (block(&pool, "a").await, block(&pool, "b").await);
        sync_commitments_in(&pool, DAY, vec![plan(&a, "cue1", 600), plan(&b, "cue2", 700)]).await.unwrap();
        start_block_in(&pool, &a, DAY, START).await.unwrap();
        assert_eq!(cues_by_block(&pool, DAY).await, vec![(a, "cue1".into(), "started".into()), (b, "cue2".into(), "planned".into())]);
    }

    // ----- finishing -----

    async fn started_block(pool: &SqlitePool, duration_min: i32) -> String {
        let a = make(pool, "a", duration_min, None, vec![]).await;
        let mut p = plan(&a, "cue1", 600);
        p.duration_min = duration_min;
        sync_commitments_in(pool, DAY, vec![p]).await.unwrap();
        start_block_in(pool, &a, DAY, START).await.unwrap();
        a
    }

    #[tokio::test]
    async fn finishing_is_refused_until_half_the_entered_length_has_passed_since_start() {
        let pool = pool().await;
        let a = started_block(&pool, 30).await; // half of 30 min = 900 s

        let err = finish_block_in(&pool, &a, DAY, START + 899, 615).await.unwrap_err();
        assert!(err.contains("Too early"), "{err}");
        assert_eq!(one(&pool, &a).await.status, "started");
        assert_eq!(list_day_blocks_in(&pool, DAY).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn finishing_at_exactly_half_works_and_records_when() {
        let pool = pool().await;
        let a = started_block(&pool, 30).await;

        finish_block_in(&pool, &a, DAY, START + 900, 615).await.unwrap();

        let c = one(&pool, &a).await;
        assert_eq!((c.status.as_str(), c.finished_at, c.finished_min), ("finished", Some(START + 900), Some(615)));
    }

    #[tokio::test]
    async fn the_wait_is_reported_in_whole_minutes_rounded_up() {
        let pool = pool().await;
        let a = started_block(&pool, 30).await;
        let err = finish_block_in(&pool, &a, DAY, START + 61, 615).await.unwrap_err();
        assert!(err.contains("14 more minute"), "{err}"); // 900 - 61 = 839 s -> 14 min
    }

    #[tokio::test]
    async fn the_half_is_counted_from_when_start_was_pressed_not_from_the_plan() {
        let pool = pool().await;
        let a = make(&pool, "a", 60, None, vec![]).await;
        let mut p = plan(&a, "cue1", 600);
        p.duration_min = 60;
        sync_commitments_in(&pool, DAY, vec![p]).await.unwrap();
        // Started an hour after it was planned: 20 minutes in is still not half of 60.
        start_block_in(&pool, &a, DAY, START + 3600).await.unwrap();
        assert!(finish_block_in(&pool, &a, DAY, START + 3600 + 1200, 700).await.is_err());
        assert!(finish_block_in(&pool, &a, DAY, START + 3600 + 1800, 700).await.is_ok());
    }

    #[tokio::test]
    async fn finishing_completes_the_block_so_it_stops_carrying_over_but_stays_listed_that_day() {
        let pool = pool().await;
        let a = started_block(&pool, 30).await;
        finish_block_in(&pool, &a, DAY, START + 1000, 615).await.unwrap();

        let completed: bool = sqlx::query_scalar("SELECT is_completed FROM focus_blocks WHERE id = $1").bind(&a).fetch_one(&pool).await.unwrap();
        assert!(completed);

        let today = list_day_blocks_in(&pool, DAY).await.unwrap();
        assert_eq!((today.len(), today[0].is_completed, today[0].ended_at_min), (1, true, Some(615)));
        assert!(list_day_blocks_in(&pool, "2026-10-13").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn finishing_twice_is_harmless_and_keeps_the_first_finish_time() {
        let pool = pool().await;
        let a = started_block(&pool, 30).await;
        finish_block_in(&pool, &a, DAY, START + 1000, 615).await.unwrap();
        finish_block_in(&pool, &a, DAY, START + 5000, 700).await.unwrap();
        assert_eq!(one(&pool, &a).await.finished_min, Some(615));
    }

    #[tokio::test]
    async fn a_block_that_was_never_started_cannot_be_finished() {
        let pool = pool().await;
        let a = block(&pool, "a").await;
        sync_commitments_in(&pool, DAY, vec![plan(&a, "cue1", 600)]).await.unwrap();
        for status in ["planned", "nagging"] {
            set_status(&pool, &a, status).await;
            let err = finish_block_in(&pool, &a, DAY, START + 99_999, 700).await.unwrap_err();
            assert!(err.contains("Start the block"), "{status}: {err}");
        }
        assert_eq!(one(&pool, &a).await.finished_at, None);
    }

    #[tokio::test]
    async fn a_block_whose_time_is_over_cannot_be_finished() {
        let pool = pool().await;
        let a = started_block(&pool, 30).await;
        for over in ["lapsed", "missed"] {
            set_status(&pool, &a, over).await;
            assert!(finish_block_in(&pool, &a, DAY, START + 99_999, 700).await.unwrap_err().contains("over"), "{over}");
        }
    }

    #[tokio::test]
    async fn finishing_refuses_unknown_blocks_and_bad_input() {
        let pool = pool().await;
        let a = started_block(&pool, 30).await;
        assert!(finish_block_in(&pool, "ghost", DAY, START + 1000, 600).await.is_err());
        assert!(finish_block_in(&pool, &a, "bad", START + 1000, 600).await.is_err());
        assert!(finish_block_in(&pool, &a, DAY, START + 1000, -1).await.is_err());
        assert!(finish_block_in(&pool, &a, DAY, START + 1000, 1440).await.is_err());
        assert_eq!(one(&pool, &a).await.status, "started");
    }

    #[tokio::test]
    async fn a_clock_that_went_backwards_counts_as_no_time_passed() {
        let pool = pool().await;
        let a = started_block(&pool, 30).await;
        assert!(finish_block_in(&pool, &a, DAY, START - 5000, 600).await.is_err());
    }

    // ----- lapsing -----

    #[tokio::test]
    async fn a_started_block_that_runs_out_of_time_lapses_is_dropped_and_the_chain_closes_up() {
        let pool = pool().await;
        let a = make(&pool, "a", 30, None, vec![]).await;
        let b = make(&pool, "b", 30, Some(ParentRef { kind: "block".into(), id: a.clone() }), vec![]).await;
        sync_commitments_in(&pool, DAY, vec![plan(&a, "cue1", 600), plan(&b, "cue1", 630)]).await.unwrap();
        start_block_in(&pool, &a, DAY, START).await.unwrap();

        lapse_block_in(&pool, &a, DAY).await.unwrap();

        assert_eq!(one(&pool, &a).await.status, "lapsed"); // remembered as "committed, not finished"
        assert!(one(&pool, &a).await.started_at.is_some());
        let listed = list_day_blocks_in(&pool, DAY).await.unwrap();
        assert_eq!(listed.len(), 1); // a is gone
        assert_eq!(listed[0].id, b);
        assert_eq!(listed[0].parent_kind.as_deref(), Some("cue")); // b now follows a's cue
    }

    #[tokio::test]
    async fn a_block_that_was_never_started_cannot_lapse() {
        let pool = pool().await;
        let a = block(&pool, "a").await;
        sync_commitments_in(&pool, DAY, vec![plan(&a, "cue1", 600)]).await.unwrap();
        assert!(lapse_block_in(&pool, &a, DAY).await.is_err());
        assert!(lapse_block_in(&pool, "ghost", DAY).await.is_err());
        assert_eq!(one(&pool, &a).await.status, "planned");
        assert_eq!(list_day_blocks_in(&pool, DAY).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_finished_block_cannot_lapse() {
        let pool = pool().await;
        let a = started_block(&pool, 30).await;
        finish_block_in(&pool, &a, DAY, START + 1000, 615).await.unwrap();
        assert!(lapse_block_in(&pool, &a, DAY).await.is_err());
        assert_eq!(one(&pool, &a).await.status, "finished");
    }
}
