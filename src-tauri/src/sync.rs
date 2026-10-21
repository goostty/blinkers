//! Syncing the database between devices, one device at a time.
//!
//! The database stays local. A snapshot of it (one file, `blinkers-sync.db`) is kept in a folder
//! the user already syncs with something else (iCloud Drive, Dropbox, Syncthing...). Opening the
//! app pulls a newer snapshot; working and closing push one. Only one device is meant to be in use
//! at a time, so there is no live merging: if both copies changed since they last agreed, the user
//! is asked which to keep, and the other is backed up first.
//!
//! What a device remembers about syncing lives in `sync-state.json` next to the database, not in
//! it: the folder is different on every computer, and loading a snapshot replaces the database's
//! contents, so anything kept inside would be overwritten by the other device's copy.

use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{Connection, SqliteConnection, SqlitePool};
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub const SNAPSHOT_FILE: &str = "blinkers-sync.db";
const STATE_FILE: &str = "sync-state.json";
const BACKUP_DIR: &str = "backups";
const KEEP_BACKUPS: usize = 10;

// A device that wrote to the folder in the last ten minutes is probably still open. The app writes
// at least every few minutes while it runs (HEARTBEAT_SEC), so a quiet device soon looks closed.
const ACTIVE_WINDOW_SEC: i64 = 10 * 60;
const HEARTBEAT_SEC: i64 = 4 * 60;

// Every table that holds the user's data, with the column rows are ordered by. The order matters:
// the fingerprint must come out the same on every device for the same data.
const TABLES: [(&str, &str); 5] = [
    ("focus_blocks", "id"),
    ("containers", "id"),
    ("cues", "id"),
    ("commitments", "id"),
    ("settings", "key"),
];

// Settings that may be read and written from the screen. The sync happens to carry the whole
// settings table (the phone reminder topic is in it), so the screen only gets the one that is the
// day's own state, not a way to read or change the rest.
const SCREEN_SETTINGS: [&str; 1] = ["day_state"];

// ----- fingerprints -----

const FNV_OFFSET: u64 = 0xcbf29ce484222325;
const FNV_PRIME: u64 = 0x100000001b3;

// FNV-1a is a few lines, gives the same answer on every platform and version (unlike the standard
// library's hasher, which is allowed to change), and nothing here needs it to resist attack: it
// only has to tell "same data" from "different data".
fn feed(mut hash: u64, bytes: &[u8]) -> u64 {
    for b in bytes {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

fn db_err(e: sqlx::Error) -> String {
    e.to_string()
}

async fn columns(conn: &mut SqliteConnection, schema: &str, table: &str) -> Result<Vec<String>, String> {
    sqlx::query_scalar("SELECT name FROM pragma_table_info($1, $2) ORDER BY name")
        .bind(table)
        .bind(schema)
        .fetch_all(conn)
        .await
        .map_err(db_err)
}

// A short hash of every row in every table, in a fixed order, with the columns in name order. Two
// devices with the same data get the same fingerprint, which is how they tell they agree.
pub async fn fingerprint(pool: &SqlitePool) -> Result<String, String> {
    let mut conn = pool.acquire().await.map_err(db_err)?;
    let mut hash = FNV_OFFSET;
    for (table, order_by) in TABLES {
        let cols = columns(&mut conn, "main", table).await?;
        hash = feed(hash, table.as_bytes());
        if cols.is_empty() {
            continue;
        }
        // quote() writes every value (including NULL) as text, so no two different rows look alike
        let row = cols.iter().map(|c| format!("quote(\"{c}\")")).collect::<Vec<_>>().join("||char(31)||");
        let rows: Vec<String> = sqlx::query_scalar(&format!("SELECT {row} FROM {table} ORDER BY {order_by}"))
            .fetch_all(&mut *conn)
            .await
            .map_err(db_err)?;
        for r in rows {
            hash = feed(feed(hash, r.as_bytes()), b"\n");
        }
    }
    Ok(format!("{hash:016x}"))
}

// A hash of which tables and columns exist. Two versions of the app that store different things
// must not swap data: copying across would silently drop or invent fields.
async fn schema_hash(pool: &SqlitePool) -> Result<String, String> {
    let mut conn = pool.acquire().await.map_err(db_err)?;
    let mut hash = FNV_OFFSET;
    for (table, _) in TABLES {
        for c in columns(&mut conn, "main", table).await? {
            hash = feed(hash, format!("{table}.{c}\n").as_bytes());
        }
    }
    Ok(format!("{hash:016x}"))
}

async fn local_is_empty(pool: &SqlitePool) -> Result<bool, String> {
    let n: i64 = sqlx::query_scalar("SELECT (SELECT COUNT(*) FROM containers) + (SELECT COUNT(*) FROM cues)")
        .fetch_one(pool)
        .await
        .map_err(db_err)?;
    Ok(n == 0)
}

// ----- what to do -----

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    InSync,
    Push,
    Pull,
    Conflict,
    Nothing,
}

// Three fingerprints settle it: this device now (`local`), the folder's snapshot (`remote`) and
// what both agreed on at the last sync (`last`).
//   the same                  -> nothing to do
//   only the folder changed   -> take it
//   only this device changed  -> send it
//   both changed              -> ask the user, because merging would be a guess
// A device that has never synced has no `last`: if it has nothing yet it takes what is there, and
// if both have data that differs there is no shared history to say which is newer.
pub fn decide(local: &str, remote: Option<&str>, last: Option<&str>, local_empty: bool) -> Decision {
    match remote {
        None if local_empty => Decision::Nothing, // an empty snapshot would only confuse the other device
        None => Decision::Push,
        Some(r) if r == local => Decision::InSync,
        Some(r) => match last {
            Some(l) if l == local => Decision::Pull,
            Some(l) if l == r => Decision::Push,
            Some(_) => Decision::Conflict,
            None if local_empty => Decision::Pull,
            None => Decision::Conflict,
        },
    }
}

// ----- this device's own state -----

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncState {
    pub device_id: String,
    pub folder: Option<String>,
    pub last_fingerprint: Option<String>,
    pub last_synced_at: Option<i64>,
}

// A missing or damaged file is not an error worth stopping the app for: the device just starts
// over with a new id and syncing off, and the user can choose the folder again.
pub fn load_state(dir: &Path) -> SyncState {
    let mut state: SyncState = std::fs::read_to_string(dir.join(STATE_FILE))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    if state.device_id.is_empty() {
        state.device_id = Uuid::new_v4().to_string();
        save_state(dir, &state).ok();
    }
    state
}

// Written to a temp name and renamed, so a crash cannot leave half a file.
pub fn save_state(dir: &Path, state: &SyncState) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{STATE_FILE}.tmp"));
    let text = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join(STATE_FILE)).map_err(|e| e.to_string())
}

// Choosing a folder starts that folder's history from nothing: what was agreed with another folder
// says nothing about this one. `None` turns syncing off but keeps the device's id.
pub fn set_folder(dir: &Path, folder: Option<&str>) -> Result<SyncState, String> {
    let mut state = load_state(dir);
    match folder {
        None => state.folder = None,
        Some(path) => {
            let path = Path::new(path);
            if !path.is_dir() {
                return Err("That is not a folder that exists.".into());
            }
            // try it: a read-only folder would fail every sync later, far from where it was chosen
            let probe = path.join(format!(".blinkers-write-test-{}", Uuid::new_v4()));
            std::fs::write(&probe, b"").map_err(|_| "Blinkers cannot write to that folder.".to_string())?;
            std::fs::remove_file(&probe).ok();
            state.folder = Some(path.to_string_lossy().into_owned());
        }
    }
    state.last_fingerprint = None;
    state.last_synced_at = None;
    save_state(dir, &state)?;
    Ok(state)
}

// ----- the snapshot file -----

#[derive(Clone, Debug, PartialEq)]
pub struct RemoteMeta {
    pub fingerprint: String,
    pub schema: String,
    pub written_at: i64,
    pub device_id: String,
    pub device_name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub fingerprint: String,
    pub written_at: i64,
    pub device_id: String,
    pub device_name: String,
    pub this_device: bool,
    pub recently_active: bool,
}

pub fn remote_info(meta: &RemoteMeta, state: &SyncState, now: i64) -> RemoteInfo {
    let this_device = meta.device_id == state.device_id;
    RemoteInfo {
        fingerprint: meta.fingerprint.clone(),
        written_at: meta.written_at,
        device_id: meta.device_id.clone(),
        device_name: meta.device_name.clone(),
        this_device,
        // another device that wrote recently may still be open, and then both would send the
        // phone reminders. This device's own writes are never a reason to warn.
        recently_active: !this_device && now - meta.written_at < ACTIVE_WINDOW_SEC,
    }
}

async fn open_file(path: &Path, read_only: bool) -> Result<SqlitePool, String> {
    // Delete (not WAL) so a snapshot is always one self-contained file, never a file plus
    // side files that a sync tool might copy separately.
    let options = SqliteConnectOptions::new()
        .filename(path)
        .journal_mode(SqliteJournalMode::Delete)
        .read_only(read_only);
    SqlitePoolOptions::new().max_connections(1).connect_with(options).await.map_err(db_err)
}

// Writes the snapshot next to its final name and renames it into place, so a sync tool never
// uploads a half-written file. The facts about the snapshot are inside the file itself, so the
// data and its description cannot arrive separately.
pub async fn write_snapshot(
    pool: &SqlitePool,
    folder: &Path,
    device_id: &str,
    device_name: &str,
    now: i64,
) -> Result<String, String> {
    let fp = fingerprint(pool).await?;
    let schema = schema_hash(pool).await?;
    let tmp = folder.join(format!("{SNAPSHOT_FILE}.tmp-{}", Uuid::new_v4()));

    let built: Result<(), String> = async {
        sqlx::query("VACUUM INTO $1")
            .bind(tmp.to_string_lossy().into_owned())
            .execute(pool)
            .await
            .map_err(db_err)?;
        let snap = open_file(&tmp, false).await?;
        sqlx::query("CREATE TABLE sync_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)")
            .execute(&snap)
            .await
            .map_err(db_err)?;
        for (key, value) in [
            ("fingerprint", fp.clone()),
            ("schema", schema),
            ("written_at", now.to_string()),
            ("device_id", device_id.to_string()),
            ("device_name", device_name.to_string()),
        ] {
            sqlx::query("INSERT INTO sync_meta (key, value) VALUES ($1, $2)")
                .bind(key)
                .bind(value)
                .execute(&snap)
                .await
                .map_err(db_err)?;
        }
        snap.close().await;
        std::fs::rename(&tmp, folder.join(SNAPSHOT_FILE)).map_err(|e| e.to_string())
    }
    .await;

    if built.is_err() {
        std::fs::remove_file(&tmp).ok();
    }
    built.map(|_| fp)
}

// None when the folder has no snapshot yet. A file that is there but is not one of ours is an
// error and is left exactly as it is: it might be someone's data.
pub async fn read_remote(folder: &Path) -> Result<Option<RemoteMeta>, String> {
    let path = folder.join(SNAPSHOT_FILE);
    if !path.exists() {
        return Ok(None);
    }
    let not_ours = || "The sync folder has a file that is not a Blinkers snapshot.".to_string();
    let pool = open_file(&path, true).await.map_err(|_| not_ours())?;
    let rows: Result<Vec<(String, String)>, _> = sqlx::query_as("SELECT key, value FROM sync_meta").fetch_all(&pool).await;
    pool.close().await;
    let rows = rows.map_err(|_| not_ours())?;

    let get = |key: &str| rows.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone()).ok_or_else(not_ours);
    Ok(Some(RemoteMeta {
        fingerprint: get("fingerprint")?,
        schema: get("schema")?,
        written_at: get("written_at")?.parse().map_err(|_| not_ours())?,
        device_id: get("device_id")?,
        device_name: get("device_name")?,
    }))
}

// Replaces this device's data with the snapshot's, all or nothing: the rows are copied in one
// transaction, so a snapshot that cannot be read in full leaves the data exactly as it was. Only
// the columns both sides have are copied, and a column this side requires but the snapshot lacks
// makes the whole copy fail rather than invent a value.
pub async fn load_snapshot(pool: &SqlitePool, folder: &Path) -> Result<(), String> {
    let path = folder.join(SNAPSHOT_FILE);
    let mut conn = pool.acquire().await.map_err(db_err)?;
    sqlx::query("ATTACH DATABASE $1 AS snap")
        .bind(path.to_string_lossy().into_owned())
        .execute(&mut *conn)
        .await
        .map_err(db_err)?;

    let copied = copy_tables(&mut conn).await;
    sqlx::query("DETACH DATABASE snap").execute(&mut *conn).await.ok();
    copied
}

async fn copy_tables(conn: &mut SqliteConnection) -> Result<(), String> {
    let mut tx = conn.begin().await.map_err(db_err)?;
    for (table, _) in TABLES {
        let theirs = columns(&mut tx, "snap", table).await?;
        if theirs.is_empty() {
            return Err(format!("The snapshot has no {table} table."));
        }
        let ours = columns(&mut tx, "main", table).await?;
        let common = ours.iter().filter(|c| theirs.contains(c)).cloned().collect::<Vec<_>>().join(", ");
        sqlx::query(&format!("DELETE FROM main.{table}")).execute(&mut *tx).await.map_err(db_err)?;
        sqlx::query(&format!("INSERT INTO main.{table} ({common}) SELECT {common} FROM snap.{table}"))
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
    }
    tx.commit().await.map_err(db_err)
}

// ----- backups -----

// Anything about to be replaced is saved first, in the app's own folder (not the synced one), and
// only the newest few are kept.
fn backups_dir(dir: &Path) -> Result<PathBuf, String> {
    let backups = dir.join(BACKUP_DIR);
    std::fs::create_dir_all(&backups).map_err(|e| e.to_string())?;
    Ok(backups)
}

fn prune_backups(backups: &Path) {
    let mut files: Vec<_> = std::fs::read_dir(backups).into_iter().flatten().flatten().collect();
    files.sort_by_key(|f| f.file_name());
    while files.len() > KEEP_BACKUPS {
        std::fs::remove_file(files.remove(0).path()).ok();
    }
}

async fn backup_local(pool: &SqlitePool, dir: &Path, reason: &str, now: i64) -> Result<(), String> {
    let backups = backups_dir(dir)?;
    let file = backups.join(format!("blinkers-{now:012}-{reason}-{}.db", &Uuid::new_v4().to_string()[..8]));
    sqlx::query("VACUUM INTO $1").bind(file.to_string_lossy().into_owned()).execute(pool).await.map_err(db_err)?;
    prune_backups(&backups);
    Ok(())
}

fn backup_remote(folder: &Path, dir: &Path, now: i64) -> Result<(), String> {
    let backups = backups_dir(dir)?;
    let file = backups.join(format!("blinkers-{now:012}-other-device-{}.db", &Uuid::new_v4().to_string()[..8]));
    std::fs::copy(folder.join(SNAPSHOT_FILE), file).map_err(|e| e.to_string())?;
    prune_backups(&backups);
    Ok(())
}

// ----- syncing -----

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Outcome {
    Off,
    Nothing,
    InSync,
    Pushed,
    Pulled { remote: RemoteInfo },
    RemoteNewer { remote: RemoteInfo },
    Conflict { remote: RemoteInfo },
    VersionMismatch { remote: RemoteInfo },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Keep {
    ThisDevice,
    OtherDevice,
}

fn folder_of(state: &SyncState) -> Option<PathBuf> {
    state.folder.as_ref().map(PathBuf::from)
}

async fn pull(
    pool: &SqlitePool,
    dir: &Path,
    state: &mut SyncState,
    folder: &Path,
    remote: &RemoteMeta,
    now: i64,
) -> Result<Outcome, String> {
    backup_local(pool, dir, "before-pull", now).await?;
    load_snapshot(pool, folder).await?;
    // What was just taken is what both sides now agree on.
    state.last_fingerprint = Some(remote.fingerprint.clone());
    state.last_synced_at = Some(now);
    save_state(dir, state)?;
    Ok(Outcome::Pulled { remote: remote_info(remote, state, now) })
}

// One round of syncing. `allow_pull` is true when the app is opening or the user pressed Sync:
// taking newer data replaces what is on screen, which must never happen by itself while the user
// is working, so the periodic check passes false and only reports that newer data is waiting.
pub async fn sync_now(
    pool: &SqlitePool,
    dir: &Path,
    allow_pull: bool,
    now: i64,
    device_name: &str,
) -> Result<Outcome, String> {
    let mut state = load_state(dir);
    let Some(folder) = folder_of(&state) else { return Ok(Outcome::Off) };

    let remote = read_remote(&folder).await?;
    if let Some(r) = &remote {
        if r.schema != schema_hash(pool).await? {
            return Ok(Outcome::VersionMismatch { remote: remote_info(r, &state, now) });
        }
    }
    let local = fingerprint(pool).await?;
    let decision = decide(&local, remote.as_ref().map(|r| r.fingerprint.as_str()), state.last_fingerprint.as_deref(), local_is_empty(pool).await?);

    match (decision, remote) {
        (Decision::Nothing, _) => Ok(Outcome::Nothing),
        (Decision::InSync, remote) => {
            state.last_fingerprint = Some(local);
            state.last_synced_at = Some(now);
            save_state(dir, &state)?;
            // While the app runs the snapshot is touched now and then, so the other device can tell
            // this one is in use (it would otherwise look closed and send duplicate reminders).
            if remote.is_some_and(|r| now - r.written_at >= HEARTBEAT_SEC) {
                write_snapshot(pool, &folder, &state.device_id, device_name, now).await?;
            }
            Ok(Outcome::InSync)
        }
        (Decision::Push, _) => {
            let fp = write_snapshot(pool, &folder, &state.device_id, device_name, now).await?;
            state.last_fingerprint = Some(fp);
            state.last_synced_at = Some(now);
            save_state(dir, &state)?;
            Ok(Outcome::Pushed)
        }
        (Decision::Pull, Some(r)) if allow_pull => pull(pool, dir, &mut state, &folder, &r, now).await,
        (Decision::Pull, Some(r)) => Ok(Outcome::RemoteNewer { remote: remote_info(&r, &state, now) }),
        (Decision::Conflict, Some(r)) => Ok(Outcome::Conflict { remote: remote_info(&r, &state, now) }),
        (Decision::Pull | Decision::Conflict, None) => Err("The sync folder lost its snapshot while syncing.".into()),
    }
}

// The user's answer to a conflict. Whichever copy loses is saved in the backups folder first, so
// the choice can be undone by hand.
pub async fn resolve(pool: &SqlitePool, dir: &Path, keep: Keep, now: i64, device_name: &str) -> Result<Outcome, String> {
    let mut state = load_state(dir);
    let folder = folder_of(&state).ok_or("Syncing is off.")?;
    let remote = read_remote(&folder).await?.ok_or("There is nothing in the sync folder to choose between.")?;
    if remote.schema != schema_hash(pool).await? {
        return Ok(Outcome::VersionMismatch { remote: remote_info(&remote, &state, now) });
    }
    match keep {
        Keep::OtherDevice => pull(pool, dir, &mut state, &folder, &remote, now).await,
        Keep::ThisDevice => {
            backup_remote(&folder, dir, now)?;
            let fp = write_snapshot(pool, &folder, &state.device_id, device_name, now).await?;
            state.last_fingerprint = Some(fp);
            state.last_synced_at = Some(now);
            save_state(dir, &state)?;
            Ok(Outcome::Pushed)
        }
    }
}

// ----- what the screen shows -----

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub enabled: bool,
    pub folder: Option<String>,
    pub device_id: String,
    pub last_synced_at: Option<i64>,
    pub remote: Option<RemoteInfo>,
    // off | no_remote | in_sync | local_changes | remote_newer | conflict | version_mismatch
    pub state: String,
}

// Where things stand, found out without changing anything.
pub async fn status(pool: &SqlitePool, dir: &Path, now: i64) -> Result<SyncStatus, String> {
    let state = load_state(dir);
    let mut out = SyncStatus {
        enabled: state.folder.is_some(),
        folder: state.folder.clone(),
        device_id: state.device_id.clone(),
        last_synced_at: state.last_synced_at,
        remote: None,
        state: "off".into(),
    };
    let Some(folder) = folder_of(&state) else { return Ok(out) };

    let remote = read_remote(&folder).await?;
    out.remote = remote.as_ref().map(|r| remote_info(r, &state, now));
    out.state = match &remote {
        None => "no_remote",
        Some(r) if r.schema != schema_hash(pool).await? => "version_mismatch",
        Some(r) => match decide(&fingerprint(pool).await?, Some(&r.fingerprint), state.last_fingerprint.as_deref(), local_is_empty(pool).await?) {
            Decision::InSync => "in_sync",
            Decision::Push => "local_changes",
            Decision::Pull => "remote_newer",
            Decision::Conflict => "conflict",
            Decision::Nothing => "no_remote",
        },
    }
    .into();
    Ok(out)
}

// ----- the day's choices -----

pub async fn get_setting_in(pool: &SqlitePool, key: &str) -> Result<Option<String>, String> {
    if !SCREEN_SETTINGS.contains(&key) {
        return Err(format!("{key} is not a setting the screen may read."));
    }
    sqlx::query_scalar("SELECT value FROM settings WHERE key = $1")
        .bind(key)
        .fetch_optional(pool)
        .await
        .map_err(db_err)
}

pub async fn set_setting_in(pool: &SqlitePool, key: &str, value: &str) -> Result<(), String> {
    if !SCREEN_SETTINGS.contains(&key) {
        return Err(format!("{key} is not a setting the screen may change."));
    }
    sqlx::query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(key)
        .bind(value)
        .execute(pool)
        .await
        .map_err(db_err)?;
    Ok(())
}

// ----- the commands the screen calls -----

pub struct SyncDir(pub PathBuf);

fn now_unix() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

// Shown to the user on the other device, so they can tell which computer last wrote.
fn device_name() -> String {
    std::process::Command::new("hostname")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "another device".to_string())
}

#[tauri::command]
pub async fn get_sync_status(
    db: tauri::State<'_, crate::db::DbState>,
    dir: tauri::State<'_, SyncDir>,
) -> Result<SyncStatus, String> {
    status(&db.pool, &dir.0, now_unix()).await
}

#[tauri::command]
pub async fn set_sync_folder(
    folder: Option<String>,
    db: tauri::State<'_, crate::db::DbState>,
    dir: tauri::State<'_, SyncDir>,
) -> Result<SyncStatus, String> {
    set_folder(&dir.0, folder.as_deref())?;
    status(&db.pool, &dir.0, now_unix()).await
}

#[tauri::command]
pub async fn run_sync(
    allow_pull: bool,
    db: tauri::State<'_, crate::db::DbState>,
    dir: tauri::State<'_, SyncDir>,
) -> Result<Outcome, String> {
    sync_now(&db.pool, &dir.0, allow_pull, now_unix(), &device_name()).await
}

#[tauri::command]
pub async fn sync_resolve(
    keep: String,
    db: tauri::State<'_, crate::db::DbState>,
    dir: tauri::State<'_, SyncDir>,
) -> Result<Outcome, String> {
    let keep = match keep.as_str() {
        "this" => Keep::ThisDevice,
        "other" => Keep::OtherDevice,
        _ => return Err("Choose this device or the other one.".into()),
    };
    resolve(&db.pool, &dir.0, keep, now_unix(), &device_name()).await
}

#[tauri::command]
pub async fn get_synced_setting(key: String, db: tauri::State<'_, crate::db::DbState>) -> Result<Option<String>, String> {
    get_setting_in(&db.pool, &key).await
}

#[tauri::command]
pub async fn set_synced_setting(key: String, value: String, db: tauri::State<'_, crate::db::DbState>) -> Result<(), String> {
    set_setting_in(&db.pool, &key, &value).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{db_init, db_path};
    use sqlx::SqlitePool;
    use std::path::PathBuf;

    const NOW: i64 = 1_800_000_000;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("blinkers-sync-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // One device: its own app-data folder and database, as on a separate computer.
    struct Device {
        pool: SqlitePool,
        dir: PathBuf,
    }

    async fn device() -> Device {
        let dir = scratch();
        let pool = db_init(&db_path(&dir).unwrap()).await.unwrap().pool;
        Device { pool, dir }
    }

    async fn add_cue(pool: &SqlitePool, id: &str, label: &str) {
        sqlx::query("INSERT INTO cues (id, label, time_min, days, flex_min, ends_day) VALUES ($1, $2, 420, '[0,1,2,3,4,5,6]', 0, 0)")
            .bind(id)
            .bind(label)
            .execute(pool)
            .await
            .unwrap();
    }

    async fn add_block(pool: &SqlitePool, id: &str, title: &str) {
        sqlx::query("INSERT INTO focus_blocks (id, is_completed) VALUES ($1, 0)").bind(id).execute(pool).await.unwrap();
        sqlx::query("INSERT INTO containers (id, focus_block_id, order_index, task_title) VALUES ($1, $1, 0, $2)")
            .bind(id)
            .bind(title)
            .execute(pool)
            .await
            .unwrap();
    }

    async fn cue_labels(pool: &SqlitePool) -> Vec<String> {
        sqlx::query_scalar("SELECT label FROM cues ORDER BY label").fetch_all(pool).await.unwrap()
    }

    async fn sync(d: &Device, folder: &PathBuf, allow_pull: bool) -> Outcome {
        // choosing a folder starts its history afresh, so it is only chosen once per device
        if load_state(&d.dir).folder.as_deref() != folder.to_str() {
            set_folder(&d.dir, Some(folder.to_str().unwrap())).unwrap();
        }
        sync_now(&d.pool, &d.dir, allow_pull, NOW, "laptop").await.unwrap()
    }

    // ----- the fingerprint -----

    #[tokio::test]
    async fn an_empty_database_has_the_same_fingerprint_every_time() {
        let (a, b) = (device().await, device().await);
        assert_eq!(fingerprint(&a.pool).await.unwrap(), fingerprint(&b.pool).await.unwrap());
        assert_eq!(fingerprint(&a.pool).await.unwrap().len(), 16);
    }

    #[tokio::test]
    async fn the_fingerprint_changes_when_anything_in_the_data_changes() {
        let a = device().await;
        let empty = fingerprint(&a.pool).await.unwrap();
        add_cue(&a.pool, "c1", "Wake").await;
        let with_cue = fingerprint(&a.pool).await.unwrap();
        assert_ne!(empty, with_cue);
        sqlx::query("UPDATE cues SET label = 'Wake up' WHERE id = 'c1'").execute(&a.pool).await.unwrap();
        assert_ne!(with_cue, fingerprint(&a.pool).await.unwrap());
    }

    #[tokio::test]
    async fn the_same_data_has_the_same_fingerprint_whatever_order_it_was_added_in() {
        let (a, b) = (device().await, device().await);
        add_cue(&a.pool, "c1", "Wake").await;
        add_cue(&a.pool, "c2", "Lunch").await;
        add_cue(&b.pool, "c2", "Lunch").await;
        add_cue(&b.pool, "c1", "Wake").await;
        assert_eq!(fingerprint(&a.pool).await.unwrap(), fingerprint(&b.pool).await.unwrap());
    }

    // ----- what to do -----

    #[test]
    fn equal_copies_are_in_sync() {
        assert_eq!(decide("a", Some("a"), Some("z"), false), Decision::InSync);
    }

    #[test]
    fn when_only_the_other_device_changed_it_is_pulled() {
        assert_eq!(decide("a", Some("b"), Some("a"), false), Decision::Pull);
    }

    #[test]
    fn when_only_this_device_changed_it_is_pushed() {
        assert_eq!(decide("b", Some("a"), Some("a"), false), Decision::Push);
    }

    #[test]
    fn when_both_changed_it_is_a_conflict_and_never_decided_silently() {
        assert_eq!(decide("b", Some("c"), Some("a"), false), Decision::Conflict);
    }

    #[test]
    fn a_first_sync_pulls_into_an_empty_device_and_pushes_to_an_empty_folder() {
        assert_eq!(decide("e", Some("r"), None, true), Decision::Pull);
        assert_eq!(decide("a", None, None, false), Decision::Push);
    }

    #[test]
    fn a_first_sync_where_both_have_data_and_differ_is_a_conflict() {
        assert_eq!(decide("a", Some("r"), None, false), Decision::Conflict);
    }

    #[test]
    fn an_empty_device_does_not_put_an_empty_snapshot_in_an_empty_folder() {
        assert_eq!(decide("e", None, None, true), Decision::Nothing);
    }

    // ----- the snapshot file -----

    #[tokio::test]
    async fn a_snapshot_is_one_file_that_says_who_wrote_it_and_what_it_holds() {
        let (a, folder) = (device().await, scratch());
        add_cue(&a.pool, "c1", "Wake").await;
        let fp = write_snapshot(&a.pool, &folder, "dev-a", "laptop", NOW).await.unwrap();

        let meta = read_remote(&folder).await.unwrap().unwrap();
        assert_eq!(fp, fingerprint(&a.pool).await.unwrap());
        assert_eq!((meta.fingerprint.as_str(), meta.device_id.as_str(), meta.device_name.as_str(), meta.written_at), (fp.as_str(), "dev-a", "laptop", NOW));
        // only the finished file is left behind: no temp file for a sync tool to pick up
        let files: Vec<String> = std::fs::read_dir(&folder).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(files, vec!["blinkers-sync.db"]);
    }

    #[tokio::test]
    async fn writing_a_snapshot_again_replaces_the_old_one() {
        let (a, folder) = (device().await, scratch());
        write_snapshot(&a.pool, &folder, "dev-a", "laptop", NOW).await.unwrap();
        add_cue(&a.pool, "c1", "Wake").await;
        let second = write_snapshot(&a.pool, &folder, "dev-a", "laptop", NOW + 60).await.unwrap();
        let meta = read_remote(&folder).await.unwrap().unwrap();
        assert_eq!((meta.fingerprint, meta.written_at), (second, NOW + 60));
    }

    #[tokio::test]
    async fn there_is_nothing_remote_until_a_snapshot_is_written() {
        assert!(read_remote(&scratch()).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn a_file_that_is_not_a_snapshot_is_refused_and_left_alone() {
        let folder = scratch();
        std::fs::write(folder.join("blinkers-sync.db"), b"not a database").unwrap();
        assert!(read_remote(&folder).await.is_err());
        assert_eq!(std::fs::read(folder.join("blinkers-sync.db")).unwrap(), b"not a database");
    }

    // ----- loading a snapshot -----

    #[tokio::test]
    async fn loading_a_snapshot_replaces_this_devices_data_with_the_snapshots() {
        let (a, b, folder) = (device().await, device().await, scratch());
        add_cue(&a.pool, "c1", "Wake").await;
        add_block(&a.pool, "b1", "Write").await;
        write_snapshot(&a.pool, &folder, "dev-a", "laptop", NOW).await.unwrap();
        add_cue(&b.pool, "x", "Only on b").await;

        load_snapshot(&b.pool, &folder).await.unwrap();

        assert_eq!(cue_labels(&b.pool).await, vec!["Wake"]);
        let titles: Vec<String> = sqlx::query_scalar("SELECT task_title FROM containers").fetch_all(&b.pool).await.unwrap();
        assert_eq!(titles, vec!["Write"]);
        assert_eq!(fingerprint(&a.pool).await.unwrap(), fingerprint(&b.pool).await.unwrap());
    }

    #[tokio::test]
    async fn a_snapshot_that_cannot_be_loaded_changes_nothing() {
        let (b, folder) = (device().await, scratch());
        add_cue(&b.pool, "x", "Mine").await;
        add_block(&b.pool, "mine", "My block").await;
        // a snapshot whose containers table has no title column cannot be copied in
        let broken = folder.join(SNAPSHOT_FILE);
        let pool = sqlx::SqlitePool::connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(&broken).create_if_missing(true)).await.unwrap();
        for sql in [
            "CREATE TABLE focus_blocks (id TEXT PRIMARY KEY NOT NULL, is_completed INTEGER NOT NULL)",
            "CREATE TABLE containers (id TEXT PRIMARY KEY NOT NULL, focus_block_id TEXT NOT NULL, order_index INTEGER NOT NULL)",
            "CREATE TABLE cues (id TEXT PRIMARY KEY NOT NULL, label TEXT NOT NULL, time_min INTEGER NOT NULL, days TEXT NOT NULL, flex_min INTEGER NOT NULL DEFAULT 0)",
            "CREATE TABLE commitments (id TEXT PRIMARY KEY NOT NULL)",
            "CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)",
            "INSERT INTO cues VALUES ('z', 'From the snapshot', 1, '[]', 0)",
            "INSERT INTO containers VALUES ('k', 'k', 0)",
        ] {
            sqlx::query(sql).execute(&pool).await.unwrap();
        }
        pool.close().await;

        assert!(load_snapshot(&b.pool, &folder).await.is_err());
        // The copy goes table by table and fails part way, in containers. Without a transaction the
        // tables already emptied (focus_blocks and containers) would stay empty, so those are what is
        // checked, as well as cues, which come after the failure.
        let titles: Vec<String> = sqlx::query_scalar("SELECT task_title FROM containers").fetch_all(&b.pool).await.unwrap();
        let blocks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM focus_blocks").fetch_one(&b.pool).await.unwrap();
        assert_eq!((titles, blocks, cue_labels(&b.pool).await), (vec!["My block".to_string()], 1, vec!["Mine".to_string()]));
    }

    // ----- two devices -----

    #[tokio::test]
    async fn a_device_with_data_pushes_and_a_new_device_pulls_it() {
        let (a, b, folder) = (device().await, device().await, scratch());
        add_cue(&a.pool, "c1", "Wake").await;

        assert_eq!(sync(&a, &folder, true).await, Outcome::Pushed);
        let outcome = sync(&b, &folder, true).await;

        assert!(matches!(outcome, Outcome::Pulled { .. }), "{outcome:?}");
        assert_eq!(cue_labels(&b.pool).await, vec!["Wake"]);
    }

    #[tokio::test]
    async fn loading_the_other_devices_data_keeps_a_backup_of_what_was_replaced() {
        let (a, b, folder) = (device().await, device().await, scratch());
        add_cue(&a.pool, "c1", "Wake").await;
        sync(&a, &folder, true).await;
        sync(&b, &folder, true).await; // b is empty, so nothing worth a backup is lost, but one is made

        let backups: Vec<_> = std::fs::read_dir(b.dir.join("backups")).unwrap().collect();
        assert_eq!(backups.len(), 1);
    }

    #[tokio::test]
    async fn changes_made_on_the_second_device_come_back_to_the_first() {
        let (a, b, folder) = (device().await, device().await, scratch());
        add_cue(&a.pool, "c1", "Wake").await;
        sync(&a, &folder, true).await;
        sync(&b, &folder, true).await;

        add_cue(&b.pool, "c2", "Lunch").await;
        assert_eq!(sync(&b, &folder, true).await, Outcome::Pushed);

        let outcome = sync(&a, &folder, true).await;
        assert!(matches!(outcome, Outcome::Pulled { .. }), "{outcome:?}");
        assert_eq!(cue_labels(&a.pool).await, vec!["Lunch", "Wake"]);
    }

    #[tokio::test]
    async fn a_running_device_only_reports_newer_data_and_does_not_replace_what_is_on_screen() {
        let (a, b, folder) = (device().await, device().await, scratch());
        add_cue(&a.pool, "c1", "Wake").await;
        sync(&a, &folder, true).await;
        sync(&b, &folder, true).await;
        add_cue(&b.pool, "c2", "Lunch").await;
        sync(&b, &folder, true).await;

        let outcome = sync(&a, &folder, false).await; // the periodic check does not pull
        assert!(matches!(outcome, Outcome::RemoteNewer { .. }), "{outcome:?}");
        assert_eq!(cue_labels(&a.pool).await, vec!["Wake"]);
    }

    #[tokio::test]
    async fn nothing_happens_when_both_are_already_the_same() {
        let (a, folder) = (device().await, scratch());
        add_cue(&a.pool, "c1", "Wake").await;
        sync(&a, &folder, true).await;
        assert_eq!(sync(&a, &folder, true).await, Outcome::InSync);
    }

    #[tokio::test]
    async fn while_the_app_runs_the_snapshot_is_touched_now_and_then_so_the_other_device_can_see_it_is_in_use() {
        let (a, folder) = (device().await, scratch());
        add_cue(&a.pool, "c1", "Wake").await;
        sync(&a, &folder, true).await;
        // a minute later there is no need to write again
        assert_eq!(sync_now(&a.pool, &a.dir, false, NOW + 60, "laptop").await.unwrap(), Outcome::InSync);
        assert_eq!(written_at(&a.dir).await, NOW);
        // five minutes on, it is refreshed, with the same data
        assert_eq!(sync_now(&a.pool, &a.dir, false, NOW + 300, "laptop").await.unwrap(), Outcome::InSync);
        assert_eq!(written_at(&a.dir).await, NOW + 300);
        assert_eq!(read_remote(&folder).await.unwrap().unwrap().fingerprint, fingerprint(&a.pool).await.unwrap());
    }

    async fn written_at(dir: &Path) -> i64 {
        let folder = PathBuf::from(load_state(dir).folder.unwrap());
        read_remote(&folder).await.unwrap().unwrap().written_at
    }

    #[tokio::test]
    async fn changes_on_both_devices_are_a_conflict_and_neither_side_is_touched() {
        let (a, b, folder) = (device().await, device().await, scratch());
        add_cue(&a.pool, "c1", "Wake").await;
        sync(&a, &folder, true).await;
        sync(&b, &folder, true).await;
        add_cue(&a.pool, "c2", "Lunch").await;
        add_cue(&b.pool, "c3", "Dinner").await;
        sync(&b, &folder, true).await; // b gets there first

        let outcome = sync(&a, &folder, true).await;

        assert!(matches!(outcome, Outcome::Conflict { .. }), "{outcome:?}");
        assert_eq!(cue_labels(&a.pool).await, vec!["Lunch", "Wake"]);
        assert_eq!(read_remote(&folder).await.unwrap().unwrap().fingerprint, fingerprint(&b.pool).await.unwrap());
    }

    #[tokio::test]
    async fn the_user_can_keep_this_devices_data_after_a_conflict_and_the_other_copy_is_backed_up() {
        let (a, b, folder) = (device().await, device().await, scratch());
        add_cue(&a.pool, "c1", "Wake").await;
        sync(&a, &folder, true).await;
        sync(&b, &folder, true).await;
        add_cue(&a.pool, "c2", "Lunch").await;
        add_cue(&b.pool, "c3", "Dinner").await;
        sync(&b, &folder, true).await;
        sync(&a, &folder, true).await;

        let outcome = resolve(&a.pool, &a.dir, Keep::ThisDevice, NOW, "laptop").await.unwrap();

        assert_eq!(outcome, Outcome::Pushed);
        assert_eq!(read_remote(&folder).await.unwrap().unwrap().fingerprint, fingerprint(&a.pool).await.unwrap());
        assert_eq!(std::fs::read_dir(a.dir.join("backups")).unwrap().count(), 1); // the copy that was replaced
    }

    #[tokio::test]
    async fn the_user_can_keep_the_other_devices_data_after_a_conflict_and_this_one_is_backed_up() {
        let (a, b, folder) = (device().await, device().await, scratch());
        add_cue(&a.pool, "c1", "Wake").await;
        sync(&a, &folder, true).await;
        sync(&b, &folder, true).await;
        add_cue(&a.pool, "c2", "Lunch").await;
        add_cue(&b.pool, "c3", "Dinner").await;
        sync(&b, &folder, true).await;
        sync(&a, &folder, true).await;

        let outcome = resolve(&a.pool, &a.dir, Keep::OtherDevice, NOW, "laptop").await.unwrap();

        assert!(matches!(outcome, Outcome::Pulled { .. }), "{outcome:?}");
        assert_eq!(cue_labels(&a.pool).await, vec!["Dinner", "Wake"]);
        assert_eq!(std::fs::read_dir(a.dir.join("backups")).unwrap().count(), 1);
        assert_eq!(sync(&a, &folder, true).await, Outcome::InSync);
    }

    #[tokio::test]
    async fn two_devices_with_different_table_layouts_do_not_sync_either_way() {
        let (a, b, folder) = (device().await, device().await, scratch());
        add_cue(&a.pool, "c1", "Wake").await;
        sync(&a, &folder, true).await;
        sqlx::query("ALTER TABLE cues ADD COLUMN colour TEXT").execute(&b.pool).await.unwrap();

        let outcome = sync(&b, &folder, true).await;

        assert!(matches!(outcome, Outcome::VersionMismatch { .. }), "{outcome:?}");
        assert!(cue_labels(&b.pool).await.is_empty()); // nothing pulled
        assert_eq!(read_remote(&folder).await.unwrap().unwrap().fingerprint, fingerprint(&a.pool).await.unwrap()); // nothing pushed
    }

    #[tokio::test]
    async fn an_empty_device_with_no_remote_writes_nothing() {
        let (a, folder) = (device().await, scratch());
        assert_eq!(sync(&a, &folder, true).await, Outcome::Nothing);
        assert!(!folder.join(SNAPSHOT_FILE).exists());
    }

    #[tokio::test]
    async fn a_folder_with_spaces_quotes_and_accents_in_its_name_works_like_any_other() {
        // iCloud's folder is "Mobile Documents/com~apple~CloudDocs"; people name folders anything
        let (a, b) = (device().await, device().await);
        let folder = scratch().join("My Sync (copy) ~ it's é 日本");
        std::fs::create_dir_all(&folder).unwrap();
        add_cue(&a.pool, "c1", "Wake").await;

        assert_eq!(sync(&a, &folder, true).await, Outcome::Pushed);
        assert!(matches!(sync(&b, &folder, true).await, Outcome::Pulled { .. }));
        assert_eq!(cue_labels(&b.pool).await, vec!["Wake"]);
    }

    #[tokio::test]
    async fn without_a_folder_syncing_is_off() {
        let a = device().await;
        assert_eq!(sync_now(&a.pool, &a.dir, true, NOW, "laptop").await.unwrap(), Outcome::Off);
    }

    // ----- who is using it -----

    #[tokio::test]
    async fn another_device_that_wrote_a_moment_ago_is_probably_still_open() {
        let (a, folder) = (device().await, scratch());
        write_snapshot(&a.pool, &folder, "someone-else", "desktop", NOW).await.unwrap();
        let me = SyncState { device_id: "me".into(), ..Default::default() };

        let recent = remote_info(&read_remote(&folder).await.unwrap().unwrap(), &me, NOW + 120);
        assert!(recent.recently_active && !recent.this_device);

        let old = remote_info(&read_remote(&folder).await.unwrap().unwrap(), &me, NOW + 3 * 3600);
        assert!(!old.recently_active);
    }

    #[tokio::test]
    async fn a_snapshot_written_by_this_device_is_never_another_device_being_active() {
        let (a, folder) = (device().await, scratch());
        write_snapshot(&a.pool, &folder, "me", "laptop", NOW).await.unwrap();
        let me = SyncState { device_id: "me".into(), ..Default::default() };
        let info = remote_info(&read_remote(&folder).await.unwrap().unwrap(), &me, NOW + 30);
        assert!(info.this_device && !info.recently_active);
    }

    // ----- this device's own state -----

    #[test]
    fn a_device_gets_an_id_once_and_keeps_it() {
        let dir = scratch();
        let first = load_state(&dir);
        assert!(!first.device_id.is_empty());
        assert_eq!(load_state(&dir).device_id, first.device_id);
    }

    #[test]
    fn a_damaged_state_file_does_not_stop_the_app() {
        let dir = scratch();
        std::fs::write(dir.join("sync-state.json"), "{ nope").unwrap();
        let state = load_state(&dir);
        assert!(!state.device_id.is_empty());
        assert_eq!(state.folder, None);
    }

    #[test]
    fn the_folder_has_to_exist_and_be_a_folder() {
        let dir = scratch();
        assert!(set_folder(&dir, Some("/definitely/not/a/folder")).is_err());
        let file = dir.join("a-file");
        std::fs::write(&file, "x").unwrap();
        assert!(set_folder(&dir, Some(file.to_str().unwrap())).is_err());
        assert_eq!(load_state(&dir).folder, None);
    }

    #[test]
    fn choosing_a_new_folder_starts_its_history_afresh_and_turning_it_off_keeps_the_device_id() {
        let dir = scratch();
        let folder = scratch();
        let mut state = load_state(&dir);
        state.last_fingerprint = Some("old".into());
        save_state(&dir, &state).unwrap();

        let after = set_folder(&dir, Some(folder.to_str().unwrap())).unwrap();
        assert_eq!((after.folder.as_deref(), after.last_fingerprint.clone()), (Some(folder.to_str().unwrap()), None));

        let off = set_folder(&dir, None).unwrap();
        assert_eq!((off.folder, off.device_id), (None, state.device_id));
    }

    // ----- what the screen shows -----

    #[tokio::test]
    async fn the_status_says_where_things_stand_without_changing_anything() {
        let (a, b, folder) = (device().await, device().await, scratch());
        assert_eq!(status(&a.pool, &a.dir, NOW).await.unwrap().state, "off");

        add_cue(&a.pool, "c1", "Wake").await;
        set_folder(&a.dir, Some(folder.to_str().unwrap())).unwrap();
        assert_eq!(status(&a.pool, &a.dir, NOW).await.unwrap().state, "no_remote");

        sync(&a, &folder, true).await;
        assert_eq!(status(&a.pool, &a.dir, NOW).await.unwrap().state, "in_sync");

        add_cue(&a.pool, "c2", "Lunch").await;
        assert_eq!(status(&a.pool, &a.dir, NOW).await.unwrap().state, "local_changes");

        sync(&a, &folder, true).await;
        sync(&b, &folder, true).await;
        add_cue(&b.pool, "c3", "Dinner").await;
        sync(&b, &folder, true).await;
        assert_eq!(status(&a.pool, &a.dir, NOW).await.unwrap().state, "remote_newer");

        add_cue(&a.pool, "c4", "Bed").await;
        assert_eq!(status(&a.pool, &a.dir, NOW).await.unwrap().state, "conflict");
        assert!(!folder.join("blinkers-sync.db.tmp").exists());
    }

    // ----- the day's choices travel with the data -----

    #[tokio::test]
    async fn the_days_choices_are_kept_in_the_database_so_they_sync_with_everything_else() {
        let a = device().await;
        assert_eq!(get_setting_in(&a.pool, "day_state").await.unwrap(), None);
        set_setting_in(&a.pool, "day_state", "{\"date\":\"2026-10-21\",\"fit\":\"drop\"}").await.unwrap();
        assert_eq!(get_setting_in(&a.pool, "day_state").await.unwrap().as_deref(), Some("{\"date\":\"2026-10-21\",\"fit\":\"drop\"}"));
        let before = fingerprint(&a.pool).await.unwrap();
        set_setting_in(&a.pool, "day_state", "{}").await.unwrap();
        assert_ne!(before, fingerprint(&a.pool).await.unwrap());
    }

    #[tokio::test]
    async fn only_the_days_choices_can_be_read_or_written_this_way() {
        let a = device().await;
        assert!(set_setting_in(&a.pool, "ntfy_topic", "stolen").await.is_err());
        assert!(get_setting_in(&a.pool, "ntfy_topic").await.is_err());
    }
}
