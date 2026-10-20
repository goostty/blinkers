// 0 = Sunday ... 6 = Saturday, matching Date.getDay().
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

// A cue is a fixed moment in the user's day ("after school, 3:30 PM") that repeats on chosen
// weekdays. flexMin is how far the real moment can drift either way; the planner still uses
// the exact time. A cue marked endsDay (like "bedtime") closes the chain of blocks before it
// and cannot hold blocks itself.
export interface CueInput {
  label: string;
  timeMin: number; // minutes since local midnight, 0..1439
  days: Weekday[];
  flexMin: number; // +/- minutes
  endsDay: boolean;
  // YYYY-MM-DD. A cue with a date belongs to that one day (a midday plan made for today) instead of
  // repeating every week. The backend sends null for an ordinary cue.
  onDate?: string | null;
}

export interface Cue extends CueInput {
  id: string;
}

const DAY = 1440;
const WEEK = 7 * DAY;

// Same shape check as the backend (validate_created_on): month and day ranges only, not month
// lengths, since it is just a key for the day.
export function isIsoDate(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return false;
  const month = Number(m[2]);
  const day = Number(m[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

// The weekday of a calendar date (0 = Sunday). Expects a date that passed isIsoDate.
export function weekdayOf(isoDate: string): Weekday {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(y, m - 1, d).getDay() as Weekday;
}

// Whether a cue runs on a day: a cue with a date runs on that date only (the same weekday a week
// later does not count), and one without repeats every week on its weekdays. The planner and the
// "what does this follow" picker both ask this, so a dated cue cannot show up in one and not the
// other. The backend has the same rule (cue_runs_on in containers.rs).
export function cueRunsOn(
  cue: { days: readonly number[]; onDate?: string | null },
  day: { isoDate: string; weekday: number },
): boolean {
  if (cue.onDate) return cue.onDate === day.isoDate;
  return cue.days.includes(day.weekday);
}
const MAX_LABEL = 40;
export const MAX_FLEX = 120;

export function parseClock(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// The 24-hour "HH:MM" text an <input type="time"> uses; the inverse of parseClock.
export function toClockValue(min: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}

export function formatClock(min: number): string {
  const h24 = Math.floor(min / 60) % 24;
  const m = min % 60;
  const suffix = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Common patterns read better as a word than as a list of day names.
export function formatDays(days: Weekday[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const key = sorted.join(',');
  if (key === '0,1,2,3,4,5,6') return 'Every day';
  if (key === '1,2,3,4,5') return 'Weekdays';
  if (key === '0,6') return 'Weekends';
  return sorted.map((d) => DAY_NAMES[d]).join(', ');
}

// The stretch of the day the cue's real moment might land in. Energy is averaged over this,
// so a drifty cue near the afternoon dip is judged by the whole range, not one instant.
// startMin can be negative (a 00:05 cue with flex reaches back before midnight).
export function cueSpan(cue: { timeMin: number; flexMin: number }): { startMin: number; durationMin: number } {
  return { startMin: cue.timeMin - cue.flexMin, durationMin: Math.max(1, 2 * cue.flexMin) };
}

// Two cues on the same day conflict when their drift ranges overlap or touch, i.e. when the
// gap between their times is no bigger than the two flexes added together. Measured on the
// weekly circle so Saturday 11:50 PM vs Sunday 12:05 AM is seen as 15 minutes apart.
export function cuesOverlap(a: CueInput, b: CueInput): boolean {
  for (const dayA of a.days) {
    const ta = dayA * DAY + a.timeMin;
    for (const dayB of b.days) {
      const tb = dayB * DAY + b.timeMin;
      const diff = (((ta - tb) % WEEK) + WEEK) % WEEK;
      if (Math.min(diff, WEEK - diff) <= a.flexMin + b.flexMin) return true;
    }
  }
  return false;
}

function isMinute(n: unknown): n is number {
  return Number.isInteger(n) && (n as number) >= 0 && (n as number) < DAY;
}

// Overlapping cues would make "which cue does this block belong to" ambiguous for the
// scheduler, so they are refused at creation rather than resolved later.
export function parseCue(input: CueInput, existing: Cue[]): Result<CueInput> {
  const label = input.label.trim();
  if (!label) return { ok: false, error: 'Give the cue a name.' };
  if (label.length > MAX_LABEL) {
    return { ok: false, error: `Name must be ${MAX_LABEL} characters or fewer.` };
  }

  if (!isMinute(input.timeMin)) return { ok: false, error: 'Pick a valid time.' };

  // A cue for one date has no weekdays to pick: the date decides which weekday it falls on, so
  // any days that were sent are replaced (the overlap check below compares weekdays).
  const onDate = input.onDate == null ? null : input.onDate.trim();
  let days: number[];
  if (onDate !== null) {
    if (!isIsoDate(onDate)) return { ok: false, error: 'Pick a valid date.' };
    days = [weekdayOf(onDate)];
  } else {
    days = [...new Set(input.days)].sort((x, y) => x - y);
    if (days.length === 0) return { ok: false, error: 'Pick at least one day.' };
    if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      return { ok: false, error: 'Days must be between Sunday and Saturday.' };
    }
  }

  const flexMin = input.flexMin ?? 0;
  if (!Number.isInteger(flexMin) || flexMin < 0) {
    return { ok: false, error: 'Flex must be zero or more whole minutes.' };
  }
  if (flexMin > MAX_FLEX) {
    return { ok: false, error: `Flex can be at most ${MAX_FLEX} minutes.` };
  }

  const value: CueInput = {
    label,
    timeMin: input.timeMin,
    days: days as Weekday[],
    flexMin,
    endsDay: input.endsDay === true,
    ...(onDate !== null ? { onDate } : {}), // an ordinary cue carries no date field at all
  };
  // A cue for another date can never meet this one, so it is not a clash.
  const clash = existing.find((c) => !(onDate !== null && c.onDate && c.onDate !== onDate) && cuesOverlap(value, c));
  if (clash) return { ok: false, error: `Overlaps with "${clash.label}".` };

  return { ok: true, value };
}
