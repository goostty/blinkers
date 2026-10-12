export type Chronotype = 'morning' | 'neutral' | 'night';

export interface UserProfile {
  chronotype: Chronotype;
  // hour (0..23) -> energy (1..5). Lets a user correct the default for their own body.
  energyOverrides?: Record<number, number>;
}

// Energy by hour of day, 1 (drained) to 5 (peak). These are DRAFT numbers meant to be tuned:
// the shape is what matters. Everyone has a post-lunch dip around 14:00-16:00 (the circadian
// alertness trough); chronotype moves the morning rise and the evening second wind earlier
// (morning) or later (night). Index = hour of day.
const DEFAULT_CURVES: Record<Chronotype, readonly number[]> = {
  //         0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21 22 23
  morning: [1, 1, 1, 1, 1, 2, 3, 4, 5, 5, 5, 4, 3, 3, 2, 2, 2, 3, 3, 3, 2, 2, 1, 1],
  neutral: [1, 1, 1, 1, 1, 1, 2, 3, 4, 4, 5, 5, 4, 3, 2, 2, 2, 3, 4, 4, 3, 2, 1, 1],
  night: [3, 2, 1, 1, 1, 1, 1, 1, 1, 2, 2, 3, 3, 3, 2, 2, 3, 4, 4, 5, 5, 5, 4, 4],
};

const HOURS = 24;
const DAY = 1440;

// Overrides outside 0..23 / 1..5 are dropped so the 1..5 invariant of the curve always holds.
export function energyCurve(profile: UserProfile): number[] {
  const curve = [...DEFAULT_CURVES[profile.chronotype]];
  for (const [hourKey, value] of Object.entries(profile.energyOverrides ?? {})) {
    const hour = Number(hourKey);
    if (Number.isInteger(hour) && hour >= 0 && hour < HOURS && Number.isInteger(value) && value >= 1 && value <= 5) {
      curve[hour] = value;
    }
  }
  return curve;
}

function hourOf(minute: number): number {
  const m = ((minute % DAY) + DAY) % DAY;
  return Math.floor(m / 60);
}

export function energyAt(profile: UserProfile, minuteOfDay: number): number {
  return energyCurve(profile)[hourOf(minuteOfDay)];
}

// A cue is a stretch of time, not an instant, so a block placed in it feels the average
// energy across the whole stretch. Each minute counts equally, so a window that starts
// mid-hour is weighted by how long it spends in each hour. startMin may exceed 1439 for a
// window that crosses midnight.
export function windowEnergy(profile: UserProfile, startMin: number, durationMin: number): number {
  if (durationMin <= 0) return energyAt(profile, startMin);
  const curve = energyCurve(profile);
  let total = 0;
  for (let m = 0; m < durationMin; m++) total += curve[hourOf(startMin + m)];
  return total / durationMin;
}

// Plain words for the UI; the cut-offs split the 1..5 scale into thirds.
export function describeEnergy(energy: number): 'High' | 'Medium' | 'Low' {
  if (energy >= 3.5) return 'High';
  if (energy >= 2.5) return 'Medium';
  return 'Low';
}
