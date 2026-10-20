// Sends reminders to the phone through ntfy (https://ntfy.sh). ntfy is a public relay: anyone who
// knows a topic's name can read what is sent to it and send to it. The only secret is the name,
// so it is made of random characters, and nothing here should ever log or share it.
use crate::reminder::Reminder;
use serde::Serialize;
use std::time::Duration;
use uuid::Uuid;

pub const NTFY_URL: &str = "https://ntfy.sh";

// A laptop that is offline, or a relay that is down, must cost a reminder, not hang the loop that
// sends them.
pub const SEND_TIMEOUT: Duration = Duration::from_secs(10);

const MAX_TOPIC_LEN: usize = 64;

// What ntfy's JSON publishing takes. JSON, not headers: a header can only carry plain ASCII, so a
// task titled "Écrire le rapport 📝" would arrive garbled or not at all.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct NtfyMessage {
    pub topic: String,
    pub title: String,
    pub message: String,
    pub priority: u8,
}

// "blinkers_" plus 32 random hex characters (a v4 UUID, 122 random bits). That is long enough
// that nobody can guess it, which is what keeps strangers from reading your tasks or sending
// you fake reminders.
pub fn generate_topic() -> String {
    format!("blinkers_{}", Uuid::new_v4().simple())
}

// ntfy puts the topic in a URL, so anything outside letters, digits, `-` and `_` could change
// where a message goes. Rejecting it here means a typo can never send a reminder somewhere else.
pub fn validate_topic(topic: &str) -> Result<(), String> {
    if topic.is_empty() || topic.len() > MAX_TOPIC_LEN {
        return Err(format!("A topic needs 1 to {MAX_TOPIC_LEN} characters."));
    }
    if !topic.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("A topic can only use letters, digits, - and _.".into());
    }
    Ok(())
}

// Priority is ntfy's own scale: 1 (min) to 5 (max, which makes the phone alert persistently).
pub fn build_message(topic: &str, reminder: &Reminder, priority: u8) -> Result<NtfyMessage, String> {
    validate_topic(topic)?;
    if !(1..=5).contains(&priority) {
        return Err(format!("Priority {priority} is not between 1 and 5."));
    }
    Ok(NtfyMessage {
        topic: topic.to_string(),
        title: reminder.title.clone(),
        message: reminder.body.clone(),
        priority,
    })
}

pub fn make_client(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder().timeout(timeout).build().expect("could not set up the HTTP client")
}

// Any failure comes back as text and never panics: the caller decides whether to try again.
// `base_url` is a parameter so tests can aim it at a fake server.
pub async fn send(client: &reqwest::Client, base_url: &str, message: &NtfyMessage) -> Result<(), String> {
    let body = serde_json::to_string(message).map_err(|e| e.to_string())?;
    let response = client
        .post(base_url)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Could not reach ntfy: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("ntfy answered {}.", response.status()));
    }
    Ok(())
}

const TOPIC_KEY: &str = "ntfy_topic";

// The topic is made once and then kept for good: the phone is subscribed to that exact name, so
// changing it would silently stop every reminder. `INSERT OR IGNORE` makes two first asks at the
// same moment agree on one topic. A stored value that is no longer valid (someone edited the
// database) is reported and not replaced, for the same reason.
pub async fn get_or_create_topic_in(pool: &sqlx::SqlitePool) -> Result<String, String> {
    sqlx::query("INSERT OR IGNORE INTO settings (key, value) VALUES ($1, $2)")
        .bind(TOPIC_KEY)
        .bind(generate_topic())
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

    let topic: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = $1")
        .bind(TOPIC_KEY)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;

    validate_topic(&topic).map_err(|e| format!("The saved ntfy topic is not usable: {e}"))?;
    Ok(topic)
}

// For someone who wants a name they chose. A bad one is refused and the old one stays.
pub async fn set_topic_in(pool: &sqlx::SqlitePool, topic: &str) -> Result<(), String> {
    validate_topic(topic)?;
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(TOPIC_KEY)
    .bind(topic)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn get_ntfy_topic(state: tauri::State<'_, crate::db::DbState>) -> Result<String, String> {
    get_or_create_topic_in(&state.pool).await
}

#[tauri::command]
pub async fn set_ntfy_topic(topic: String, state: tauri::State<'_, crate::db::DbState>) -> Result<(), String> {
    set_topic_in(&state.pool, topic.trim()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn reminder() -> Reminder {
        Reminder { title: "Write the report".into(), body: "First step: open it\n3:30 PM".into() }
    }

    // A one-shot fake ntfy server: answers with `status`, and hands back the raw request it got.
    async fn fake_server(status: &'static str) -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut raw = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                let n = socket.read(&mut buf).await.unwrap();
                raw.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&raw).to_string();
                if let Some(split) = text.find("\r\n\r\n") {
                    let length = text[..split]
                        .lines()
                        .find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                        .unwrap_or(0);
                    if raw.len() >= split + 4 + length {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            let reply = format!("HTTP/1.1 {status}\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{{}}");
            socket.write_all(reply.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&raw).to_string()
        });
        (url, handle)
    }

    #[test]
    fn a_generated_topic_is_valid_long_and_different_every_time() {
        let a = generate_topic();
        assert!(validate_topic(&a).is_ok(), "{a}");
        assert!(a.starts_with("blinkers_"));
        assert!(a.len() >= 9 + 32, "{a}"); // 122 random bits, so it cannot be guessed
        assert_ne!(a, generate_topic());
    }

    #[test]
    fn a_topic_must_be_plain_letters_digits_dashes_and_underscores() {
        for ok in ["blinkers_alert", "a", "My-Topic_1"] {
            assert!(validate_topic(ok).is_ok(), "{ok}");
        }
        for bad in ["", "   ", "has space", "a/b", "a?b", "ünï", "a".repeat(65).as_str()] {
            assert!(validate_topic(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_message_carries_the_reminders_words_to_the_topic() {
        let m = build_message("t_1", &reminder(), 3).unwrap();
        assert_eq!(m, NtfyMessage { topic: "t_1".into(), title: "Write the report".into(), message: "First step: open it\n3:30 PM".into(), priority: 3 });
    }

    #[test]
    fn a_message_refuses_a_bad_topic_or_a_priority_ntfy_does_not_have() {
        assert!(build_message("bad topic", &reminder(), 3).is_err());
        assert!(build_message("t", &reminder(), 0).is_err());
        assert!(build_message("t", &reminder(), 6).is_err());
        assert!(build_message("t", &reminder(), 1).is_ok());
        assert!(build_message("t", &reminder(), 5).is_ok());
    }

    #[tokio::test]
    async fn sending_posts_json_to_the_server_root_and_keeps_unicode_intact() {
        let (url, server) = fake_server("200 OK").await;
        let m = build_message("t_1", &Reminder { title: "Écrire 📝".into(), body: "Time to start.".into() }, 4).unwrap();

        send(&make_client(Duration::from_secs(5)), &url, &m).await.unwrap();

        let raw = server.await.unwrap();
        assert!(raw.starts_with("POST / HTTP/1.1"), "{raw}");
        assert!(raw.to_lowercase().contains("content-type: application/json"), "{raw}");
        let body: serde_json::Value = serde_json::from_str(raw.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body, serde_json::json!({ "topic": "t_1", "title": "Écrire 📝", "message": "Time to start.", "priority": 4 }));
    }

    #[tokio::test]
    async fn a_server_error_is_an_error_not_a_panic() {
        let (url, _server) = fake_server("500 Internal Server Error").await;
        let m = build_message("t", &reminder(), 3).unwrap();
        let err = send(&make_client(Duration::from_secs(5)), &url, &m).await.unwrap_err();
        assert!(err.contains("500"), "{err}");
    }

    #[tokio::test]
    async fn no_network_is_an_error_not_a_panic() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        drop(listener); // nothing is listening any more
        let m = build_message("t", &reminder(), 3).unwrap();
        assert!(send(&make_client(Duration::from_secs(5)), &url, &m).await.is_err());
    }

    #[tokio::test]
    async fn a_server_that_never_answers_times_out() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let _hold = tokio::spawn(async move {
            let _socket = listener.accept().await;
            tokio::time::sleep(Duration::from_secs(30)).await;
        });
        let m = build_message("t", &reminder(), 3).unwrap();
        let started = std::time::Instant::now();
        assert!(send(&make_client(Duration::from_millis(300)), &url, &m).await.is_err());
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    async fn pool() -> sqlx::SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        crate::db::init_cue_schema(&pool).await.unwrap(); // makes the settings table
        pool
    }

    #[tokio::test]
    async fn the_first_ask_makes_a_topic_and_every_later_ask_returns_the_same_one() {
        let pool = pool().await;
        let first = get_or_create_topic_in(&pool).await.unwrap();
        assert!(validate_topic(&first).is_ok());
        assert_eq!(get_or_create_topic_in(&pool).await.unwrap(), first);
        assert_eq!(get_or_create_topic_in(&pool).await.unwrap(), first);
    }

    #[tokio::test]
    async fn a_topic_the_user_chose_replaces_the_generated_one_and_is_kept() {
        let pool = pool().await;
        get_or_create_topic_in(&pool).await.unwrap();
        set_topic_in(&pool, "my-own_topic_9").await.unwrap();
        assert_eq!(get_or_create_topic_in(&pool).await.unwrap(), "my-own_topic_9");
    }

    #[tokio::test]
    async fn a_bad_topic_is_refused_and_the_old_one_stays() {
        let pool = pool().await;
        set_topic_in(&pool, "good_one").await.unwrap();
        assert!(set_topic_in(&pool, "no spaces").await.is_err());
        assert_eq!(get_or_create_topic_in(&pool).await.unwrap(), "good_one");
    }

    #[tokio::test]
    async fn a_damaged_stored_topic_is_reported_not_quietly_replaced() {
        // A new topic would silently stop reminders reaching the phone, which is subscribed to the old one.
        let pool = pool().await;
        sqlx::query("INSERT INTO settings (key, value) VALUES ('ntfy_topic', 'bad topic!')").execute(&pool).await.unwrap();
        let err = get_or_create_topic_in(&pool).await.unwrap_err();
        assert!(err.to_lowercase().contains("topic"), "{err}");
    }
}
