import { dayCapacity, rolledByCaps, type CapBlock } from './caps';
import { cueRunsOn, formatClock, type Cue, type Weekday } from './cues';
import type { BlockType, Urgency } from './scheduler';
import { resolveFit, type FitChoice, type FitMeta } from './fit';
import { buildTimeline, removeFromChains, type TimelineBlock, type TimelineBreak, type TimelineCue } from './timeline';

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
  startedAtMin?: number | null; // when they pressed it, in minutes since local midnight
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

// What the day needed when it did not fit before the next cue (see fit.ts).
//   needsDecision - the user has not chosen how to fix it, so the recommended way is applied for
//                   now and the screen should ask
//   applied       - the way actually used: shorten everything, or drop the lowest priority blocks
//   dropped       - the blocks dropping rolls to tomorrow (rolled if applied is 'drop')
export interface FitSummary {
  needsDecision: boolean;
  applied: FitChoice | null;
  recommended: FitChoice | null;
  shortenPercent: number | null;
  dropped: string[];
}

export interface DayPlan {
  placements: BlockPlacement[]; // one per block, in the order the blocks were given
  plan: PlannedBlock[]; // only blocks with a place today, ready to be saved
  breaks: TimelineBreak[]; // recharge between work blocks: shown in the day, never saved or reminded
  fit: FitSummary;
}

// `nowMin` lets a running block keep the time it is really using. `notBeforeMin` is the earliest a
// block that has not started may begin, set after the user decides about a missed block. `fit` is
// how the user chose to fix a day that does not fit; 'off' switches fixing off, so what does not
// fit simply overflows (used when trying out a place for a new block).
export interface PlanOptions {
  nowMin?: number;
  notBeforeMin?: number;
  fit?: FitChoice | 'off';
}

// Puts everything together for one day. The user decides where each block goes (what it
// follows), so this does not choose anything: it applies the day's rules to those choices.
//   1. a block advised to drop (Q4) is left out of the day
//   2. blocks past the daily limits for urgent work roll to tomorrow (caps.ts)
//   3. the rest of each chain closes up around anything removed, and times are worked out
//      from the links (timeline.ts)
// 4. blocks that do not fit before the next cue are fixed as the user chose: everything still to
//    come is shortened a little, or the lowest priority blocks roll to tomorrow (fit.ts)
//
// `isoDate` is today's date, needed for cues that belong to one date. Without it only weekly
// cues run: a dated cue is never assumed to be today's.
export function planDay(blocks: DayBlock[], cues: Cue[], weekday: Weekday, isoDate?: string, options: PlanOptions = {}): DayPlan {
  const today = { isoDate: isoDate ?? '', weekday };
  const todaysCues: TimelineCue[] = cues
    .filter((c) => cueRunsOn(c, today))
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
    blockType: b.blockType,
    parent: b.parentKind && b.parentId ? { kind: b.parentKind, id: b.parentId } : null,
    ...(b.startedAtMin != null ? { startedAtMin: b.startedAtMin } : {}),
    ...(b.endedAtMin !== null ? { endedAtMin: b.endedAtMin } : {}),
  }));
  const chains = removeFromChains(timelineBlocks, rolled);
  const clock = { nowMin: options.nowMin, notBeforeMin: options.notBeforeMin };

  const meta = new Map<string, FitMeta>(
    live.map((b) => [b.id, { urgency: b.urgency, createdOn: b.createdOn, orderIndex: b.orderIndex, committed: b.committed }]),
  );
  const fitted = options.fit === 'off' ? null : resolveFit(chains, todaysCues, meta, clock, options.fit);
  const timeline = fitted ? fitted.timeline : buildTimeline(chains, todaysCues, clock);
  const droppedForRoom = new Set(fitted?.applied === 'drop' ? fitted.dropped : []);
  const shortened = fitted?.applied === 'shorten';

  const cueLabel = (id: string) => cues.find((c) => c.id === id)?.label ?? 'its cue';
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const found = new Map<string, BlockPlacement>();
  const plan: PlannedBlock[] = [];
  const shortenedBy = (id: string, length: number) => {
    const original = byId.get(id)!;
    return shortened && !original.committed && !original.isCompleted && length < original.durationMin;
  };

  for (const e of timeline.entries) {
    if (e.fits) {
      found.set(e.blockId, {
        blockId: e.blockId,
        kind: 'placed',
        cueId: e.cueId,
        startMin: e.startMin,
        endMin: e.endMin,
        reason:
          `Runs ${formatClock(e.startMin)} to ${formatClock(e.endMin)}, after "${cueLabel(e.cueId)}".` +
          (shortenedBy(e.blockId, e.endMin - e.startMin) ? ` Shortened to ${e.endMin - e.startMin} min to fit the day.` : ''),
      });
      // A block still to come is saved at the length the plan gave it (shortened, if it was); one
      // that has started keeps the length it was entered with, since its row is already fixed.
      const original = byId.get(e.blockId)!;
      const started = original.committed || original.isCompleted;
      plan.push({ blockId: e.blockId, cueId: e.cueId, startMin: e.startMin, durationMin: started ? original.durationMin : e.endMin - e.startMin });
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
  for (const id of droppedForRoom) {
    const itself = fitted?.unfitBefore.includes(id);
    without(
      id,
      'overflow',
      itself
        ? 'Does not fit before the next cue. Moves to tomorrow.'
        : 'Moves to tomorrow to make room: it was the lowest priority when the day ran out of time.',
    );
  }
  for (const id of dropped) without(id, 'drop', 'Neither urgent nor important: consider dropping this task.');

  // The user has to be asked while something does not fit and they have not chosen a way out that
  // worked. Their choice counts only if it is what was actually applied.
  const needsDecision = !!fitted && !fitted.fits && options.fit !== fitted.applied;
  const fit: FitSummary = fitted
    ? { needsDecision, applied: fitted.applied, recommended: fitted.recommended, shortenPercent: fitted.shortenPercent, dropped: fitted.dropped }
    : { needsDecision: false, applied: null, recommended: null, shortenPercent: null, dropped: [] };

  return { placements: blocks.map((b) => found.get(b.id)!), plan, breaks: timeline.breaks, fit };
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
