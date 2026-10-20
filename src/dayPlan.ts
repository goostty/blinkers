import { dayCapacity, rolledByCaps, type CapBlock } from './caps';
import { formatClock, type Cue, type Weekday } from './cues';
import type { BlockType, Urgency } from './scheduler';
import { buildTimeline, removeFromChains, type TimelineBlock, type TimelineCue } from './timeline';

// A block as the backend lists it for one day (see DayBlock in containers.rs).
export interface DayBlock {
  id: string;
  blockType: BlockType;
  orderIndex: number;
  title: string;
  urgency: Urgency | null;
  createdOn: string;
  durationMin: number;
  parentKind: 'cue' | 'block' | null;
  parentId: string | null;
  isCompleted: boolean;
  endedAtMin: number | null;
  committed: boolean; // the user pressed Start
}

// What gets saved for a block that has a place today (PlannedBlock in commitments.rs).
export interface PlannedBlock {
  blockId: string;
  cueId: string;
  startMin: number;
  durationMin: number;
}

//   placed     - has a start time today
//   overflow   - would run past the next cue (or the end of the day), so it moves to tomorrow
//   capped     - over the day's limit for urgent work, so it moves to tomorrow
//   drop       - Q4: neither urgent nor important, the advice is to drop it
//   unattached - nothing to follow yet (for example, carried over from yesterday)
//   invalid    - its links are broken; the reason says how
export type PlacementKind = 'placed' | 'overflow' | 'capped' | 'drop' | 'unattached' | 'invalid';

export interface BlockPlacement {
  blockId: string;
  kind: PlacementKind;
  cueId: string | null;
  startMin: number | null;
  endMin: number | null;
  reason: string;
}

export interface DayPlan {
  placements: BlockPlacement[]; // one per block, in the order the blocks were given
  plan: PlannedBlock[]; // only blocks with a place today, ready to be saved
}

// Puts everything together for one day. The user decides where each block goes (what it
// follows), so this does not choose anything: it applies the day's rules to those choices.
//   1. a block advised to drop (Q4) is left out of the day
//   2. blocks past the daily limits for urgent work roll to tomorrow (caps.ts)
//   3. the rest of each chain closes up around anything removed, and times are worked out
//      from the links (timeline.ts)
// Blocks that did not fit before the next cue also roll to tomorrow.
export function planDay(blocks: DayBlock[], cues: Cue[], weekday: Weekday): DayPlan {
  const todaysCues: TimelineCue[] = cues
    .filter((c) => c.days.includes(weekday))
    .map((c) => ({ id: c.id, timeMin: c.timeMin, endsDay: c.endsDay }));

  const dropped = new Set(blocks.filter((b) => b.urgency === 'neither').map((b) => b.id));
  const live = blocks.filter((b) => !dropped.has(b.id));

  const capBlocks: CapBlock[] = live.map((b) => ({
    id: b.id,
    urgency: b.urgency,
    durationMin: b.durationMin,
    createdOn: b.createdOn,
    orderIndex: b.orderIndex,
    committed: b.committed,
  }));
  const rolled = new Set(rolledByCaps(capBlocks, dayCapacity(todaysCues)));

  const timelineBlocks: TimelineBlock[] = live.map((b) => ({
    id: b.id,
    durationMin: b.durationMin,
    parent: b.parentKind && b.parentId ? { kind: b.parentKind, id: b.parentId } : null,
    ...(b.endedAtMin !== null ? { endedAtMin: b.endedAtMin } : {}),
  }));
  const timeline = buildTimeline(removeFromChains(timelineBlocks, rolled), todaysCues);

  const cueLabel = (id: string) => cues.find((c) => c.id === id)?.label ?? 'its cue';
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const found = new Map<string, BlockPlacement>();
  const plan: PlannedBlock[] = [];

  for (const e of timeline.entries) {
    if (e.fits) {
      found.set(e.blockId, {
        blockId: e.blockId,
        kind: 'placed',
        cueId: e.cueId,
        startMin: e.startMin,
        endMin: e.endMin,
        reason: `Runs ${formatClock(e.startMin)} to ${formatClock(e.endMin)}, after "${cueLabel(e.cueId)}".`,
      });
      plan.push({ blockId: e.blockId, cueId: e.cueId, startMin: e.startMin, durationMin: byId.get(e.blockId)!.durationMin });
    } else {
      found.set(e.blockId, {
        blockId: e.blockId,
        kind: 'overflow',
        cueId: e.cueId,
        startMin: null,
        endMin: null,
        reason: 'Does not fit before the next cue. Moves to tomorrow.',
      });
    }
  }

  const without = (blockId: string, kind: PlacementKind, reason: string) =>
    found.set(blockId, { blockId, kind, cueId: null, startMin: null, endMin: null, reason });

  for (const id of timeline.unattached) without(id, 'unattached', 'Pick what this block follows.');
  for (const p of timeline.invalid) without(p.blockId, 'invalid', p.reason);
  for (const id of rolled) {
    const urgent = byId.get(id)?.urgency === 'urgent-important';
    without(
      id,
      'capped',
      urgent
        ? "Over today's limit for urgent and important work. Moves to tomorrow."
        : 'Would use the time kept for important work that is not urgent. Moves to tomorrow.',
    );
  }
  for (const id of dropped) without(id, 'drop', 'Neither urgent nor important: consider dropping this task.');

  return { placements: blocks.map((b) => found.get(b.id)!), plan };
}

// The short text for the header bar.
export function placementText(p: BlockPlacement, cues: Cue[]): string {
  switch (p.kind) {
    case 'placed': {
      const time = formatClock(p.startMin!);
      const label = cues.find((c) => c.id === p.cueId)?.label;
      return label ? `${time} · ${label}` : time;
    }
    case 'overflow':
    case 'capped':
      return 'Moves to tomorrow';
    case 'drop':
      return 'Consider dropping';
    case 'unattached':
      return 'Needs a place today';
    case 'invalid':
      return 'Needs attention';
  }
}
