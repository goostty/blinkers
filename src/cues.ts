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
}

export interface Cue extends CueInput {
  id: string;
}

const DAY = 1440;
const WEEK = 7 * DAY;
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

  const days = [...new Set(input.days)].sort((x, y) => x - y);
  if (days.length === 0) return { ok: false, error: 'Pick at least one day.' };
  if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    return { ok: false, error: 'Days must be between Sunday and Saturday.' };
  }

  const flexMin = input.flexMin ?? 0;
  if (!Number.isInteger(flexMin) || flexMin < 0) {
    return { ok: false, error: 'Flex must be zero or more whole minutes.' };
  }
  if (flexMin > MAX_FLEX) {
    return { ok: false, error: `Flex can be at most ${MAX_FLEX} minutes.` };
  }

  const value: CueInput = { label, timeMin: input.timeMin, days: days as Weekday[], flexMin, endsDay: input.endsDay === true };
  const clash = existing.find((c) => cuesOverlap(value, c));
  if (clash) return { ok: false, error: `Overlaps with "${clash.label}".` };

  return { ok: true, value };
}
