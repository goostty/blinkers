// Runs the reminders: one tick looks at today's commitments, sends what is due and records it.
// The app calls it every few seconds with the local date and minute (so this never reads a clock
// or a timezone itself, which is also what lets the tests set the time).
use crate::containers::validate_created_on;
use crate::db::DbState;
use crate::ntfy;
use crate::reminder::{next_step, priority_for, reminder_text, Step};
use serde::Serialize;
use tauri::State;

const MINUTES_PER_DAY: i32 = 1440;

// The one HTTP client, made at startup and shared by every tick.
pub struct NtfyClient(pub reqwest::Client);

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TickReport {
    pub sent: u32,
    pub missed: u32,
    // Why reminders could not go out this time (no network, ntfy down). Not an error for the
    // caller: the commitments are untouched, so the next tick simply tries again.
    pub failed: Option<String>,
}

#[derive(Debug, sqlx::FromRow)]
struct Due {
    block_id: String,
    start_min: i32,
    duration_min: i32,
    status: String,
    nag_count: i32,
    last_nag_at: Option<i64>,
    task_title: String,
    action_trigger: Option<String>,
    block_type: String,
    cue_label: Option<String>,
}

// Order of work, and why:
//   1. Anything still open from an earlier day is closed as `missed`. Nothing else ever would,
//      because the day it belonged to is over.
//   2. Blocks whose window has passed become `missed`. This needs no network, so it happens
//      even when ntfy cannot be reached.
//   3. Reminders go out one at a time. The record (`nagging`, the count, the time) is written
//      only after ntfy accepted the message: if the send fails the row is left exactly as it was
//      and the next tick tries again, so a reminder is late when the network is down but never
//      lost. The first failure ends the sending, since every other send would just wait out its
//      timeout too.
// Each update only applies if the row is still open, so pressing Start while a tick is running
// is never overwritten.
pub async fn tick_in(
    pool: &sqlx::SqlitePool,
    client: &reqwest::Client,
    base_url: &str,
    on: &str,
    now_min: i32,
    now_unix: i64,
) -> Result<TickReport, String> {
    validate_created_on(on)?;
    if !(0..MINUTES_PER_DAY).contains(&now_min) {
        return Err(format!("Minute {now_min} is outside the day."));
    }

    let stale = sqlx::query(
        "UPDATE commitments SET status = 'missed' WHERE on_date < $1 AND status IN ('planned', 'nagging')",
    )
    .bind(on)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    let mut report = TickReport { missed: stale.rows_affected() as u32, ..TickReport::default() };

    let open = sqlx::query_as::<_, Due>(
        "SELECT c.block_id, c.start_min, c.duration_min, c.status, c.nag_count, c.last_nag_at,
                ct.task_title, ct.action_trigger, ct.block_type, cu.label AS cue_label
         FROM commitments c
         JOIN containers ct ON ct.focus_block_id = c.block_id
         LEFT JOIN cues cu ON cu.id = c.cue_id
         WHERE c.on_date = $1 AND c.status IN ('planned', 'nagging')
         ORDER BY c.start_min, c.block_id",
    )
    .bind(on)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let mut to_remind = Vec::new();
    for d in open {
        match next_step(&d.status, d.start_min, d.duration_min, d.nag_count, d.last_nag_at, now_min, now_unix) {
            Step::Miss => {
                let moved = sqlx::query(
                    "UPDATE commitments SET status = 'missed'
                     WHERE block_id = $1 AND on_date = $2 AND status IN ('planned', 'nagging')",
                )
                .bind(&d.block_id)
                .bind(on)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
                report.missed += moved.rows_affected() as u32;
            }
            Step::Remind => to_remind.push(d),
            Step::Wait => {}
        }
    }
    if to_remind.is_empty() {
        return Ok(report);
    }

    let topic = match ntfy::get_or_create_topic_in(pool).await {
        Ok(t) => t,
        Err(e) => {
            report.failed = Some(e);
            return Ok(report);
        }
    };

    for d in to_remind {
        let words = reminder_text(
            &d.block_type,
            &d.task_title,
            d.action_trigger.as_deref(),
            d.start_min,
            d.cue_label.as_deref(),
            d.nag_count,
        );
        let message = ntfy::build_message(&topic, &words, priority_for(d.nag_count))?;
        if let Err(e) = ntfy::send(client, base_url, &message).await {
            report.failed = Some(e);
            break;
        }
        sqlx::query(
            "UPDATE commitments SET status = 'nagging', nag_count = nag_count + 1, last_nag_at = $3
             WHERE block_id = $1 AND on_date = $2 AND status IN ('planned', 'nagging') AND nag_count = $4",
        )
        .bind(&d.block_id)
        .bind(on)
        .bind(now_unix)
        .bind(d.nag_count)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
        report.sent += 1;
    }
    Ok(report)
}

#[tauri::command]
pub async fn tick_reminders(
    on: String,
    now_min: i32,
    now_unix: i64,
    db_state: State<'_, DbState>,
    client: State<'_, NtfyClient>,
) -> Result<TickReport, String> {
    tick_in(&db_state.pool, &client.0, ntfy::NTFY_URL, &on, now_min, now_unix).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reminder::{MAX_NAGS, NAG_INTERVAL_SEC};
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    const TODAY: &str = "2026-10-20";
    const T0: i64 = 1_800_000_000;

    // A fake ntfy that answers every request with `status` and remembers each JSON body it got.
    struct Fake {
        url: String,
        bodies: Arc<Mutex<Vec<serde_json::Value>>>,
        status: Arc<Mutex<&'static str>>,
    }

    async fn fake() -> Fake {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let bodies = Arc::new(Mutex::new(Vec::new()));
        let status = Arc::new(Mutex::new("200 OK"));
        let (b, s) = (bodies.clone(), status.clone());
        tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let (b, s) = (b.clone(), s.clone());
                tokio::spawn(async move {
                    let mut raw = Vec::new();
                    let mut buf = [0u8; 4096];
                    loop {
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        raw.extend_from_slice(&buf[..n]);
                        let text = String::from_utf8_lossy(&raw).to_string();
                        if let Some(split) = text.find("\r\n\r\n") {
                            let length = text[..split]
                                .lines()
                                .find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                                .unwrap_or(0);
                            if raw.len() >= split + 4 + length {
                                if let Ok(v) = serde_json::from_str(&text[split + 4..]) {
                                    b.lock().unwrap().push(v);
                                }
                                break;
                            }
                        }
                        if n == 0 {
                            break;
                        }
                    }
                    let status = *s.lock().unwrap();
                    let reply = format!("HTTP/1.1 {status}\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{{}}");
                    let _ = socket.write_all(reply.as_bytes()).await;
                });
            }
        });
        Fake { url, bodies, status }
    }

    async fn pool() -> sqlx::SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        crate::db::init_container_schema(&pool).await.unwrap();
        crate::db::init_cue_schema(&pool).await.unwrap();
        crate::db::init_commitment_schema(&pool).await.unwrap();
        sqlx::query("INSERT INTO cues (id, label, time_min, days) VALUES ('cue1', 'After school', 600, '[0,1,2,3,4,5,6]')")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    // A block with its commitment: starts at `start_min` and runs 30 minutes.
    async fn add(pool: &sqlx::SqlitePool, id: &str, title: &str, trigger: Option<&str>, on: &str, start_min: i32, status: &str) {
        sqlx::query("INSERT INTO focus_blocks (id, is_completed) VALUES ($1, 0)").bind(id).execute(pool).await.unwrap();
        sqlx::query("INSERT INTO containers (id, focus_block_id, order_index, task_title, action_trigger, block_type) VALUES ($1, $1, 0, $2, $3, 'deep')")
            .bind(id)
            .bind(title)
            .bind(trigger)
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO commitments (id, block_id, on_date, cue_id, start_min, duration_min, status) VALUES ($1, $1, $2, 'cue1', $3, 30, $4)")
            .bind(id)
            .bind(on)
            .bind(start_min)
            .bind(status)
            .execute(pool)
            .await
            .unwrap();
    }

    async fn row(pool: &sqlx::SqlitePool, id: &str) -> (String, i32, Option<i64>) {
        sqlx::query_as("SELECT status, nag_count, last_nag_at FROM commitments WHERE block_id = $1")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    async fn tick(pool: &sqlx::SqlitePool, fake: &Fake, now_min: i32, now_unix: i64) -> TickReport {
        let client = crate::ntfy::make_client(std::time::Duration::from_secs(5));
        tick_in(pool, &client, &fake.url, TODAY, now_min, now_unix).await.unwrap()
    }

    #[tokio::test]
    async fn nothing_is_sent_before_the_start_time() {
        let (pool, fake) = (pool().await, fake().await);
        add(&pool, "b1", "Write", None, TODAY, 600, "planned").await;

        let report = tick(&pool, &fake, 599, T0).await;

        assert_eq!(report, TickReport { sent: 0, missed: 0, failed: None });
        assert!(fake.bodies.lock().unwrap().is_empty());
        assert_eq!(row(&pool, "b1").await, ("planned".into(), 0, None));
    }

    #[tokio::test]
    async fn at_the_start_time_the_first_step_is_sent_to_the_private_topic_and_recorded() {
        let (pool, fake) = (pool().await, fake().await);
        add(&pool, "b1", "Écrire le rapport 📝", Some("Open report.md"), TODAY, 600, "planned").await;

        let report = tick(&pool, &fake, 600, T0).await;

        assert_eq!(report.sent, 1);
        let topic = crate::ntfy::get_or_create_topic_in(&pool).await.unwrap();
        let sent = fake.bodies.lock().unwrap().clone();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0]["topic"], topic);
        assert_eq!(sent[0]["title"], "Écrire le rapport 📝");
        assert_eq!(sent[0]["message"], "First step: Open report.md\n10:00 AM · After school");
        assert_eq!(sent[0]["priority"], 3);
        assert_eq!(row(&pool, "b1").await, ("nagging".into(), 1, Some(T0)));
    }

    #[tokio::test]
    async fn the_same_tick_twice_sends_one_reminder() {
        let (pool, fake) = (pool().await, fake().await);
        add(&pool, "b1", "Write", None, TODAY, 600, "planned").await;
        tick(&pool, &fake, 600, T0).await;
        tick(&pool, &fake, 600, T0 + 15).await;
        assert_eq!(fake.bodies.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn the_repeat_comes_after_the_gap_says_it_is_a_repeat_and_is_more_urgent() {
        let (pool, fake) = (pool().await, fake().await);
        add(&pool, "b1", "Write", None, TODAY, 600, "planned").await;
        tick(&pool, &fake, 600, T0).await;

        tick(&pool, &fake, 604, T0 + NAG_INTERVAL_SEC - 1).await;
        assert_eq!(fake.bodies.lock().unwrap().len(), 1);

        tick(&pool, &fake, 605, T0 + NAG_INTERVAL_SEC).await;
        let sent = fake.bodies.lock().unwrap().clone();
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[1]["title"], "Still waiting: Write");
        assert_eq!(sent[1]["priority"], 4);
        assert_eq!(row(&pool, "b1").await, ("nagging".into(), 2, Some(T0 + NAG_INTERVAL_SEC)));
    }

    #[tokio::test]
    async fn the_reminders_stop_at_the_limit() {
        let (pool, fake) = (pool().await, fake().await);
        add(&pool, "b1", "Write", None, TODAY, 600, "planned").await;
        for i in 0..(MAX_NAGS + 3) {
            tick(&pool, &fake, 610, T0 + i64::from(i) * NAG_INTERVAL_SEC).await;
        }
        assert_eq!(fake.bodies.lock().unwrap().len() as i32, MAX_NAGS);
        assert_eq!(row(&pool, "b1").await.1, MAX_NAGS);
    }

    #[tokio::test]
    async fn a_block_whose_window_passed_is_missed_without_a_reminder() {
        let (pool, fake) = (pool().await, fake().await);
        add(&pool, "b1", "Write", None, TODAY, 600, "planned").await;
        add(&pool, "b2", "Read", None, TODAY, 500, "nagging").await;

        let report = tick(&pool, &fake, 630, T0).await;

        assert_eq!(report.missed, 2);
        assert_eq!(report.sent, 0);
        assert_eq!(row(&pool, "b1").await.0, "missed");
        assert_eq!(row(&pool, "b2").await.0, "missed");
        assert!(fake.bodies.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn blocks_left_open_from_an_earlier_day_are_closed_as_missed() {
        let (pool, fake) = (pool().await, fake().await);
        add(&pool, "old", "Yesterday", None, "2026-10-19", 600, "planned").await;
        add(&pool, "older", "Last week", None, "2026-10-13", 600, "nagging").await;
        add(&pool, "done", "Finished", None, "2026-10-19", 700, "finished").await;

        tick(&pool, &fake, 0, T0).await;

        assert_eq!(row(&pool, "old").await.0, "missed");
        assert_eq!(row(&pool, "older").await.0, "missed");
        assert_eq!(row(&pool, "done").await.0, "finished"); // only unacted-on blocks are touched
    }

    #[tokio::test]
    async fn a_block_the_user_started_is_never_reminded() {
        let (pool, fake) = (pool().await, fake().await);
        add(&pool, "b1", "Write", None, TODAY, 600, "started").await;
        tick(&pool, &fake, 615, T0).await;
        assert!(fake.bodies.lock().unwrap().is_empty());
        assert_eq!(row(&pool, "b1").await.0, "started");
    }

    #[tokio::test]
    async fn a_failed_send_changes_nothing_so_the_next_tick_tries_again() {
        let (pool, fake) = (pool().await, fake().await);
        add(&pool, "b1", "Write", None, TODAY, 600, "planned").await;
        *fake.status.lock().unwrap() = "500 Internal Server Error";

        let report = tick(&pool, &fake, 600, T0).await;

        assert_eq!(report.sent, 0);
        assert!(report.failed.as_deref().unwrap_or("").contains("500"), "{report:?}");
        assert_eq!(row(&pool, "b1").await, ("planned".into(), 0, None));

        *fake.status.lock().unwrap() = "200 OK";
        let retry = tick(&pool, &fake, 600, T0 + 15).await;
        assert_eq!(retry.sent, 1);
        assert_eq!(row(&pool, "b1").await, ("nagging".into(), 1, Some(T0 + 15)));
    }

    #[tokio::test]
    async fn when_ntfy_is_down_misses_are_still_recorded_and_sending_stops_at_the_first_failure() {
        let (pool, fake) = (pool().await, fake().await);
        add(&pool, "late", "Late", None, TODAY, 500, "planned").await; // window over
        add(&pool, "a", "A", None, TODAY, 600, "planned").await;
        add(&pool, "b", "B", None, TODAY, 601, "planned").await;
        *fake.status.lock().unwrap() = "503 Service Unavailable";

        let report = tick(&pool, &fake, 605, T0).await;

        assert_eq!(report.missed, 1);
        assert_eq!(row(&pool, "late").await.0, "missed");
        assert_eq!(fake.bodies.lock().unwrap().len(), 1); // tried the first, did not try the second
        assert_eq!(row(&pool, "b").await.0, "planned");
    }

    #[tokio::test]
    async fn two_blocks_due_together_each_get_their_own_reminder() {
        let (pool, fake) = (pool().await, fake().await);
        add(&pool, "a", "First", None, TODAY, 600, "planned").await;
        add(&pool, "b", "Second", None, TODAY, 610, "planned").await;
        let report = tick(&pool, &fake, 615, T0).await;
        assert_eq!(report.sent, 2);
        let titles: Vec<String> = fake.bodies.lock().unwrap().iter().map(|b| b["title"].as_str().unwrap().to_string()).collect();
        assert_eq!(titles, vec!["First", "Second"]); // in the order the day runs
    }

    #[tokio::test]
    async fn a_minute_outside_the_day_is_refused() {
        let (pool, fake) = (pool().await, fake().await);
        let client = crate::ntfy::make_client(std::time::Duration::from_secs(5));
        assert!(tick_in(&pool, &client, &fake.url, TODAY, 1440, T0).await.is_err());
        assert!(tick_in(&pool, &client, &fake.url, "not-a-date", 600, T0).await.is_err());
    }
}
