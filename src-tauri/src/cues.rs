use crate::db::DbState;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::HashMap;
use tauri::State;
use uuid::Uuid;

const DAY: i32 = 1440;
const MAX_LABEL: usize = 40;
const MAX_FLEX: i32 = 120;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CueInput {
    pub label: String,
    pub time_min: i32,
    pub days: Vec<u8>,
    pub flex_min: i32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cue {
    pub id: String,
    pub label: String,
    pub time_min: i32,
    pub days: Vec<u8>,
    pub flex_min: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Chronotype {
    Morning,
    Neutral,
    Night,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserProfile {
    pub chronotype: Chronotype,
    #[serde(default)]
    pub energy_overrides: HashMap<u8, u8>,
}

impl Default for UserProfile {
    fn default() -> Self {
        UserProfile {
            chronotype: Chronotype::Neutral,
            energy_overrides: HashMap::new(),
        }
    }
}

// Mirrors the basic rules of src/cues.ts so the database never holds a cue the scheduler
// can not use. Overlap between cues is checked by the UI layer, not here.
pub fn validate_cue(input: CueInput) -> Result<CueInput, String> {
    let label = input.label.trim().to_string();
    if label.is_empty() {
        return Err("Give the cue a name.".into());
    }
    if label.chars().count() > MAX_LABEL {
        return Err(format!("Name must be {MAX_LABEL} characters or fewer."));
    }

    if !(0..DAY).contains(&input.time_min) {
        return Err("Pick a valid time.".into());
    }

    let mut days = input.days.clone();
    days.sort_unstable();
    days.dedup();
    if days.is_empty() {
        return Err("Pick at least one day.".into());
    }
    if days.iter().any(|d| *d > 6) {
        return Err("Days must be between Sunday and Saturday.".into());
    }

    if input.flex_min < 0 {
        return Err("Flex must be zero or more whole minutes.".into());
    }
    if input.flex_min > MAX_FLEX {
        return Err(format!("Flex can be at most {MAX_FLEX} minutes."));
    }

    Ok(CueInput { label, days, ..input })
}

pub fn validate_profile(profile: &UserProfile) -> Result<(), String> {
    for (hour, value) in &profile.energy_overrides {
        if *hour > 23 {
            return Err(format!("Override hour {hour} must be between 0 and 23."));
        }
        if !(1..=5).contains(value) {
            return Err(format!("Override energy {value} must be between 1 and 5."));
        }
    }
    Ok(())
}

#[derive(sqlx::FromRow)]
struct CueRow {
    id: String,
    label: String,
    time_min: i32,
    days: String,
    flex_min: i32,
}

impl CueRow {
    fn into_cue(self) -> Result<Cue, String> {
        let days: Vec<u8> = serde_json::from_str(&self.days).map_err(|e| e.to_string())?;
        Ok(Cue {
            id: self.id,
            label: self.label,
            time_min: self.time_min,
            days,
            flex_min: self.flex_min,
        })
    }
}

pub async fn create_cue_in(pool: &SqlitePool, input: CueInput) -> Result<Cue, String> {
    let valid = validate_cue(input)?;
    let cue = Cue {
        id: Uuid::new_v4().to_string(),
        label: valid.label,
        time_min: valid.time_min,
        days: valid.days,
        flex_min: valid.flex_min,
    };
    let days = serde_json::to_string(&cue.days).map_err(|e| e.to_string())?;

    sqlx::query(
        "INSERT INTO cues (id, label, time_min, days, flex_min) VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(&cue.id)
    .bind(&cue.label)
    .bind(cue.time_min)
    .bind(days)
    .bind(cue.flex_min)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(cue)
}

// Validates first so a bad edit can never leave a half-written row, then replaces every
// field in place. The id is kept, so anything that refers to this cue keeps working.
pub async fn update_cue_in(pool: &SqlitePool, id: &str, input: CueInput) -> Result<Cue, String> {
    let valid = validate_cue(input)?;
    let days = serde_json::to_string(&valid.days).map_err(|e| e.to_string())?;

    let result = sqlx::query(
        "UPDATE cues SET label = $1, time_min = $2, days = $3, flex_min = $4 WHERE id = $5",
    )
    .bind(&valid.label)
    .bind(valid.time_min)
    .bind(days)
    .bind(valid.flex_min)
    .bind(id)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    if result.rows_affected() == 0 {
        return Err("Cue not found.".into());
    }

    Ok(Cue {
        id: id.to_string(),
        label: valid.label,
        time_min: valid.time_min,
        days: valid.days,
        flex_min: valid.flex_min,
    })
}

pub async fn list_cues_in(pool: &SqlitePool) -> Result<Vec<Cue>, String> {
    let rows = sqlx::query_as::<_, CueRow>(
        "SELECT id, label, time_min, days, flex_min FROM cues ORDER BY time_min, label",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    rows.into_iter().map(CueRow::into_cue).collect()
}

pub async fn delete_cue_in(pool: &SqlitePool, id: &str) -> Result<(), String> {
    let result = sqlx::query("DELETE FROM cues WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

    if result.rows_affected() == 0 {
        return Err("Cue not found.".into());
    }
    Ok(())
}

// A user who never set a profile is treated as a neutral chronotype with no overrides.
pub async fn get_profile_in(pool: &SqlitePool) -> Result<UserProfile, String> {
    let stored: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'profile'")
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;

    match stored {
        Some(json) => serde_json::from_str(&json).map_err(|e| e.to_string()),
        None => Ok(UserProfile::default()),
    }
}

pub async fn set_profile_in(pool: &SqlitePool, profile: &UserProfile) -> Result<(), String> {
    validate_profile(profile)?;
    let json = serde_json::to_string(profile).map_err(|e| e.to_string())?;

    sqlx::query(
        "INSERT INTO settings (key, value) VALUES ('profile', $1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(json)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn create_cue(input: CueInput, state: State<'_, DbState>) -> Result<Cue, String> {
    create_cue_in(&state.pool, input).await
}

#[tauri::command]
pub async fn update_cue(id: String, input: CueInput, state: State<'_, DbState>) -> Result<Cue, String> {
    update_cue_in(&state.pool, &id, input).await
}

#[tauri::command]
pub async fn list_cues(state: State<'_, DbState>) -> Result<Vec<Cue>, String> {
    list_cues_in(&state.pool).await
}

#[tauri::command]
pub async fn delete_cue(id: String, state: State<'_, DbState>) -> Result<(), String> {
    delete_cue_in(&state.pool, &id).await
}

#[tauri::command]
pub async fn get_profile(state: State<'_, DbState>) -> Result<UserProfile, String> {
    get_profile_in(&state.pool).await
}

#[tauri::command]
pub async fn set_profile(profile: UserProfile, state: State<'_, DbState>) -> Result<(), String> {
    set_profile_in(&state.pool, &profile).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    fn input() -> CueInput {
        CueInput {
            label: "After school".into(),
            time_min: 930,
            days: vec![1, 2, 3, 4, 5],
            flex_min: 0,
        }
    }

    async fn pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::init_cue_schema(&pool).await.unwrap();
        pool
    }

    #[test]
    fn validate_normalizes_label_and_days() {
        let out = validate_cue(CueInput {
            label: "  After school  ".into(),
            days: vec![5, 1, 1, 3],
            ..input()
        })
        .unwrap();
        assert_eq!(out.label, "After school");
        assert_eq!(out.days, vec![1, 3, 5]);
    }

    #[test]
    fn validate_accepts_a_late_night_cue_whose_drift_crosses_midnight() {
        assert!(validate_cue(CueInput { time_min: 1430, flex_min: 30, ..input() }).is_ok());
    }

    #[test]
    fn validate_rejects_bad_input() {
        let bad = [
            CueInput { label: "   ".into(), ..input() },
            CueInput { label: "x".repeat(41), ..input() },
            CueInput { time_min: 1440, ..input() },
            CueInput { time_min: -1, ..input() },
            CueInput { days: vec![], ..input() },
            CueInput { days: vec![7], ..input() },
            CueInput { flex_min: -5, ..input() },
            CueInput { flex_min: 121, ..input() },
        ];
        for case in bad {
            assert!(validate_cue(case.clone()).is_err(), "should reject {case:?}");
        }
    }

    #[test]
    fn validate_accepts_the_maximum_flex() {
        assert!(validate_cue(CueInput { flex_min: 120, ..input() }).is_ok());
    }

    #[tokio::test]
    async fn created_cue_gets_an_id_and_round_trips() {
        let pool = pool().await;
        let made = create_cue_in(&pool, input()).await.unwrap();
        assert!(!made.id.is_empty());
        assert_eq!(list_cues_in(&pool).await.unwrap(), vec![made]);
    }

    #[tokio::test]
    async fn create_rejects_invalid_input_and_stores_nothing() {
        let pool = pool().await;
        assert!(create_cue_in(&pool, CueInput { days: vec![], ..input() }).await.is_err());
        assert!(list_cues_in(&pool).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn update_changes_the_fields_and_keeps_the_same_id() {
        let pool = pool().await;
        let made = create_cue_in(&pool, input()).await.unwrap();
        let changed = CueInput { label: "  Study  ".into(), time_min: 1000, days: vec![6, 0], flex_min: 15 };

        let updated = update_cue_in(&pool, &made.id, changed).await.unwrap();

        assert_eq!(updated.id, made.id);
        assert_eq!(updated.label, "Study");
        assert_eq!(updated.days, vec![0, 6]);
        // Stored, not just returned, and no duplicate row was created.
        assert_eq!(list_cues_in(&pool).await.unwrap(), vec![updated]);
    }

    #[tokio::test]
    async fn update_with_invalid_input_is_rejected_and_the_cue_is_unchanged() {
        let pool = pool().await;
        let made = create_cue_in(&pool, input()).await.unwrap();
        let result = update_cue_in(&pool, &made.id, CueInput { days: vec![], ..input() }).await;
        assert!(result.is_err());
        assert_eq!(list_cues_in(&pool).await.unwrap(), vec![made]);
    }

    #[tokio::test]
    async fn update_errors_on_a_cue_that_does_not_exist() {
        let pool = pool().await;
        assert!(update_cue_in(&pool, "missing", input()).await.is_err());
        assert!(list_cues_in(&pool).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn list_is_ordered_by_start_time() {
        let pool = pool().await;
        create_cue_in(&pool, CueInput { label: "Evening".into(), time_min: 1140, ..input() }).await.unwrap();
        create_cue_in(&pool, CueInput { label: "Morning".into(), time_min: 420, ..input() }).await.unwrap();
        let labels: Vec<String> = list_cues_in(&pool).await.unwrap().into_iter().map(|c| c.label).collect();
        assert_eq!(labels, vec!["Morning", "Evening"]);
    }

    #[tokio::test]
    async fn delete_removes_the_cue_and_errors_on_a_missing_id() {
        let pool = pool().await;
        let made = create_cue_in(&pool, input()).await.unwrap();
        delete_cue_in(&pool, &made.id).await.unwrap();
        assert!(list_cues_in(&pool).await.unwrap().is_empty());
        assert!(delete_cue_in(&pool, &made.id).await.is_err());
    }

    #[tokio::test]
    async fn profile_defaults_to_neutral_when_never_saved() {
        assert_eq!(get_profile_in(&pool().await).await.unwrap(), UserProfile::default());
    }

    #[tokio::test]
    async fn profile_saves_and_overwrites() {
        let pool = pool().await;
        let night = UserProfile {
            chronotype: Chronotype::Night,
            energy_overrides: HashMap::from([(15, 5)]),
        };
        set_profile_in(&pool, &night).await.unwrap();
        assert_eq!(get_profile_in(&pool).await.unwrap(), night);

        let morning = UserProfile { chronotype: Chronotype::Morning, energy_overrides: HashMap::new() };
        set_profile_in(&pool, &morning).await.unwrap();
        assert_eq!(get_profile_in(&pool).await.unwrap(), morning);
    }

    #[tokio::test]
    async fn profile_rejects_out_of_range_overrides() {
        let pool = pool().await;
        for (hour, value) in [(24u8, 3u8), (10, 0), (10, 6)] {
            let p = UserProfile {
                chronotype: Chronotype::Neutral,
                energy_overrides: HashMap::from([(hour, value)]),
            };
            assert!(set_profile_in(&pool, &p).await.is_err(), "hour {hour} value {value}");
        }
    }

    #[test]
    fn profile_json_uses_camel_case_and_lowercase_chronotype() {
        let json = serde_json::to_string(&UserProfile::default()).unwrap();
        assert_eq!(json, r#"{"chronotype":"neutral","energyOverrides":{}}"#);
    }
}
