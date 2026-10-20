// What a reminder says and when one is due. The notifier (notifier.rs) sends it.

// The cadence is a first guess to tune with use: one reminder when the block's time arrives, then
// one every five minutes, six in all. A reminder that repeats forever stops being read.
pub const NAG_INTERVAL_SEC: i64 = 5 * 60;
pub const MAX_NAGS: i32 = 6;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Step {
    Wait,
    Remind,
    Miss,
}

// Decides what to do with one commitment that has not been acted on. Starting is the only way
// out of the reminders, so a block keeps getting them until its own window (start to start +
// length) is over; after that it is `missed`. Reminders are decided from the stored count and
// time of the last one, not from memory, so a restart does not forget or repeat them. A clock
// that went backwards waits instead of sending, because "time since the last reminder" would
// be meaningless.
pub fn next_step(
    status: &str,
    start_min: i32,
    duration_min: i32,
    nag_count: i32,
    last_nag_at: Option<i64>,
    now_min: i32,
    now_unix: i64,
) -> Step {
    if status != "planned" && status != "nagging" {
        return Step::Wait;
    }
    if now_min >= start_min + duration_min {
        return Step::Miss;
    }
    if now_min < start_min {
        return Step::Wait;
    }
    if status == "planned" {
        return Step::Remind;
    }
    if nag_count >= MAX_NAGS {
        return Step::Wait;
    }
    match last_nag_at {
        None => Step::Remind,
        Some(last) if now_unix >= last + NAG_INTERVAL_SEC => Step::Remind,
        Some(_) => Step::Wait,
    }
}

// ntfy's own scale, 1 to 5. The first reminder is a normal one; if it is ignored the next two
// are high; from the fourth on it is max, which makes the phone alert persistently. `nags_so_far`
// is how many reminders have already gone out.
pub fn priority_for(nags_so_far: i32) -> u8 {
    match nags_so_far {
        i32::MIN..=0 => 3,
        1..=2 => 4,
        _ => 5,
    }
}

// The words of a reminder.
#[derive(Clone, Debug, PartialEq)]
pub struct Reminder {
    pub title: String,
    pub body: String,
}

// "3:30 PM"; the same format the UI uses (formatClock in src/cues.ts).
pub fn format_clock(min: i32) -> String {
    let h24 = (min / 60) % 24;
    let m = min % 60;
    let suffix = if h24 >= 12 { "PM" } else { "AM" };
    let h12 = if h24 % 12 == 0 { 12 } else { h24 % 12 };
    format!("{h12}:{m:02} {suffix}")
}

fn type_label(block_type: &str) -> &'static str {
    match block_type {
        "deep" => "Deep work",
        "routine" => "Routine",
        "reset" => "Reset",
        _ => "Recharge",
    }
}

// The reminder only works if starting is easier than ignoring it. So the body hands over the
// block's own "first step" (the action trigger the user wrote for exactly this moment) instead
// of a vague "time for your task", and a repeat says it is a repeat: an identical message is
// the easiest one to swipe away without reading. Recharge blocks have no title, so they are
// named after their type.
pub fn reminder_text(
    block_type: &str,
    title: &str,
    action_trigger: Option<&str>,
    start_min: i32,
    cue_label: Option<&str>,
    nag_count: i32,
) -> Reminder {
    let name = match title.trim() {
        "" => type_label(block_type).to_string(),
        t => t.to_string(),
    };
    let title = if nag_count > 0 { format!("Still waiting: {name}") } else { name };

    let first_step = match action_trigger.map(str::trim) {
        Some(t) if !t.is_empty() => format!("First step: {t}"),
        _ => "Time to start.".to_string(),
    };
    let when = match cue_label {
        Some(label) => format!("{} · {label}", format_clock(start_min)),
        None => format_clock(start_min),
    };

    Reminder { title, body: format!("{first_step}\n{when}") }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_body_leads_with_the_first_step_then_when_and_where() {
        let r = reminder_text("deep", "Write the report", Some("Open report.md at line 42"), 930, Some("After school"), 0);
        assert_eq!(r.title, "Write the report");
        assert_eq!(r.body, "First step: Open report.md at line 42\n3:30 PM · After school");
    }

    #[test]
    fn without_a_first_step_the_body_just_says_to_start() {
        let r = reminder_text("deep", "Write", None, 600, Some("Morning"), 0);
        assert_eq!(r.body, "Time to start.\n10:00 AM · Morning");
    }

    #[test]
    fn a_blank_first_step_counts_as_none() {
        let r = reminder_text("deep", "Write", Some("   "), 600, None, 0);
        assert!(r.body.starts_with("Time to start."));
    }

    #[test]
    fn an_untitled_block_is_named_after_its_type() {
        // Recharge blocks have no title field.
        assert_eq!(reminder_text("recharge", "", None, 600, None, 0).title, "Recharge");
        assert_eq!(reminder_text("deep", "  ", None, 600, None, 0).title, "Deep work");
        assert_eq!(reminder_text("routine", "", None, 600, None, 0).title, "Routine");
        assert_eq!(reminder_text("reset", "", None, 600, None, 0).title, "Reset");
    }

    #[test]
    fn without_a_cue_label_the_time_stands_alone() {
        let r = reminder_text("deep", "Write", None, 600, None, 0);
        assert_eq!(r.body, "Time to start.\n10:00 AM");
    }

    #[test]
    fn repeats_say_so_in_the_title_but_keep_the_same_body() {
        let first = reminder_text("deep", "Write", Some("Open it"), 600, Some("Morning"), 0);
        let again = reminder_text("deep", "Write", Some("Open it"), 600, Some("Morning"), 3);
        assert_eq!(again.title, "Still waiting: Write");
        assert_eq!(again.body, first.body);
    }

    #[test]
    fn clock_times_use_a_twelve_hour_clock() {
        for (min, text) in [(0, "12:00 AM"), (5, "12:05 AM"), (600, "10:00 AM"), (720, "12:00 PM"), (930, "3:30 PM"), (1439, "11:59 PM")] {
            assert_eq!(format_clock(min), text, "{min}");
        }
    }

    // 10:00 start, 30 minute block: the window is 600..630.
    fn step(status: &str, nags: i32, last: Option<i64>, now_min: i32, now_unix: i64) -> Step {
        next_step(status, 600, 30, nags, last, now_min, now_unix)
    }

    #[test]
    fn nothing_happens_before_the_start_time() {
        assert_eq!(step("planned", 0, None, 599, 0), Step::Wait);
    }

    #[test]
    fn the_first_reminder_goes_out_when_the_start_time_arrives() {
        assert_eq!(step("planned", 0, None, 600, 0), Step::Remind);
        assert_eq!(step("planned", 0, None, 615, 0), Step::Remind); // late, but still inside the window
    }

    #[test]
    fn a_reminder_repeats_only_after_the_gap() {
        let t = 10_000;
        assert_eq!(step("nagging", 1, Some(t), 605, t + NAG_INTERVAL_SEC - 1), Step::Wait);
        assert_eq!(step("nagging", 1, Some(t), 605, t + NAG_INTERVAL_SEC), Step::Remind);
    }

    #[test]
    fn the_reminders_stop_after_the_limit() {
        let t = 10_000;
        assert_eq!(step("nagging", MAX_NAGS - 1, Some(t), 620, t + 99_999), Step::Remind);
        assert_eq!(step("nagging", MAX_NAGS, Some(t), 620, t + 99_999), Step::Wait);
    }

    #[test]
    fn a_clock_that_went_backwards_never_sends_a_reminder() {
        assert_eq!(step("nagging", 1, Some(10_000), 605, 5_000), Step::Wait);
    }

    #[test]
    fn a_nagging_block_with_no_record_of_the_last_reminder_gets_one() {
        assert_eq!(step("nagging", 1, None, 605, 0), Step::Remind);
    }

    #[test]
    fn a_block_whose_window_has_passed_is_missed_not_reminded() {
        assert_eq!(step("planned", 0, None, 630, 0), Step::Miss);
        assert_eq!(step("nagging", 2, Some(0), 700, 99_999), Step::Miss);
        assert_eq!(step("planned", 0, None, 629, 0), Step::Remind); // the last minute still counts
    }

    #[test]
    fn a_block_the_user_has_acted_on_is_left_alone() {
        for status in ["started", "finished", "lapsed", "missed", "weird"] {
            assert_eq!(step(status, 0, None, 700, 0), Step::Wait, "{status}");
        }
    }

    #[test]
    fn the_reminder_gets_louder_the_longer_it_is_ignored() {
        let levels: Vec<u8> = (0..8).map(priority_for).collect();
        assert_eq!(levels, vec![3, 4, 4, 5, 5, 5, 5, 5]);
    }
}
