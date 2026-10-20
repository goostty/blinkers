import type { TimelineCue } from './timeline';
import type { Urgency } from './scheduler';

// The limits that keep the day balanced, counted in minutes now that blocks have lengths:
//   - Q1 (urgent and important) may use at most half of the day. If everything is urgent,
//     nothing is.
//   - Q2 (important, not urgent) never feels pressing and would lose every day, so a quarter of
//     the day is held for it. Because the user chooses where blocks go, the only way to hold
//     that space is to limit the other urgent work: Q1 and Q3 together may not use the reserve.
// A block over a limit is not deleted, it rolls to tomorrow. Blocks the user has already
// started are never rolled.

const Q1_SHARE = 0.5;
const Q2_RESERVE_SHARE = 0.25;

export interface CapBlock {
  id: string;
  urgency: Urgency | null;
  durationMin: number;
  createdOn: string;
  orderIndex: number;
  committed: boolean; // the user pressed Start on it
}

export interface MinutePolicy {
  maxQ1Min: number; // most minutes Q1 may use
  reserveQ2Min: number; // minutes held back for Q2
  maxUrgentMin: number; // most minutes Q1 and Q3 together may use
}

const DAY = 1440;

// The time cues give the day to fill: each cue has until the next one. An end-of-day cue has
// no time of its own, it just closes the chain before it.
export function dayCapacity(cues: TimelineCue[]): number {
  const sorted = [...cues].sort((a, b) => a.timeMin - b.timeMin);
  let total = 0;
  sorted.forEach((cue, i) => {
    if (cue.endsDay) return;
    total += (sorted[i + 1]?.timeMin ?? DAY) - cue.timeMin;
  });
  return total;
}

// With no Q2 waiting the reserve is released: holding space for work that is not there would
// just leave the day empty.
export function minutePolicy(capacityMin: number, q2WaitingMin: number): MinutePolicy {
  const capacity = Math.max(0, Math.floor(capacityMin));
  if (capacity === 0) return { maxQ1Min: 0, reserveQ2Min: 0, maxUrgentMin: 0 };

  const reserveQ2Min = Math.min(Math.max(0, q2WaitingMin), Math.ceil(capacity * Q2_RESERVE_SHARE));
  return {
    maxQ1Min: Math.min(Math.ceil(capacity * Q1_SHARE), capacity - reserveQ2Min),
    reserveQ2Min,
    maxUrgentMin: capacity - reserveQ2Min,
  };
}

// Started blocks first (they already happened, so they use up their share before anyone
// else), then the oldest, then the earliest made.
const byPriority = (a: CapBlock, b: CapBlock) =>
  Number(b.committed) - Number(a.committed) ||
  a.createdOn.localeCompare(b.createdOn) ||
  a.orderIndex - b.orderIndex;

// Returns the ids to roll to tomorrow: Q1 blocks past the Q1 limit, then Q3 blocks past the
// Q1 + Q3 limit. Once a block does not fit, every later one of the same kind is rolled too,
// so what stays is always the earliest in line, not whatever happens to be short enough.
export function rolledByCaps(blocks: CapBlock[], capacityMin: number): string[] {
  const q2Minutes = blocks.filter((b) => b.urgency === 'important').reduce((sum, b) => sum + b.durationMin, 0);
  const policy = minutePolicy(capacityMin, q2Minutes);
  const rolled: string[] = [];

  const takeWithin = (list: CapBlock[], used: number, limit: number): number => {
    let full = false;
    for (const b of list) {
      if (b.committed) {
        used += b.durationMin;
      } else if (full || used + b.durationMin > limit) {
        full = true;
        rolled.push(b.id);
      } else {
        used += b.durationMin;
      }
    }
    return used;
  };

  const q1 = blocks.filter((b) => b.urgency === 'urgent-important').sort(byPriority);
  const q3 = blocks.filter((b) => b.urgency === 'urgent').sort(byPriority);

  const q1Used = takeWithin(q1, 0, policy.maxQ1Min);
  takeWithin(q3, q1Used, policy.maxUrgentMin);
  return rolled;
}
