import { cueSpan, formatClock, type Cue, type Weekday } from './cues';
import { windowEnergy, type UserProfile } from './energy';

export type BlockType = 'deep' | 'routine' | 'reset' | 'recharge';

export interface BlockRequest {
  id: string;
  type: BlockType;
  orderIndex: number;
}

export interface Assignment {
  blockId: string;
  cueId: string | null; // null = unscheduled, see reason
  startMin: number | null; // minutes since local midnight
  reason: string;
}

// The energy (1..5) each kind of block wants. Deep work needs the best energy of the day;
// recharge is rest, so it belongs in the trough where focus is poor anyway.
export const ENERGY_DEMAND: Record<BlockType, number> = {
  deep: 5,
  routine: 3,
  reset: 2,
  recharge: 1,
};

const LABEL: Record<BlockType, string> = {
  deep: 'Deep work',
  routine: 'Routine',
  reset: 'Reset',
  recharge: 'Recharge',
};

interface Slot {
  cue: Cue;
  startMin: number;
  energy: number;
  taken: boolean;
}

const unscheduled = (blockId: string, reason: string): Assignment => ({
  blockId,
  cueId: null,
  startMin: null,
  reason,
});

// Hardest first: deep work is the scarce resource (only a few high-energy moments a day), so
// it picks before lighter blocks can take its cue. Each block then takes the free cue whose
// average energy is closest to what it wants. A tie prefers a cue that is not underpowered,
// then the earlier one. A cue holds one block; blocks left over stay unscheduled instead of
// being forced into a bad slot. Results come back in input order.
export function assignBlocks(
  blocks: BlockRequest[],
  cues: Cue[],
  profile: UserProfile,
  day: Weekday,
  nowMin = 0,
): Assignment[] {
  const todays = cues.filter((c) => c.days.includes(day));

  // A cue is still usable until the end of its drift range. If we are already inside that
  // range the block starts now rather than at a time that has gone.
  const slots: Slot[] = todays
    .filter((c) => nowMin <= c.timeMin + c.flexMin)
    .map((cue) => {
      const span = cueSpan(cue);
      return {
        cue,
        startMin: Math.max(cue.timeMin, nowMin),
        energy: windowEnergy(profile, span.startMin, span.durationMin),
        taken: false,
      };
    })
    .sort((a, b) => a.startMin - b.startMin);

  const results = new Map<string, Assignment>();

  const processing = [...blocks].sort(
    (a, b) => ENERGY_DEMAND[b.type] - ENERGY_DEMAND[a.type] || a.orderIndex - b.orderIndex,
  );

  for (const block of processing) {
    if (todays.length === 0) {
      results.set(block.id, unscheduled(block.id, 'No cues on this day.'));
      continue;
    }
    if (slots.length === 0) {
      results.set(block.id, unscheduled(block.id, 'No cues left today.'));
      continue;
    }

    const demand = ENERGY_DEMAND[block.type];

    let best: Slot | null = null;
    let bestGap = Infinity;
    let bestUnder = true;
    for (const s of slots) {
      if (s.taken) continue;
      const gap = Math.abs(s.energy - demand);
      const under = s.energy < demand;
      if (gap < bestGap || (gap === bestGap && bestUnder && !under)) {
        best = s;
        bestGap = gap;
        bestUnder = under;
      }
    }

    if (!best) {
      results.set(block.id, unscheduled(block.id, 'Every remaining cue already has a block.'));
      continue;
    }

    best.taken = true;

    const note = bestGap === 0 ? 'matches' : best.energy < demand ? 'is below' : 'is above';
    results.set(block.id, {
      blockId: block.id,
      cueId: best.cue.id,
      startMin: best.startMin,
      reason: `${LABEL[block.type]} wants energy ${demand}; "${best.cue.label}" at ${formatClock(best.startMin)} averages ${best.energy.toFixed(1)}, which ${note} that.`,
    });
  }

  return blocks.map((b) => results.get(b.id)!);
}

// "Today" is the user's local calendar day, not UTC: a 11 PM block in a UTC+10 timezone still
// belongs to that local date. Weekday uses Sunday = 0 like the cues do.
export function describeMoment(now: Date): { isoDate: string; weekday: Weekday; nowMin: number } {
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    isoDate: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    weekday: now.getDay() as Weekday,
    nowMin: now.getHours() * 60 + now.getMinutes(),
  };
}

export function suggestionText(assignment: Assignment, cues: Cue[]): string {
  if (assignment.startMin === null) return 'Unscheduled';
  const time = formatClock(assignment.startMin);
  const label = cues.find((c) => c.id === assignment.cueId)?.label;
  return label ? `${time} · ${label}` : time;
}
