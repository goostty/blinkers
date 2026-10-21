use crate::db::DbState;
use serde::{Deserialize, Serialize};
use sqlx::{Sqlite, Transaction};
use tauri::State;
use uuid::Uuid;

type Tx<'a> = Transaction<'a, Sqlite>;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskItem {
    pub title: String,
    pub action_trigger: Option<String>,
    pub definition_of_done: Option<String>,
}

// A website or app to open when the block starts; mirrors AppEntry in src/appTargets.ts.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AppEntry {
    pub label: String,
    pub url: String,
    pub icon: Option<String>,
}

// Stored as one JSON column. An empty list is stored as NULL so a block with no apps looks the
// same as one saved before apps were stored.
pub fn apps_to_json(apps: &[AppEntry]) -> Result<Option<String>, String> {
    if apps.is_empty() {
        return Ok(None);
    }
    serde_json::to_string(apps).map(Some).map_err(|e| e.to_string())
}

// A damaged value reads as "no apps": the block must still start, just without opening anything,
// rather than being stuck behind a parse error.
pub fn apps_from_json(stored: Option<&str>) -> Vec<AppEntry> {
    stored.and_then(|s| serde_json::from_str(s).ok()).unwrap_or_default()
}

// What a block follows in its day's chain: a cue (the head of a chain) or another block.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ParentRef {
    pub kind: String,
    pub id: String,
}

impl ParentRef {
    fn new(kind: &str, id: &str) -> Self {
        ParentRef { kind: kind.into(), id: id.into() }
    }
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
    pub urgency: Option<String>,
    #[serde(default)]
    pub apps: Vec<AppEntry>,
    // None for blocks saved before blocks had lengths and links.
    #[serde(default)]
    pub duration_min: Option<i32>,
    #[serde(default)]
    pub parent: Option<ParentRef>,
    // The day `parent` was chosen for. A cue repeats weekly, so a link only means something
    // on that day.
    #[serde(default)]
    pub scheduled_on: Option<String>,
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
    urgency: Option<String>,
    apps: Option<String>,
    duration_min: Option<i32>,
    parent_kind: Option<String>,
    parent_id: Option<String>,
    scheduled_on: Option<String>,
}

// Everything the timeline needs about a block on a given day. `created_on` lets it tell a block
// carried over from an earlier day apart from one made today. `parent_*` is only filled when the
// block was attached for that very day, so a carried-over block comes back unattached. A finished
// block stays in the list on the day it was finished, because blocks that follow it hang from it.
#[derive(Clone, Debug, PartialEq, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct DayBlock {
    pub id: String,
    pub block_type: String,
    pub order_index: i32,
    pub title: String,
    pub urgency: Option<String>,
    pub created_on: String,
    pub duration_min: i32,
    pub parent_kind: Option<String>,
    pub parent_id: Option<String>,
    pub is_completed: bool,
    pub ended_at_min: Option<i32>,
    pub committed: bool,
}

// Everything needed to make a block. The command takes these as separate arguments for the UI.
pub struct NewBlock {
    pub task: TaskItem,
    pub order_index: i32,
    pub block_type: String,
    pub urgency: Option<String>,
    pub apps: Vec<AppEntry>,
    pub duration_min: i32,
    pub parent: Option<ParentRef>,
    pub created_on: String,
}

const BLOCK_TYPES: [&str; 4] = ["deep", "routine", "reset", "recharge"];

// Eisenhower quadrants: Q1 urgent+important, Q2 important, Q3 urgent, Q4 neither.
const URGENCIES: [&str; 4] = ["urgent-important", "important", "urgent", "neither"];

const MAX_DURATION_MIN: i32 = 1440;

// Work (deep/routine) must be classified so the scheduler always knows how much it matters.
// Rest (reset/recharge) is never ranked, so giving it an urgency is refused instead of ignored:
// a stray value would otherwise sit in the database looking meaningful.
pub fn validate_urgency(block_type: &str, urgency: Option<&str>) -> Result<(), String> {
    let is_work = block_type == "deep" || block_type == "routine";
    match (is_work, urgency) {
        (true, Some(u)) if URGENCIES.contains(&u) => Ok(()),
        (true, Some(u)) => Err(format!("Unknown urgency \"{u}\".")),
        (true, None) => Err("Pick an urgency for this block.".into()),
        (false, None) => Ok(()),
        (false, Some(_)) => Err("Only deep and routine blocks have an urgency.".into()),
    }
}

pub fn validate_block_type(block_type: &str) -> Result<(), String> {
    if BLOCK_TYPES.contains(&block_type) {
        Ok(())
    } else {
        Err(format!("Unknown block type \"{block_type}\"."))
    }
}

// The length is what the user entered, in whole minutes. The chain adds lengths up to know when
// the next block starts, so a block without one cannot be placed.
pub fn validate_duration(duration_min: i32) -> Result<(), String> {
    if (1..=MAX_DURATION_MIN).contains(&duration_min) {
        Ok(())
    } else {
        Err(format!("Length must be between 1 and {MAX_DURATION_MIN} minutes."))
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

// 0 = Sunday ... 6 = Saturday, like the cues. A cue only runs on some weekdays, so attaching a
// block to one needs to know which weekday its date is. Expects a date that already passed
// validate_created_on.
pub fn weekday_of(date: &str) -> u8 {
    const OFFSET: [i32; 12] = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
    let mut year: i32 = date[0..4].parse().unwrap_or(2000);
    let month: i32 = date[5..7].parse().unwrap_or(1).clamp(1, 12);
    let day: i32 = date[8..10].parse().unwrap_or(1);
    if month < 3 {
        year -= 1;
    }
    ((year + year / 4 - year / 100 + year / 400 + OFFSET[(month - 1) as usize] + day).rem_euclid(7)) as u8
}

// Whether a cue runs on a day: a cue with a date runs on that date only (even the same weekday a
// week later does not count), and one without runs every week on its weekdays. Everything that
// decides "can a block follow this cue today" goes through here, so the two kinds cannot drift.
pub fn cue_runs_on(on_date: Option<&str>, days: &[u8], day: &str) -> bool {
    match on_date {
        Some(date) => date == day,
        None => days.contains(&weekday_of(day)),
    }
}

fn validate_parent_kind(parent: &ParentRef) -> Result<(), String> {
    match parent.kind.as_str() {
        "cue" | "block" => Ok(()),
        other => Err(format!("Unknown parent kind \"{other}\".")),
    }
}

// A block advised to drop (Q4) is not placed in the day, so it must not be attached. Any other
// block may be made with or without a place: the app places it (and one without a place simply
// waits on today's list until there is room), so the user never has to say what it follows.
fn validate_new_block(b: &NewBlock) -> Result<(), String> {
    validate_block_type(&b.block_type)?;
    validate_urgency(&b.block_type, b.urgency.as_deref())?;
    validate_duration(b.duration_min)?;
    validate_created_on(&b.created_on)?;
    match (&b.parent, b.urgency.as_deref() == Some("neither")) {
        (Some(_), true) => Err("A block you are advised to drop is not placed in the day.".into()),
        (None, false) => Ok(()),
        (Some(parent), false) => validate_parent_kind(parent),
        (None, true) => Ok(()),
    }
}

fn db_err(e: sqlx::Error) -> String {
    e.to_string()
}

// A cue must exist, run on that weekday, and not be an end-of-day cue. A block must exist, be
// attached for that same day, not be dropped, and not be one the user was advised to drop.
async fn check_parent(tx: &mut Tx<'_>, parent: &ParentRef, day: &str) -> Result<(), String> {
    match parent.kind.as_str() {
        "cue" => {
            let row: Option<(String, bool, Option<String>)> =
                sqlx::query_as("SELECT days, ends_day, on_date FROM cues WHERE id = $1")
                    .bind(&parent.id)
                    .fetch_optional(&mut **tx)
                    .await
                    .map_err(db_err)?;
            let (days, ends_day, on_date) = row.ok_or("That cue no longer exists.")?;
            if ends_day {
                return Err("An end-of-day cue cannot hold blocks.".into());
            }
            let days: Vec<u8> = serde_json::from_str(&days).map_err(|e| e.to_string())?;
            if !cue_runs_on(on_date.as_deref(), &days, day) {
                return Err("That cue does not run on this day.".into());
            }
            Ok(())
        }
        "block" => {
            let row: Option<(Option<String>, Option<String>, Option<String>, bool)> = sqlx::query_as(
                "SELECT c.parent_kind, c.scheduled_on, c.urgency, fb.dismissed
                 FROM containers c JOIN focus_blocks fb ON fb.id = c.focus_block_id
                 WHERE c.focus_block_id = $1",
            )
            .bind(&parent.id)
            .fetch_optional(&mut **tx)
            .await
            .map_err(db_err)?;
            let (parent_kind, scheduled_on, urgency, dismissed) = row.ok_or("That block no longer exists.")?;
            if dismissed {
                return Err("That block was dropped.".into());
            }
            if urgency.as_deref() == Some("neither") {
                return Err("A block you are advised to drop is not part of the day.".into());
            }
            if parent_kind.is_none() || scheduled_on.as_deref() != Some(day) {
                return Err("That block is not attached to this day yet.".into());
            }
            Ok(())
        }
        other => Err(format!("Unknown parent kind \"{other}\".")),
    }
}

// The block that follows `parent` on `day`, if any. A list has one "next", so there is at most one.
async fn follower_of(tx: &mut Tx<'_>, parent: &ParentRef, day: &str) -> Result<Option<String>, String> {
    sqlx::query_scalar(
        "SELECT focus_block_id FROM containers WHERE scheduled_on = $1 AND parent_kind = $2 AND parent_id = $3",
    )
    .bind(day)
    .bind(&parent.kind)
    .bind(&parent.id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(db_err)
}

async fn set_parent(tx: &mut Tx<'_>, block_id: &str, parent: Option<&ParentRef>) -> Result<(), String> {
    sqlx::query("UPDATE containers SET parent_kind = $1, parent_id = $2 WHERE focus_block_id = $3")
        .bind(parent.map(|p| p.kind.as_str()))
        .bind(parent.map(|p| p.id.as_str()))
        .bind(block_id)
        .execute(&mut **tx)
        .await
        .map_err(db_err)?;
    Ok(())
}

// The last block of the chain that starts at `block_id` (which is itself if nothing follows it).
async fn tail_of(tx: &mut Tx<'_>, block_id: &str, day: &str) -> Result<String, String> {
    let mut tail = block_id.to_string();
    // The bound only guards against a corrupt loop; real chains are short.
    for _ in 0..10_000 {
        match follower_of(tx, &ParentRef::new("block", &tail), day).await? {
            Some(next) => tail = next,
            None => return Ok(tail),
        }
    }
    Err("That chain loops back on itself.".into())
}

// Inserting into a linked list: the new block takes the place right after `parent`, and whatever
// used to follow `parent` now follows the end of the new block instead. The old follower is
// detached first because a node may have only one follower at any moment.
pub async fn create_container_in(pool: &sqlx::SqlitePool, new: NewBlock) -> Result<String, String> {
    validate_new_block(&new)?;

    let main_id = Uuid::new_v4().to_string();
    let container_id = Uuid::new_v4().to_string();
    let mut order_index = new.order_index;
    if order_index < 0 {
        order_index += 1;
    }

    let day = new.created_on.clone();
    let container = Container {
        id: container_id,
        focus_block_id: main_id.clone(),
        primary_task: new.task,
        order_index,
        notes: None,
        block_type: new.block_type,
        created_on: new.created_on,
        urgency: new.urgency,
        apps: new.apps,
        duration_min: Some(new.duration_min),
        scheduled_on: new.parent.as_ref().map(|_| day.clone()),
        parent: new.parent.clone(),
    };
    let block = FocusBlock { id: main_id.clone(), container, is_completed: false };

    let mut tx = pool.begin().await.map_err(db_err)?;

    let mut displaced = None;
    if let Some(parent) = &new.parent {
        check_parent(&mut tx, parent, &day).await?;
        displaced = follower_of(&mut tx, parent, &day).await?;
        if let Some(old) = &displaced {
            set_parent(&mut tx, old, None).await?;
        }
    }

    crate::db::insert_container_tx(&mut tx, &block).await?;

    if let Some(old) = displaced {
        set_parent(&mut tx, &old, Some(&ParentRef::new("block", &main_id))).await?;
    }

    tx.commit().await.map_err(db_err)?;
    Ok(main_id)
}

// Attaches a block that has no place today: one carried over from an earlier day (its old link
// was for that day), or one whose parent was dropped. Its own followers, if it has any, come
// along with it, so whatever used to follow the new parent is moved behind the end of that sub-chain.
pub async fn attach_block_in(
    pool: &sqlx::SqlitePool,
    block_id: &str,
    parent: ParentRef,
    on: &str,
) -> Result<(), String> {
    validate_created_on(on)?;
    validate_parent_kind(&parent)?;
    if parent.kind == "block" && parent.id == block_id {
        return Err("A block cannot follow itself.".into());
    }

    let mut tx = pool.begin().await.map_err(db_err)?;

    let row: Option<(Option<String>, Option<String>, Option<String>, bool, bool)> = sqlx::query_as(
        "SELECT c.parent_kind, c.scheduled_on, c.urgency, fb.dismissed, fb.is_completed
         FROM containers c JOIN focus_blocks fb ON fb.id = c.focus_block_id
         WHERE c.focus_block_id = $1",
    )
    .bind(block_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db_err)?;
    let (parent_kind, scheduled_on, urgency, dismissed, completed) = row.ok_or("That block no longer exists.")?;

    if dismissed || completed {
        return Err("That block is already finished or dropped.".into());
    }
    if urgency.as_deref() == Some("neither") {
        return Err("A block you are advised to drop is not placed in the day.".into());
    }
    if parent_kind.is_some() && scheduled_on.as_deref() == Some(on) {
        return Err("That block is already attached.".into());
    }

    check_parent(&mut tx, &parent, on).await?;

    // Walking up from the new parent must never reach this block, or the chain would loop.
    if parent.kind == "block" {
        let mut cursor = parent.id.clone();
        for _ in 0..10_000 {
            if cursor == block_id {
                return Err("A block cannot follow one of its own followers.".into());
            }
            let up: Option<(Option<String>, Option<String>)> = sqlx::query_as(
                "SELECT parent_kind, parent_id FROM containers WHERE focus_block_id = $1 AND scheduled_on = $2",
            )
            .bind(&cursor)
            .bind(on)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db_err)?;
            match up {
                Some((Some(kind), Some(id))) if kind == "block" => cursor = id,
                _ => break,
            }
        }
    }

    let displaced = follower_of(&mut tx, &parent, on).await?;
    if let Some(old) = &displaced {
        set_parent(&mut tx, old, None).await?;
    }

    sqlx::query("UPDATE containers SET parent_kind = $1, parent_id = $2, scheduled_on = $3 WHERE focus_block_id = $4")
        .bind(&parent.kind)
        .bind(&parent.id)
        .bind(on)
        .bind(block_id)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;

    if let Some(old) = displaced {
        let tail = tail_of(&mut tx, block_id, on).await?;
        set_parent(&mut tx, &old, Some(&ParentRef::new("block", &tail))).await?;
    }

    tx.commit().await.map_err(db_err)
}

// Drops a block and closes the gap, the way removing a node from a linked list does: whatever
// followed it now follows what it followed. "Dismissed" is not "completed", so the difference
// between a block that was finished and one that was abandoned is never lost.
pub async fn dismiss_block_in(pool: &sqlx::SqlitePool, block_id: &str) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(db_err)?;

    let row: Option<(Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT parent_kind, parent_id, scheduled_on FROM containers WHERE focus_block_id = $1",
    )
    .bind(block_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db_err)?;
    let (kind, id, day) = row.ok_or("That block no longer exists.")?;
    let parent = match (kind, id) {
        (Some(kind), Some(id)) => Some(ParentRef { kind, id }),
        _ => None,
    };

    if let Some(day) = &day {
        let follower = follower_of(&mut tx, &ParentRef::new("block", block_id), day).await?;
        // Free the slot after the parent first: it can hold only one follower at a time.
        set_parent(&mut tx, block_id, None).await?;
        if let Some(follower) = follower {
            set_parent(&mut tx, &follower, parent.as_ref()).await?;
        }
    }

    sqlx::query("UPDATE focus_blocks SET dismissed = 1 WHERE id = $1")
        .bind(block_id)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;

    tx.commit().await.map_err(db_err)
}

// What the edit form needs to show, and what it may change. Length, urgency, type and place are
// deliberately not here: they decide where the block lands in the day and how many of its kind
// fit, so changing one is a different action from fixing a typo or rewording a first step.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditableBlock {
    pub block_type: String,
    pub title: String,
    pub action_trigger: Option<String>,
    pub definition_of_done: Option<String>,
    pub apps: Vec<AppEntry>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockEdit {
    pub title: String,
    pub action_trigger: Option<String>,
    pub definition_of_done: Option<String>,
    #[serde(default)]
    pub apps: Vec<AppEntry>,
}

#[derive(Debug, sqlx::FromRow)]
struct EditableRow {
    block_type: String,
    task_title: String,
    action_trigger: Option<String>,
    definition_of_done: Option<String>,
    apps: Option<String>,
    dismissed: bool,
    is_completed: bool,
}

async fn editable_row(pool: &sqlx::SqlitePool, block_id: &str) -> Result<EditableRow, String> {
    let row = sqlx::query_as::<_, EditableRow>(
        "SELECT c.block_type, c.task_title, c.action_trigger, c.definition_of_done, c.apps,
                fb.dismissed, fb.is_completed
         FROM containers c JOIN focus_blocks fb ON fb.id = c.focus_block_id
         WHERE c.focus_block_id = $1",
    )
    .bind(block_id)
    .fetch_optional(pool)
    .await
    .map_err(db_err)?
    .ok_or("That block no longer exists.")?;
    // A finished or dropped block is history; rewording it would rewrite what was actually done.
    if row.dismissed || row.is_completed {
        return Err("That block is already finished or dropped.".into());
    }
    Ok(row)
}

pub async fn get_block_details_in(pool: &sqlx::SqlitePool, block_id: &str) -> Result<EditableBlock, String> {
    let row = editable_row(pool, block_id).await?;
    Ok(EditableBlock {
        block_type: row.block_type,
        title: row.task_title,
        action_trigger: row.action_trigger,
        definition_of_done: row.definition_of_done,
        apps: apps_from_json(row.apps.as_deref()),
    })
}

fn clean_optional(text: Option<String>) -> Option<String> {
    text.map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
}

// Fixes a block's wording after it was made: title, first step, definition of done and the apps
// to open. The same rules as making one apply: a block that shows a title cannot be saved without
// it, a recharge block has no text to edit, and only deep and routine blocks open apps. Nothing
// about the block's place in the day changes, and its commitment is left alone: the reminder reads
// the title live, so a later reminder simply uses the new wording.
pub async fn update_block_in(pool: &sqlx::SqlitePool, block_id: &str, edit: BlockEdit) -> Result<(), String> {
    let row = editable_row(pool, block_id).await?;

    if row.block_type == "recharge" {
        return Err("A recharge block has nothing to edit.".into());
    }
    let title = edit.title.trim().to_string();
    if title.is_empty() {
        return Err("A block needs a title.".into());
    }
    let is_work = row.block_type == "deep" || row.block_type == "routine";
    if !is_work && !edit.apps.is_empty() {
        return Err("Only deep and routine blocks open apps.".into());
    }
    if edit.apps.iter().any(|a| a.label.trim().is_empty() || a.url.trim().is_empty()) {
        return Err("Every app needs a name and an address.".into());
    }

    sqlx::query(
        "UPDATE containers SET task_title = $1, action_trigger = $2, definition_of_done = $3, apps = $4
         WHERE focus_block_id = $5",
    )
    .bind(title)
    .bind(clean_optional(edit.action_trigger))
    .bind(clean_optional(edit.definition_of_done))
    .bind(apps_to_json(&edit.apps)?)
    .bind(block_id)
    .execute(pool)
    .await
    .map_err(db_err)?;
    Ok(())
}

// A block that was missed (its time passed and the user never started it) still deserves a
// chance. Rescheduling takes it out of its slot, the way dropping does, so whatever followed it
// closes up; but unlike dropping it stays alive and goes back to "needs a place today", where the
// user says what it should follow. Its missed commitment is deleted in the same step: a
// commitment that is not `planned` is frozen, so planning would otherwise skip the block forever
// and it could never get a new time. Only a missed block can be rescheduled; anything else is
// refused and nothing changes.
pub async fn reschedule_block_in(pool: &sqlx::SqlitePool, block_id: &str, on: &str) -> Result<(), String> {
    validate_created_on(on)?;
    let mut tx = pool.begin().await.map_err(db_err)?;

    let status: Option<String> = sqlx::query_scalar("SELECT status FROM commitments WHERE block_id = $1 AND on_date = $2")
        .bind(block_id)
        .bind(on)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db_err)?;
    match status.as_deref() {
        Some("missed") => {}
        Some(_) => return Err("Only a missed block can be rescheduled.".into()),
        None => return Err("No reminder is scheduled for that block today.".into()),
    }

    let row: Option<(Option<String>, Option<String>, bool, bool)> = sqlx::query_as(
        "SELECT c.parent_kind, c.parent_id, fb.dismissed, fb.is_completed
         FROM containers c JOIN focus_blocks fb ON fb.id = c.focus_block_id
         WHERE c.focus_block_id = $1",
    )
    .bind(block_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db_err)?;
    let (kind, id, dismissed, completed) = row.ok_or("That block no longer exists.")?;
    if dismissed || completed {
        return Err("That block is already finished or dropped.".into());
    }
    let parent = match (kind, id) {
        (Some(kind), Some(id)) => Some(ParentRef { kind, id }),
        _ => None,
    };

    let follower = follower_of(&mut tx, &ParentRef::new("block", block_id), on).await?;
    // Free the slot after the parent first: it can hold only one follower at a time.
    set_parent(&mut tx, block_id, None).await?;
    if let Some(follower) = follower {
        set_parent(&mut tx, &follower, parent.as_ref()).await?;
    }

    sqlx::query("DELETE FROM commitments WHERE block_id = $1 AND on_date = $2")
        .bind(block_id)
        .bind(on)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;

    tx.commit().await.map_err(db_err)
}

// Everything made today and still unfinished is on today's list, plus work carried over from
// earlier days. Only deep/routine blocks classified Q1-Q3 carry over; a block pushed past a limit
// "rolls to tomorrow" without any bookkeeping, since it simply stays unfinished. Rest blocks
// belong to the day they were made, and a Q4 block is shown (as "drop it") once, not every day.
// Rows from before urgency existed have no urgency and an empty `created_on`, so they never carry
// over and never count as today. Dropped blocks never appear. Blocks finished on this very day do
// appear, so the blocks that follow them keep their place and can be pulled forward.
pub async fn list_day_blocks_in(pool: &sqlx::SqlitePool, on: &str) -> Result<Vec<DayBlock>, String> {
    validate_created_on(on)?;
    sqlx::query_as::<_, DayBlock>(
        "SELECT fb.id AS id, c.block_type AS block_type, c.order_index AS order_index, c.task_title AS title,
                c.urgency AS urgency, c.created_on AS created_on,
                COALESCE(c.duration_min, 30) AS duration_min,
                CASE WHEN c.scheduled_on = $1 THEN c.parent_kind END AS parent_kind,
                CASE WHEN c.scheduled_on = $1 THEN c.parent_id END AS parent_id,
                fb.is_completed AS is_completed,
                cm.finished_min AS ended_at_min,
                (cm.started_at IS NOT NULL) AS committed
         FROM focus_blocks fb
         JOIN containers c ON c.focus_block_id = fb.id
         LEFT JOIN commitments cm ON cm.block_id = fb.id AND cm.on_date = $1
         WHERE fb.dismissed = 0
           AND ((fb.is_completed = 0
                 AND (c.created_on = $1
                      OR (c.created_on <> '' AND c.created_on < $1
                          AND c.block_type IN ('deep', 'routine')
                          AND c.urgency IN ('urgent-important', 'important', 'urgent'))))
                OR (fb.is_completed = 1 AND cm.status = 'finished'))
         ORDER BY c.order_index",
    )
    .bind(on)
    .fetch_all(pool)
    .await
    .map_err(db_err)
}

#[cfg(not(target_arch = "wasm32"))]
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_container(
    task: TaskItem,
    order_index: i32,
    block_type: String,
    urgency: Option<String>,
    apps: Vec<AppEntry>,
    duration_min: i32,
    parent: Option<ParentRef>,
    created_on: String,
    db_state: State<'_, DbState>,
) -> Result<String, String> {
    let new = NewBlock { task, order_index, block_type, urgency, apps, duration_min, parent, created_on };
    create_container_in(&db_state.pool, new).await
}

#[cfg(not(target_arch = "wasm32"))]
#[tauri::command]
pub async fn attach_block(
    block_id: String,
    parent: ParentRef,
    on: String,
    db_state: State<'_, DbState>,
) -> Result<(), String> {
    attach_block_in(&db_state.pool, &block_id, parent, &on).await
}

#[cfg(not(target_arch = "wasm32"))]
#[tauri::command]
pub async fn dismiss_block(block_id: String, db_state: State<'_, DbState>) -> Result<(), String> {
    dismiss_block_in(&db_state.pool, &block_id).await
}

#[cfg(not(target_arch = "wasm32"))]
#[tauri::command]
pub async fn get_block_details(block_id: String, db_state: State<'_, DbState>) -> Result<EditableBlock, String> {
    get_block_details_in(&db_state.pool, &block_id).await
}

#[cfg(not(target_arch = "wasm32"))]
#[tauri::command]
pub async fn update_block(block_id: String, edit: BlockEdit, db_state: State<'_, DbState>) -> Result<(), String> {
    update_block_in(&db_state.pool, &block_id, edit).await
}

#[cfg(not(target_arch = "wasm32"))]
#[tauri::command]
pub async fn reschedule_block(block_id: String, on: String, db_state: State<'_, DbState>) -> Result<(), String> {
    reschedule_block_in(&db_state.pool, &block_id, &on).await
}

#[cfg(not(target_arch = "wasm32"))]
#[tauri::command]
pub async fn list_day_blocks(on: String, db_state: State<'_, DbState>) -> Result<Vec<DayBlock>, String> {
    list_day_blocks_in(&db_state.pool, &on).await
}

#[cfg(not(target_arch = "wasm32"))]
#[tauri::command]
pub async fn fetch_container(state: State<'_, DbState>) -> Result<Option<FocusBlock>, String> {
    let pool = &state.pool;
    let block_id: Option<String> = sqlx::query_scalar::<_, String>(
        "SELECT id FROM focus_blocks WHERE is_completed = 0 AND dismissed = 0 LIMIT 1",
    )
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    let target_id = match block_id {
        Some(id) => id,
        None => return Ok(None),
    };

    let row = sqlx::query_as::<_, RawContainerRow>(
        "SELECT id, focus_block_id, order_index, notes, task_title, action_trigger, definition_of_done, block_type, created_on, urgency, apps, duration_min, parent_kind, parent_id, scheduled_on FROM containers WHERE focus_block_id = ? LIMIT 1"
    )
    .bind(&target_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    if let Some(r) = row {
        let parent = match (r.parent_kind, r.parent_id) {
            (Some(kind), Some(id)) => Some(ParentRef { kind, id }),
            _ => None,
        };
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
            urgency: r.urgency,
            apps: apps_from_json(r.apps.as_deref()),
            duration_min: r.duration_min,
            parent,
            scheduled_on: r.scheduled_on,
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

    const MON: &str = "2026-10-12"; // a Monday

    async fn pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::init_container_schema(&pool).await.unwrap();
        crate::db::init_cue_schema(&pool).await.unwrap();
        crate::db::init_commitment_schema(&pool).await.unwrap();
        pool
    }

    fn task(title: &str) -> TaskItem {
        TaskItem { title: title.into(), action_trigger: None, definition_of_done: None }
    }

    fn cue_ref(id: &str) -> ParentRef {
        ParentRef::new("cue", id)
    }

    fn block_ref(id: &str) -> ParentRef {
        ParentRef::new("block", id)
    }

    async fn insert_cue(pool: &SqlitePool, id: &str, days: &str, ends_day: bool) {
        sqlx::query("INSERT INTO cues (id, label, time_min, days, flex_min, ends_day) VALUES ($1, $1, 600, $2, 0, $3)")
            .bind(id)
            .bind(days)
            .bind(ends_day)
            .execute(pool)
            .await
            .unwrap();
    }

    // A cue that runs every day, so a test never trips over a weekday it does not care about.
    async fn fresh_cue(pool: &SqlitePool) -> String {
        let id = Uuid::new_v4().to_string();
        insert_cue(pool, &id, "[0,1,2,3,4,5,6]", false).await;
        id
    }

    fn new_block(title: &str, kind: &str, urgency: Option<&str>, parent: Option<ParentRef>, on: &str) -> NewBlock {
        NewBlock {
            task: task(title),
            order_index: 0,
            block_type: kind.into(),
            urgency: urgency.map(String::from),
            apps: vec![],
            duration_min: 30,
            parent,
            created_on: on.into(),
        }
    }

    async fn create(pool: &SqlitePool, title: &str, kind: &str, urgency: Option<&str>, parent: Option<ParentRef>, on: &str) -> Result<String, String> {
        create_container_in(pool, new_block(title, kind, urgency, parent, on)).await
    }

    // A valid block of the given kind, attached to a cue of its own (a Q4 block is not attached).
    async fn add(pool: &SqlitePool, title: &str, order: i32, kind: &str, on: &str) -> String {
        let urgency = if kind == "deep" || kind == "routine" { Some("important") } else { None };
        let parent = Some(cue_ref(&fresh_cue(pool).await));
        let mut n = new_block(title, kind, urgency, parent, on);
        n.order_index = order;
        create_container_in(pool, n).await.unwrap()
    }

    async fn add_urgent(pool: &SqlitePool, title: &str, kind: &str, urgency: &str, on: &str) -> String {
        let parent = if urgency == "neither" { None } else { Some(cue_ref(&fresh_cue(pool).await)) };
        create(pool, title, kind, Some(urgency), parent, on).await.unwrap()
    }

    async fn titles(pool: &SqlitePool, on: &str) -> Vec<String> {
        list_day_blocks_in(pool, on).await.unwrap().into_iter().map(|b| b.title).collect()
    }

    async fn day(pool: &SqlitePool, on: &str) -> Vec<DayBlock> {
        list_day_blocks_in(pool, on).await.unwrap()
    }

    // What a block follows, as (kind, id), read straight from the table.
    async fn follows(pool: &SqlitePool, block_id: &str) -> Option<(String, String)> {
        let row: (Option<String>, Option<String>) = sqlx::query_as("SELECT parent_kind, parent_id FROM containers WHERE focus_block_id = $1")
            .bind(block_id)
            .fetch_one(pool)
            .await
            .unwrap();
        match row {
            (Some(k), Some(i)) => Some((k, i)),
            _ => None,
        }
    }

    fn cue_of(id: &str) -> Option<(String, String)> {
        Some(("cue".into(), id.into()))
    }

    fn block_of(id: &str) -> Option<(String, String)> {
        Some(("block".into(), id.into()))
    }

    #[test]
    fn weekday_of_knows_the_calendar() {
        for (date, weekday) in [
            ("2026-10-12", 1), // Monday
            ("2026-10-18", 0), // Sunday
            ("2026-10-17", 6), // Saturday
            ("2024-02-29", 4), // a leap day, Thursday
            ("2000-01-01", 6),
            ("2026-01-01", 4),
            ("2026-12-31", 4),
        ] {
            assert_eq!(weekday_of(date), weekday, "{date}");
        }
    }

    #[test]
    fn a_length_is_between_one_minute_and_a_day() {
        for ok in [1, 30, 1440] {
            assert!(validate_duration(ok).is_ok(), "{ok}");
        }
        for bad in [0, -1, 1441, i32::MIN] {
            assert!(validate_duration(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn urgency_is_required_for_work_blocks_and_forbidden_for_rest_blocks() {
        for (kind, urgency) in [
            ("deep", "urgent-important"),
            ("deep", "important"),
            ("routine", "urgent"),
            ("routine", "neither"),
        ] {
            assert!(validate_urgency(kind, Some(urgency)).is_ok(), "{kind} {urgency}");
        }
        assert!(validate_urgency("reset", None).is_ok());
        assert!(validate_urgency("recharge", None).is_ok());

        assert!(validate_urgency("deep", None).is_err());
        assert!(validate_urgency("routine", None).is_err());
        assert!(validate_urgency("reset", Some("important")).is_err());
        assert!(validate_urgency("recharge", Some("neither")).is_err());
        for bad in ["", "Important", "q1", "urgent ", "urgent_important"] {
            assert!(validate_urgency("deep", Some(bad)).is_err(), "{bad:?}");
        }
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

    // ----- making blocks and attaching them -----

    #[tokio::test]
    async fn a_new_block_is_stored_with_its_length_and_what_it_follows() {
        let pool = pool().await;
        let cue = fresh_cue(&pool).await;
        let mut n = new_block("write", "deep", Some("important"), Some(cue_ref(&cue)), MON);
        n.duration_min = 90;
        let id = create_container_in(&pool, n).await.unwrap();

        let got = day(&pool, MON).await;
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].id, id);
        assert_eq!(got[0].duration_min, 90);
        assert_eq!((got[0].parent_kind.as_deref(), got[0].parent_id.as_deref()), (Some("cue"), Some(cue.as_str())));
    }

    #[tokio::test]
    async fn a_block_can_be_made_without_a_place_and_waits_to_be_placed() {
        let pool = pool().await;
        // Placing blocks is the app's job now, so a block may be made before it has a place. It is
        // on today's list with nothing to follow, which is how the app knows to place it.
        let waiting = create(&pool, "x", "deep", Some("important"), None, MON).await.unwrap();
        let rest = create(&pool, "y", "reset", None, None, MON).await.unwrap();
        let listed = day(&pool, MON).await;
        for id in [&waiting, &rest] {
            let b = listed.iter().find(|b| &b.id == id).unwrap();
            assert_eq!((b.parent_kind.as_deref(), b.parent_id.as_deref()), (None, None));
        }
        // A block advised to drop is not placed in the day, so it must still not be attached.
        let cue = fresh_cue(&pool).await;
        assert!(create(&pool, "x", "deep", Some("neither"), Some(cue_ref(&cue)), MON).await.is_err());
        assert!(create(&pool, "x", "deep", Some("neither"), None, MON).await.is_ok());
    }

    #[tokio::test]
    async fn a_cue_has_to_exist_run_that_weekday_and_not_end_the_day() {
        let pool = pool().await;
        insert_cue(&pool, "tue-only", "[2]", false).await;
        insert_cue(&pool, "bed", "[0,1,2,3,4,5,6]", true).await;

        assert!(create(&pool, "x", "deep", Some("important"), Some(cue_ref("nope")), MON).await.is_err());
        let err = create(&pool, "x", "deep", Some("important"), Some(cue_ref("tue-only")), MON).await.unwrap_err();
        assert!(err.contains("does not run"), "{err}");
        let err = create(&pool, "x", "deep", Some("important"), Some(cue_ref("bed")), MON).await.unwrap_err();
        assert!(err.contains("end-of-day"), "{err}");
        assert!(create(&pool, "x", "deep", Some("important"), Some(cue_ref("tue-only")), "2026-10-13").await.is_ok());
        assert!(day(&pool, MON).await.is_empty());
    }

    #[tokio::test]
    async fn a_block_can_follow_another_block_only_if_that_block_is_attached_today() {
        let pool = pool().await;
        let cue = fresh_cue(&pool).await;
        let a = create(&pool, "a", "deep", Some("important"), Some(cue_ref(&cue)), MON).await.unwrap();

        assert!(create(&pool, "b", "routine", Some("important"), Some(block_ref(&a)), MON).await.is_ok());
        assert!(create(&pool, "c", "routine", Some("important"), Some(block_ref("ghost")), MON).await.is_err());
        // a is attached for Monday, not for Tuesday
        let err = create(&pool, "d", "routine", Some("important"), Some(block_ref(&a)), "2026-10-13").await.unwrap_err();
        assert!(err.contains("not attached"), "{err}");
    }

    #[tokio::test]
    async fn a_block_cannot_follow_a_block_advised_to_drop_or_one_that_was_dropped() {
        let pool = pool().await;
        let q4 = create(&pool, "q4", "deep", Some("neither"), None, MON).await.unwrap();
        assert!(create(&pool, "x", "deep", Some("important"), Some(block_ref(&q4)), MON).await.is_err());

        let cue = fresh_cue(&pool).await;
        let a = create(&pool, "a", "deep", Some("important"), Some(cue_ref(&cue)), MON).await.unwrap();
        dismiss_block_in(&pool, &a).await.unwrap();
        assert!(create(&pool, "y", "deep", Some("important"), Some(block_ref(&a)), MON).await.is_err());
    }

    #[tokio::test]
    async fn the_kind_of_parent_must_be_cue_or_block() {
        let pool = pool().await;
        assert!(create(&pool, "x", "deep", Some("important"), Some(ParentRef::new("moon", "x")), MON).await.is_err());
    }

    #[tokio::test]
    async fn attaching_to_a_node_that_already_has_a_follower_inserts_the_new_block_between() {
        let pool = pool().await;
        let cue = fresh_cue(&pool).await;
        let a = create(&pool, "a", "deep", Some("important"), Some(cue_ref(&cue)), MON).await.unwrap();
        let b = create(&pool, "b", "routine", Some("important"), Some(cue_ref(&cue)), MON).await.unwrap();

        // cue -> b -> a
        assert_eq!(follows(&pool, &b).await, cue_of(&cue));
        assert_eq!(follows(&pool, &a).await, block_of(&b));
    }

    #[tokio::test]
    async fn inserting_into_the_middle_of_a_chain_keeps_the_rest_in_order() {
        let pool = pool().await;
        let cue = fresh_cue(&pool).await;
        let a = create(&pool, "a", "deep", Some("important"), Some(cue_ref(&cue)), MON).await.unwrap();
        let c = create(&pool, "c", "routine", Some("important"), Some(block_ref(&a)), MON).await.unwrap();
        let b = create(&pool, "b", "routine", Some("important"), Some(block_ref(&a)), MON).await.unwrap();

        // cue -> a -> b -> c
        assert_eq!(follows(&pool, &a).await, cue_of(&cue));
        assert_eq!(follows(&pool, &b).await, block_of(&a));
        assert_eq!(follows(&pool, &c).await, block_of(&b));
    }

    #[tokio::test]
    async fn a_refused_block_leaves_the_existing_chain_untouched() {
        let pool = pool().await;
        let cue = fresh_cue(&pool).await;
        let a = create(&pool, "a", "deep", Some("important"), Some(cue_ref(&cue)), MON).await.unwrap();
        assert!(create(&pool, "bad", "deep", Some("important"), Some(cue_ref(&cue)), "bad-date").await.is_err());
        let mut zero = new_block("zero", "deep", Some("important"), Some(cue_ref(&cue)), MON);
        zero.duration_min = 0;
        assert!(create_container_in(&pool, zero).await.is_err());
        assert_eq!(follows(&pool, &a).await, cue_of(&cue));
        assert_eq!(titles(&pool, MON).await, vec!["a"]);
    }

    // ----- attaching blocks that have no place today -----

    #[tokio::test]
    async fn a_block_carried_over_from_an_earlier_day_comes_back_unattached() {
        let pool = pool().await;
        let id = add_urgent(&pool, "old", "deep", "urgent-important", "2026-10-11").await;
        let got = day(&pool, MON).await;
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].id, id);
        assert_eq!((got[0].parent_kind.clone(), got[0].parent_id.clone()), (None, None));
        // ...but it is still attached on the day it was made for
        assert!(day(&pool, "2026-10-11").await[0].parent_kind.is_some());
    }

    #[tokio::test]
    async fn an_unattached_block_can_be_attached_to_a_cue_or_a_block_for_the_new_day() {
        let pool = pool().await;
        let old = add_urgent(&pool, "old", "deep", "urgent-important", "2026-10-11").await;
        let old2 = add_urgent(&pool, "old2", "routine", "important", "2026-10-11").await;
        let cue = fresh_cue(&pool).await;

        attach_block_in(&pool, &old, cue_ref(&cue), MON).await.unwrap();
        attach_block_in(&pool, &old2, block_ref(&old), MON).await.unwrap();

        let got = day(&pool, MON).await;
        let by_id = |id: &str| got.iter().find(|b| b.id == id).unwrap().clone();
        assert_eq!(by_id(&old).parent_id.as_deref(), Some(cue.as_str()));
        assert_eq!(by_id(&old2).parent_id.as_deref(), Some(old.as_str()));
    }

    #[tokio::test]
    async fn attaching_in_front_of_an_existing_follower_inserts_like_creating_does() {
        let pool = pool().await;
        let cue = fresh_cue(&pool).await;
        let a = create(&pool, "a", "deep", Some("important"), Some(cue_ref(&cue)), MON).await.unwrap();
        let carried = add_urgent(&pool, "carried", "routine", "important", "2026-10-11").await;

        attach_block_in(&pool, &carried, cue_ref(&cue), MON).await.unwrap();

        assert_eq!(follows(&pool, &carried).await, cue_of(&cue));
        assert_eq!(follows(&pool, &a).await, block_of(&carried));
    }

    #[tokio::test]
    async fn a_block_that_brings_its_own_followers_goes_in_front_of_the_old_follower_as_a_whole() {
        let pool = pool().await;
        let cue = fresh_cue(&pool).await;
        let d = create(&pool, "d", "deep", Some("important"), Some(cue_ref(&cue)), MON).await.unwrap();

        // x has no place today but y already follows it
        let x = add_urgent(&pool, "x", "routine", "important", "2026-10-11").await;
        let y = add_urgent(&pool, "y", "routine", "important", "2026-10-11").await;
        sqlx::query("UPDATE containers SET parent_kind = 'block', parent_id = $1, scheduled_on = $2 WHERE focus_block_id = $3")
            .bind(&x)
            .bind(MON)
            .bind(&y)
            .execute(&pool)
            .await
            .unwrap();

        attach_block_in(&pool, &x, cue_ref(&cue), MON).await.unwrap();

        // cue -> x -> y -> d
        assert_eq!(follows(&pool, &x).await, cue_of(&cue));
        assert_eq!(follows(&pool, &y).await, block_of(&x));
        assert_eq!(follows(&pool, &d).await, block_of(&y));
    }

    #[tokio::test]
    async fn attaching_is_refused_for_blocks_that_are_already_placed_finished_dropped_or_missing() {
        let pool = pool().await;
        let cue = fresh_cue(&pool).await;
        let other = fresh_cue(&pool).await;
        let placed = create(&pool, "placed", "deep", Some("important"), Some(cue_ref(&cue)), MON).await.unwrap();
        assert!(attach_block_in(&pool, &placed, cue_ref(&other), MON).await.unwrap_err().contains("already attached"));

        let done = add_urgent(&pool, "done", "deep", "important", "2026-10-11").await;
        sqlx::query("UPDATE focus_blocks SET is_completed = 1 WHERE id = $1").bind(&done).execute(&pool).await.unwrap();
        assert!(attach_block_in(&pool, &done, cue_ref(&other), MON).await.is_err());

        let dropped = add_urgent(&pool, "dropped", "deep", "important", "2026-10-11").await;
        dismiss_block_in(&pool, &dropped).await.unwrap();
        assert!(attach_block_in(&pool, &dropped, cue_ref(&other), MON).await.is_err());

        assert!(attach_block_in(&pool, "ghost", cue_ref(&other), MON).await.is_err());

        let q4 = create(&pool, "q4", "deep", Some("neither"), None, MON).await.unwrap();
        assert!(attach_block_in(&pool, &q4, cue_ref(&other), MON).await.is_err());
    }

    #[tokio::test]
    async fn a_block_cannot_be_attached_after_itself_or_after_one_of_its_own_followers() {
        let pool = pool().await;
        let x = add_urgent(&pool, "x", "routine", "important", "2026-10-11").await;
        let y = add_urgent(&pool, "y", "routine", "important", "2026-10-11").await;
        sqlx::query("UPDATE containers SET parent_kind = 'block', parent_id = $1, scheduled_on = $2 WHERE focus_block_id = $3")
            .bind(&x)
            .bind(MON)
            .bind(&y)
            .execute(&pool)
            .await
            .unwrap();

        assert!(attach_block_in(&pool, &x, block_ref(&x), MON).await.is_err());
        let err = attach_block_in(&pool, &x, block_ref(&y), MON).await.unwrap_err();
        assert!(err.contains("own followers"), "{err}");
    }

    #[tokio::test]
    async fn attaching_checks_the_new_parent_like_creating_does() {
        let pool = pool().await;
        let old = add_urgent(&pool, "old", "deep", "important", "2026-10-11").await;
        insert_cue(&pool, "tue-only", "[2]", false).await;
        assert!(attach_block_in(&pool, &old, cue_ref("tue-only"), MON).await.is_err());
        assert!(attach_block_in(&pool, &old, cue_ref("nope"), MON).await.is_err());
        assert!(attach_block_in(&pool, &old, ParentRef::new("moon", "x"), MON).await.is_err());
        assert!(attach_block_in(&pool, &old, cue_ref("tue-only"), "bad").await.is_err());
    }

    // ----- dropping blocks -----

    #[tokio::test]
    async fn dropping_a_block_closes_the_gap_and_hides_it() {
        let pool = pool().await;
        let cue = fresh_cue(&pool).await;
        let a = create(&pool, "a", "deep", Some("important"), Some(cue_ref(&cue)), MON).await.unwrap();
        let b = create(&pool, "b", "routine", Some("important"), Some(block_ref(&a)), MON).await.unwrap();
        let c = create(&pool, "c", "routine", Some("important"), Some(block_ref(&b)), MON).await.unwrap();

        dismiss_block_in(&pool, &b).await.unwrap();

        assert_eq!(follows(&pool, &c).await, block_of(&a)); // a -> c
        assert_eq!(follows(&pool, &b).await, None);
        assert_eq!(titles(&pool, MON).await, vec!["a", "c"]);
    }

    #[tokio::test]
    async fn dropping_the_first_block_links_the_next_one_to_the_cue() {
        let pool = pool().await;
        let cue = fresh_cue(&pool).await;
        let a = create(&pool, "a", "deep", Some("important"), Some(cue_ref(&cue)), MON).await.unwrap();
        let b = create(&pool, "b", "routine", Some("important"), Some(block_ref(&a)), MON).await.unwrap();
        dismiss_block_in(&pool, &a).await.unwrap();
        assert_eq!(follows(&pool, &b).await, cue_of(&cue));
    }

    #[tokio::test]
    async fn dropping_the_last_block_just_removes_it_and_it_can_be_done_with_an_unattached_one() {
        let pool = pool().await;
        let cue = fresh_cue(&pool).await;
        let a = create(&pool, "a", "deep", Some("important"), Some(cue_ref(&cue)), MON).await.unwrap();
        dismiss_block_in(&pool, &a).await.unwrap();
        assert!(titles(&pool, MON).await.is_empty());

        let old = add_urgent(&pool, "old", "deep", "important", "2026-10-11").await;
        dismiss_block_in(&pool, &old).await.unwrap();
        assert!(titles(&pool, MON).await.is_empty());
    }

    #[tokio::test]
    async fn a_dropped_block_is_not_completed_and_never_comes_back() {
        let pool = pool().await;
        let id = add_urgent(&pool, "gone", "deep", "urgent-important", "2026-10-10").await;
        dismiss_block_in(&pool, &id).await.unwrap();
        let (dismissed, completed): (bool, bool) = sqlx::query_as("SELECT dismissed, is_completed FROM focus_blocks WHERE id = $1").bind(&id).fetch_one(&pool).await.unwrap();
        assert!(dismissed && !completed);
        for d in ["2026-10-10", "2026-10-11", MON] {
            assert!(day(&pool, d).await.is_empty(), "{d}");
        }
    }

    #[tokio::test]
    async fn dropping_a_block_that_does_not_exist_is_an_error() {
        assert!(dismiss_block_in(&pool().await, "ghost").await.is_err());
    }

    // ----- the day's list -----

    #[tokio::test]
    async fn the_day_list_excludes_days_that_have_not_started() {
        let pool = pool().await;
        add(&pool, "today", 0, "deep", MON).await;
        add(&pool, "tomorrow", 1, "deep", "2026-10-13").await;
        assert_eq!(titles(&pool, MON).await, vec!["today"]);
    }

    #[tokio::test]
    async fn unfinished_urgent_and_important_work_carries_over_to_later_days() {
        let pool = pool().await;
        add_urgent(&pool, "q1", "deep", "urgent-important", "2026-10-10").await;
        add_urgent(&pool, "q2", "routine", "important", "2026-10-11").await;
        add_urgent(&pool, "q3", "routine", "urgent", "2026-10-11").await;
        let mut got = titles(&pool, MON).await;
        got.sort();
        assert_eq!(got, vec!["q1", "q2", "q3"]);
    }

    #[tokio::test]
    async fn a_q4_block_is_only_listed_on_the_day_it_was_made() {
        let pool = pool().await;
        add_urgent(&pool, "drop me", "routine", "neither", "2026-10-11").await;
        assert_eq!(titles(&pool, "2026-10-11").await, vec!["drop me"]);
        assert!(titles(&pool, MON).await.is_empty());
    }

    #[tokio::test]
    async fn rest_blocks_do_not_carry_over() {
        let pool = pool().await;
        add(&pool, "old reset", 0, "reset", "2026-10-11").await;
        add(&pool, "old recharge", 1, "recharge", "2026-10-11").await;
        assert!(titles(&pool, MON).await.is_empty());
        assert_eq!(titles(&pool, "2026-10-11").await.len(), 2);
    }

    #[tokio::test]
    async fn finished_blocks_stay_on_their_own_day_only() {
        let pool = pool().await;
        let id = add_urgent(&pool, "done", "deep", "urgent-important", "2026-10-11").await;
        // Finished on the 11th at 10:15 (615 minutes after midnight).
        sqlx::query("UPDATE focus_blocks SET is_completed = 1 WHERE id = $1").bind(&id).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO commitments (id, block_id, on_date, cue_id, start_min, duration_min, status, started_at, finished_at, finished_min) VALUES ('c', $1, '2026-10-11', 'x', 600, 30, 'finished', 1, 2, 615)")
            .bind(&id)
            .execute(&pool)
            .await
            .unwrap();

        let that_day = day(&pool, "2026-10-11").await;
        assert_eq!(that_day.len(), 1);
        assert!(that_day[0].is_completed && that_day[0].committed);
        assert_eq!(that_day[0].ended_at_min, Some(615));
        assert!(day(&pool, MON).await.is_empty()); // it is not carried over
    }

    #[tokio::test]
    async fn a_finished_block_without_a_finished_commitment_is_not_listed() {
        let pool = pool().await;
        add(&pool, "done", 0, "deep", MON).await;
        sqlx::query("UPDATE focus_blocks SET is_completed = 1").execute(&pool).await.unwrap();
        assert!(day(&pool, MON).await.is_empty());
    }

    #[tokio::test]
    async fn the_list_says_whether_the_user_started_a_block() {
        let pool = pool().await;
        let a = add(&pool, "a", 0, "deep", MON).await;
        add(&pool, "b", 1, "deep", MON).await;
        sqlx::query("INSERT INTO commitments (id, block_id, on_date, cue_id, start_min, duration_min, status, started_at) VALUES ('c', $1, $2, 'x', 600, 30, 'started', 1700000000)")
            .bind(&a)
            .bind(MON)
            .execute(&pool)
            .await
            .unwrap();
        let committed: Vec<(String, bool)> = day(&pool, MON).await.into_iter().map(|b| (b.title, b.committed)).collect();
        assert_eq!(committed, vec![("a".to_string(), true), ("b".to_string(), false)]);
    }

    #[tokio::test]
    async fn the_list_reports_type_urgency_and_the_day_a_block_was_made_in_order() {
        let pool = pool().await;
        add(&pool, "second", 1, "routine", MON).await;
        add_urgent(&pool, "old", "deep", "urgent-important", "2026-10-10").await;
        add(&pool, "first", 0, "deep", MON).await;
        let facts: Vec<(String, String, Option<String>, String)> =
            day(&pool, MON).await.into_iter().map(|b| (b.title, b.block_type, b.urgency, b.created_on)).collect();
        assert_eq!(
            facts,
            vec![
                ("old".into(), "deep".into(), Some("urgent-important".into()), "2026-10-10".into()),
                ("first".into(), "deep".into(), Some("important".into()), MON.into()),
                ("second".into(), "routine".into(), Some("important".into()), MON.into()),
            ]
        );
    }

    #[tokio::test]
    async fn a_block_saved_without_a_length_is_listed_as_thirty_minutes() {
        let pool = pool().await;
        sqlx::query("INSERT INTO focus_blocks (id, is_completed) VALUES ('b1', 0)").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO containers (id, focus_block_id, order_index, task_title, block_type, created_on, urgency) VALUES ('c1', 'b1', 0, 'old', 'deep', $1, 'important')")
            .bind(MON)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(day(&pool, MON).await[0].duration_min, 30);
    }

    #[tokio::test]
    async fn creating_a_container_returns_the_id_of_the_new_block() {
        let pool = pool().await;
        let cue = fresh_cue(&pool).await;
        let id = create(&pool, "x", "deep", Some("important"), Some(cue_ref(&cue)), MON).await.unwrap();
        let listed = day(&pool, MON).await;
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, id);
    }

    #[tokio::test]
    async fn invalid_input_is_rejected_and_nothing_is_stored() {
        let pool = pool().await;
        let cue = Some(cue_ref(&fresh_cue(&pool).await));
        let imp = Some("important");
        assert!(create(&pool, "x", "nope", imp, cue.clone(), MON).await.is_err());
        assert!(create(&pool, "x", "deep", imp, cue.clone(), "bad").await.is_err());
        // Work must be classified; rest must not be.
        assert!(create(&pool, "x", "deep", None, cue.clone(), MON).await.is_err());
        assert!(create(&pool, "x", "routine", Some("nope"), cue.clone(), MON).await.is_err());
        assert!(create(&pool, "x", "reset", imp, cue.clone(), MON).await.is_err());
        assert!(day(&pool, MON).await.is_empty());
    }

    // ----- what crosses to the frontend -----

    // The TypeScript side (src/dayPlan.ts) reads exactly these names; a rename here would
    // otherwise only show up at runtime as a block that mysteriously has no length or parent.
    #[test]
    fn a_day_block_is_sent_to_the_frontend_with_the_field_names_it_reads() {
        let block = DayBlock {
            id: "b".into(),
            block_type: "deep".into(),
            order_index: 0,
            title: "t".into(),
            urgency: Some("important".into()),
            created_on: "2026-10-12".into(),
            duration_min: 30,
            parent_kind: Some("cue".into()),
            parent_id: Some("c".into()),
            is_completed: false,
            ended_at_min: Some(615),
            committed: true,
        };
        let json = serde_json::to_value(&block).unwrap();
        let mut keys: Vec<&str> = json.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec!["blockType", "committed", "createdOn", "durationMin", "endedAtMin", "id", "isCompleted", "orderIndex", "parentId", "parentKind", "title", "urgency"]
        );
    }

    #[test]
    fn the_parent_the_frontend_sends_is_read_as_kind_and_id() {
        let parent: ParentRef = serde_json::from_str(r#"{"kind":"block","id":"abc"}"#).unwrap();
        assert_eq!(parent, ParentRef { kind: "block".into(), id: "abc".into() });
    }

    // ----- apps and older data -----

    fn app(label: &str, url: &str) -> AppEntry {
        AppEntry { label: label.into(), url: url.into(), icon: None }
    }

    #[test]
    fn apps_round_trip_through_json_and_an_empty_list_is_stored_as_null() {
        let apps = vec![app("Docs", "https://example.com/docs"), AppEntry { label: "VS Code".into(), url: "vscode://".into(), icon: Some("i.png".into()) }];
        let stored = apps_to_json(&apps).unwrap();
        assert_eq!(apps_from_json(stored.as_deref()), apps);
        assert_eq!(apps_to_json(&[]).unwrap(), None);
    }

    #[test]
    fn missing_or_damaged_apps_read_as_no_apps() {
        assert!(apps_from_json(None).is_empty());
        assert!(apps_from_json(Some("not json")).is_empty());
        assert!(apps_from_json(Some("{\"a\":1}")).is_empty());
    }

    #[tokio::test]
    async fn the_apps_of_a_new_block_are_saved_with_it() {
        let pool = pool().await;
        let apps = vec![app("Docs", "https://example.com/docs")];
        let mut n = new_block("x", "deep", Some("important"), Some(cue_ref(&fresh_cue(&pool).await)), MON);
        n.apps = apps.clone();
        create_container_in(&pool, n).await.unwrap();
        let stored: Option<String> = sqlx::query_scalar("SELECT apps FROM containers").fetch_one(&pool).await.unwrap();
        assert_eq!(apps_from_json(stored.as_deref()), apps);
    }

    #[tokio::test]
    async fn a_block_without_apps_stores_null() {
        let pool = pool().await;
        add(&pool, "x", 0, "deep", MON).await;
        let stored: Option<String> = sqlx::query_scalar("SELECT apps FROM containers").fetch_one(&pool).await.unwrap();
        assert_eq!(stored, None);
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
        crate::db::init_cue_schema(&pool).await.unwrap();
        crate::db::init_commitment_schema(&pool).await.unwrap();

        assert!(day(&pool, MON).await.is_empty());
        add(&pool, "new", 1, "deep", MON).await;
        assert_eq!(day(&pool, MON).await.len(), 1);
    }

    // --- rescheduling a missed block ---------------------------------------------------------

    async fn commit(pool: &SqlitePool, block_id: &str, on: &str, cue_id: &str, start_min: i32, status: &str) {
        sqlx::query(
            "INSERT INTO commitments (id, block_id, on_date, cue_id, start_min, duration_min, status)
             VALUES ($1, $2, $3, $4, $5, 30, $6)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(block_id)
        .bind(on)
        .bind(cue_id)
        .bind(start_min)
        .bind(status)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn commitment_status(pool: &SqlitePool, block_id: &str) -> Option<String> {
        sqlx::query_scalar("SELECT status FROM commitments WHERE block_id = $1")
            .bind(block_id)
            .fetch_optional(pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn rescheduling_takes_a_missed_block_out_of_its_slot_and_clears_its_missed_mark() {
        let pool = pool().await;
        let cue = fresh_cue(&pool).await;
        let a = create(&pool, "A", "deep", Some("important"), Some(cue_ref(&cue)), MON).await.unwrap();
        let b = create(&pool, "B", "deep", Some("important"), Some(block_ref(&a)), MON).await.unwrap();
        let c = create(&pool, "C", "deep", Some("important"), Some(block_ref(&b)), MON).await.unwrap();
        commit(&pool, &b, MON, &cue, 600, "missed").await;

        reschedule_block_in(&pool, &b, MON).await.unwrap();

        assert_eq!(follows(&pool, &b).await, None); // waiting for a place
        assert_eq!(follows(&pool, &c).await, Some(("block".into(), a.clone()))); // the chain closed up around it
        assert_eq!(commitment_status(&pool, &b).await, None);
        // It is still a live block, not a dropped one.
        assert!(titles(&pool, MON).await.contains(&"B".to_string()));
    }

    #[tokio::test]
    async fn only_a_missed_block_can_be_rescheduled_and_a_refusal_changes_nothing() {
        for status in ["planned", "nagging", "started", "finished", "lapsed"] {
            let pool = pool().await;
            let cue = fresh_cue(&pool).await;
            let a = create(&pool, "A", "deep", Some("important"), Some(cue_ref(&cue)), MON).await.unwrap();
            commit(&pool, &a, MON, &cue, 600, status).await;

            assert!(reschedule_block_in(&pool, &a, MON).await.is_err(), "{status}");
            assert_eq!(follows(&pool, &a).await, Some(("cue".into(), cue.clone())), "{status}");
            assert_eq!(commitment_status(&pool, &a).await.as_deref(), Some(status));
        }
    }

    #[tokio::test]
    async fn a_block_with_no_commitment_that_day_or_that_does_not_exist_is_refused() {
        let pool = pool().await;
        let cue = fresh_cue(&pool).await;
        let a = create(&pool, "A", "deep", Some("important"), Some(cue_ref(&cue)), MON).await.unwrap();
        assert!(reschedule_block_in(&pool, &a, MON).await.is_err());
        assert!(reschedule_block_in(&pool, "ghost", MON).await.is_err());
        assert!(reschedule_block_in(&pool, &a, "not-a-date").await.is_err());
    }

    #[tokio::test]
    async fn a_dropped_block_cannot_be_rescheduled() {
        let pool = pool().await;
        let cue = fresh_cue(&pool).await;
        let a = create(&pool, "A", "deep", Some("important"), Some(cue_ref(&cue)), MON).await.unwrap();
        commit(&pool, &a, MON, &cue, 600, "missed").await;
        dismiss_block_in(&pool, &a).await.unwrap();
        assert!(reschedule_block_in(&pool, &a, MON).await.is_err());
    }

    #[tokio::test]
    async fn a_rescheduled_block_can_be_placed_again_and_planned_again() {
        // The missed commitment is frozen: planning skips it. This is why reschedule must clear it.
        use crate::commitments::{sync_commitments_in, PlannedBlock};
        let pool = pool().await;
        let first = fresh_cue(&pool).await;
        let second = fresh_cue(&pool).await;
        let a = create(&pool, "A", "deep", Some("important"), Some(cue_ref(&first)), MON).await.unwrap();
        commit(&pool, &a, MON, &first, 600, "missed").await;
        let plan = |cue: &str| vec![PlannedBlock { block_id: a.clone(), cue_id: cue.into(), start_min: 900, duration_min: 30 }];

        sync_commitments_in(&pool, MON, plan(&second)).await.unwrap();
        assert_eq!(commitment_status(&pool, &a).await.as_deref(), Some("missed")); // frozen: not re-planned

        reschedule_block_in(&pool, &a, MON).await.unwrap();
        attach_block_in(&pool, &a, cue_ref(&second), MON).await.unwrap();
        sync_commitments_in(&pool, MON, plan(&second)).await.unwrap();

        let row: (String, i32) = sqlx::query_as("SELECT status, start_min FROM commitments WHERE block_id = $1")
            .bind(&a)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row, ("planned".to_string(), 900));
    }

    // --- editing a block's details -----------------------------------------------------------

    fn edit(title: &str) -> BlockEdit {
        BlockEdit { title: title.into(), action_trigger: None, definition_of_done: None, apps: vec![] }
    }

    fn app_entry(label: &str, url: &str) -> AppEntry {
        AppEntry { label: label.into(), url: url.into(), icon: None }
    }

    #[tokio::test]
    async fn editing_changes_the_text_and_apps_and_reading_them_back_shows_it() {
        let pool = pool().await;
        let id = add(&pool, "Old title", 0, "deep", MON).await;

        let new = BlockEdit {
            title: "New title".into(),
            action_trigger: Some("Open the file".into()),
            definition_of_done: Some("Draft sent".into()),
            apps: vec![app_entry("Docs", "https://example.com")],
        };
        update_block_in(&pool, &id, new).await.unwrap();

        let got = get_block_details_in(&pool, &id).await.unwrap();
        assert_eq!(got.title, "New title");
        assert_eq!(got.action_trigger.as_deref(), Some("Open the file"));
        assert_eq!(got.definition_of_done.as_deref(), Some("Draft sent"));
        assert_eq!(got.apps, vec![app_entry("Docs", "https://example.com")]);
        assert_eq!(got.block_type, "deep");
        assert_eq!(titles(&pool, MON).await, vec!["New title"]); // the day's list shows it too
    }

    #[tokio::test]
    async fn editing_trims_the_text_and_turns_blank_optional_fields_into_nothing() {
        let pool = pool().await;
        let id = add(&pool, "x", 0, "deep", MON).await;
        let new = BlockEdit { title: "  Padded  ".into(), action_trigger: Some("   ".into()), definition_of_done: Some("".into()), apps: vec![] };
        update_block_in(&pool, &id, new).await.unwrap();

        let got = get_block_details_in(&pool, &id).await.unwrap();
        assert_eq!(got.title, "Padded");
        assert_eq!(got.action_trigger, None);
        assert_eq!(got.definition_of_done, None);
        assert!(got.apps.is_empty());
    }

    #[tokio::test]
    async fn editing_never_touches_the_length_urgency_place_or_commitment() {
        let pool = pool().await;
        let cue = fresh_cue(&pool).await;
        let id = create(&pool, "A", "deep", Some("urgent"), Some(cue_ref(&cue)), MON).await.unwrap();
        commit(&pool, &id, MON, &cue, 600, "nagging").await;
        let before = day(&pool, MON).await;

        update_block_in(&pool, &id, edit("Renamed")).await.unwrap();

        let after = day(&pool, MON).await;
        assert_eq!(after[0].title, "Renamed");
        assert_eq!((after[0].duration_min, after[0].urgency.clone(), after[0].parent_id.clone()), (before[0].duration_min, before[0].urgency.clone(), before[0].parent_id.clone()));
        assert_eq!(commitment_status(&pool, &id).await.as_deref(), Some("nagging"));
    }

    #[tokio::test]
    async fn a_block_that_needs_a_title_cannot_be_saved_without_one() {
        let pool = pool().await;
        for kind in ["deep", "routine", "reset"] {
            let id = add(&pool, "keep", 0, kind, MON).await;
            assert!(update_block_in(&pool, &id, edit("   ")).await.is_err(), "{kind}");
            assert_eq!(get_block_details_in(&pool, &id).await.unwrap().title, "keep", "{kind}");
        }
    }

    #[tokio::test]
    async fn a_recharge_block_has_nothing_to_edit() {
        let pool = pool().await;
        let id = add(&pool, "", 0, "recharge", MON).await;
        assert!(update_block_in(&pool, &id, edit("Anything")).await.is_err());
    }

    #[tokio::test]
    async fn only_deep_and_routine_blocks_can_have_apps() {
        let pool = pool().await;
        let reset = add(&pool, "Stretch", 0, "reset", MON).await;
        let mut with_app = edit("Stretch");
        with_app.apps = vec![app_entry("Docs", "https://example.com")];
        assert!(update_block_in(&pool, &reset, with_app).await.is_err());

        let routine = add(&pool, "Email", 1, "routine", MON).await;
        let mut ok = edit("Email");
        ok.apps = vec![app_entry("Mail", "https://mail.example.com")];
        assert!(update_block_in(&pool, &routine, ok).await.is_ok());
    }

    #[tokio::test]
    async fn an_app_needs_a_name_and_an_address() {
        let pool = pool().await;
        let id = add(&pool, "x", 0, "deep", MON).await;
        for bad in [app_entry("", "https://a.com"), app_entry("A", ""), app_entry("  ", "https://a.com"), app_entry("A", "  ")] {
            let mut e = edit("x");
            e.apps = vec![bad];
            assert!(update_block_in(&pool, &id, e).await.is_err());
        }
    }

    #[tokio::test]
    async fn a_missing_finished_or_dropped_block_cannot_be_edited_or_read() {
        let pool = pool().await;
        assert!(update_block_in(&pool, "ghost", edit("x")).await.is_err());
        assert!(get_block_details_in(&pool, "ghost").await.is_err());

        let done = add(&pool, "Done", 0, "deep", MON).await;
        sqlx::query("UPDATE focus_blocks SET is_completed = 1 WHERE id = $1").bind(&done).execute(&pool).await.unwrap();
        assert!(update_block_in(&pool, &done, edit("x")).await.is_err());

        let dropped = add(&pool, "Dropped", 1, "deep", MON).await;
        dismiss_block_in(&pool, &dropped).await.unwrap();
        assert!(update_block_in(&pool, &dropped, edit("x")).await.is_err());
        assert!(get_block_details_in(&pool, &dropped).await.is_err());
    }

    // --- cues that run on one date ------------------------------------------------------------

    async fn insert_dated_cue(pool: &SqlitePool, id: &str, on_date: &str) {
        sqlx::query("INSERT INTO cues (id, label, time_min, days, flex_min, ends_day, on_date) VALUES ($1, $1, 600, $2, 0, 0, $3)")
            .bind(id)
            .bind(format!("[{}]", weekday_of(on_date)))
            .bind(on_date)
            .execute(pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn a_block_can_follow_a_cue_for_one_date_on_that_date() {
        let pool = pool().await;
        insert_dated_cue(&pool, "once", MON).await;
        assert!(create(&pool, "A", "deep", Some("important"), Some(cue_ref("once")), MON).await.is_ok());
    }

    #[tokio::test]
    async fn a_cue_for_one_date_does_not_run_on_the_same_weekday_a_week_later() {
        // A weekly rule would let this through (both are Mondays); the date must win.
        let pool = pool().await;
        insert_dated_cue(&pool, "once", MON).await;
        let next_monday = "2026-10-19";
        let err = create(&pool, "A", "deep", Some("important"), Some(cue_ref("once")), next_monday).await.unwrap_err();
        assert!(err.contains("does not run"), "{err}");
    }

    #[tokio::test]
    async fn an_ordinary_cue_still_runs_every_week_on_its_days() {
        let pool = pool().await;
        let cue = fresh_cue(&pool).await;
        for day in [MON, "2026-10-19", "2026-11-02"] {
            assert!(create(&pool, "A", "deep", Some("important"), Some(cue_ref(&cue)), day).await.is_ok(), "{day}");
        }
    }

    #[test]
    fn the_rule_for_whether_a_cue_runs_on_a_day() {
        assert!(cue_runs_on(None, &[1], MON)); // Monday cue, a Monday
        assert!(!cue_runs_on(None, &[2], MON));
        assert!(cue_runs_on(Some(MON), &[1], MON)); // dated cue, its own date
        assert!(!cue_runs_on(Some(MON), &[1], "2026-10-19")); // same weekday, other date
        assert!(!cue_runs_on(Some("2026-10-13"), &[2], MON)); // a different date altogether
    }
}
