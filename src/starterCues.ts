import type { CueInput } from './cues';

// A typical day, offered when the user has no cues at all. The app places every block after a
// cue, so with none there is nothing to schedule around. These are only a start: the user can
// change or delete any of them like a cue they made themselves.
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6] as CueInput['days'];

export const STARTER_CUES: CueInput[] = [
  { label: 'Wake up', timeMin: 7 * 60, days: EVERY_DAY, flexMin: 0, endsDay: false },
  { label: 'Lunch', timeMin: 12 * 60, days: EVERY_DAY, flexMin: 0, endsDay: false },
  { label: 'Dinner', timeMin: 18 * 60, days: EVERY_DAY, flexMin: 0, endsDay: false },
  { label: 'Bedtime', timeMin: 22 * 60, days: EVERY_DAY, flexMin: 0, endsDay: true },
];
