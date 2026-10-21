import type { ParentChoice } from './attach';
import { cueRunsOn, formatClock, type Cue, type Weekday } from './cues';
import { planDay, type DayBlock } from './dayPlan';
import { describeEnergy, windowEnergy, type UserProfile } from './energy';
import { readNameHints, type EnergyNeed, type TimeWindow } from './nameReader';
import type { BlockType, Urgency } from './scheduler';

// Suggests where a new block should go today. It never decides for the user: the add form
// pre-selects the answer and the user can change it.
//
// Rather than copy the day's rules, every possible place is tried for real: the block is inserted
// into a copy of the day and planDay is run. A place is only kept if the new block ends up placed
// and nothing that was already placed is pushed out. So breaks, cues and the daily limits are
// applied exactly as they will be when the block is saved.

export interface NewBlock {
  blockType: BlockType;
  urgency: Urgency | null;
  durationMin: number;
  title: string;
}

export interface SuggestInput {
  block: NewBlock;
  blocks: DayBlock[]; // everything already in today's list
  cues: Cue[];
  weekday: Weekday;
  isoDate: string;
  nowMin: number; // minutes since local midnight; nothing is ever suggested before this
  profile: UserProfile;
}

export type Suggestion =
  | { kind: 'slot'; parent: ParentChoice; startMin: number; endMin: number; reason: string }
  | { kind: 'tomorrow'; reason: string } // nothing fits today; it waits and is suggested again tomorrow
  | { kind: 'none'; reason: string }; // there is nothing to suggest, and nothing to wait for

const NEW_ID = '__suggested__';

// Energy (1..5) a block of each need is happiest in. Deep work wants the sharpest hours,
// routine work the middle, and rest the quiet ones.
const ENERGY_TARGET: Record<EnergyNeed, number> = { High: 5, Medium: 3, Low: 1 };

interface Candidate {
  parent: ParentChoice;
  label: string;
  startMin: number;
  endMin: number;
  energy: number;
  betweenDeep: boolean; // sits between two deep blocks
}

const isRest = (type: BlockType) => type === 'reset' || type === 'recharge';

// 0 is the most urgent. Rest the user made ranks last, so it can only go after the work.
const PRIORITY: Record<string, number> = { 'urgent-important': 0, important: 1, urgent: 2 };
export const priorityOf = (urgency: Urgency | null) => (urgency === null ? 3 : (PRIORITY[urgency] ?? 1));
const follows = (b: DayBlock, parent: ParentChoice) => b.parentKind === parent.kind && b.parentId === parent.id;
const hundredths = (n: number) => Math.round(n * 100);

export function suggestSlot(input: SuggestInput): Suggestion {
  const { block, blocks, cues, weekday, isoDate, nowMin, profile } = input;
  if (block.urgency === 'neither') {
    return { kind: 'none', reason: 'Neither urgent nor important: this is advised to drop, so it is not placed.' };
  }

  const today = { isoDate, weekday };
  const todaysCues = cues.filter((c) => cueRunsOn(c, today) && !c.endsDay);
  if (todaysCues.length === 0) return { kind: 'none', reason: 'No cue runs today for this to follow.' };

  // Trying a place must never be allowed to reshape the day (shortening or dropping other blocks
  // to make room), so the fixing is switched off: a place that does not fit as it is, is not a place.
  const strict = { fit: 'off' as const };
  const base = planDay(blocks, cues, weekday, isoDate, strict);
  const placedBefore = base.placements.filter((p) => p.kind === 'placed').map((p) => p.blockId);
  const byId = new Map(blocks.map((b) => [b.id, b]));

  const parents: { parent: ParentChoice; label: string }[] = [
    ...todaysCues.map((c) => ({ parent: { kind: 'cue' as const, id: c.id }, label: c.label })),
    ...placedBefore.map((id) => ({ parent: { kind: 'block' as const, id }, label: byId.get(id)?.title.trim() || 'a block' })),
  ];

  const open: Candidate[] = [];
  for (const { parent, label } of parents) {
    const follower = blocks.find((b) => follows(b, parent));

    // Everything after this place would be pushed later by the new block. A block must never be
    // put ahead of one that is more urgent, even where its own ranking (the energy it wants)
    // would pick that place, or placing blocks one at a time would let a late, small job bump
    // the work that mattered most.
    const pushed: DayBlock[] = [];
    for (let link: ParentChoice = parent, i = 0; i < blocks.length; i++) {
      const next = blocks.find((b) => follows(b, link));
      if (!next) break;
      pushed.push(next);
      link = { kind: 'block', id: next.id };
    }
    if (pushed.some((b) => priorityOf(b.urgency) < priorityOf(block.urgency))) continue;

    const trial: DayBlock[] = [
      ...blocks.map((b) => (b === follower ? { ...b, parentKind: 'block' as const, parentId: NEW_ID } : b)),
      {
        id: NEW_ID,
        blockType: block.blockType,
        orderIndex: Number.MAX_SAFE_INTEGER,
        title: block.title,
        urgency: block.urgency,
        createdOn: isoDate,
        durationMin: block.durationMin,
        parentKind: parent.kind,
        parentId: parent.id,
        isCompleted: false,
        endedAtMin: null,
        committed: false,
      },
    ];
    const after = planDay(trial, cues, weekday, isoDate, strict);
    const mine = after.placements.find((p) => p.blockId === NEW_ID);
    if (!mine || mine.kind !== 'placed') continue;
    const stillPlaced = new Set(after.placements.filter((p) => p.kind === 'placed').map((p) => p.blockId));
    if (placedBefore.some((id) => !stillPlaced.has(id))) continue; // would push someone out of the day

    const owner = parent.kind === 'block' ? byId.get(parent.id) : undefined;
    open.push({
      parent,
      label,
      startMin: mine.startMin!,
      endMin: mine.endMin!,
      energy: windowEnergy(profile, mine.startMin!, block.durationMin),
      betweenDeep: owner?.blockType === 'deep' && follower?.blockType === 'deep',
    });
  }

  const hints = readNameHints(block.title, block.blockType);
  const window = hints.window;

  let candidates = open.filter((c) => c.startMin >= nowMin); // the past is closed
  if (window) candidates = candidates.filter((c) => c.startMin >= window.startMin && c.endMin <= window.endMin);

  // Routine work is the lighter work that goes between deep blocks, when there is such a gap.
  if (block.blockType === 'routine') {
    const gaps = candidates.filter((c) => c.betweenDeep);
    if (gaps.length > 0) candidates = gaps;
  }

  if (candidates.length === 0) return { kind: 'tomorrow', reason: tomorrowReason(window, nowMin) };

  const best = [...candidates].sort((a, b) => primary(a, block, hints.energyNeed) - primary(b, block, hints.energyNeed) || a.startMin - b.startMin)[0];
  return {
    kind: 'slot',
    parent: best.parent,
    startMin: best.startMin,
    endMin: best.endMin,
    reason: explain(best, block, window),
  };
}

// Lower is better; ties go to the earlier start (the caller's second sort key).
//   rest:  as late as possible, after everything else
//   Q1:    as early as possible, it cannot wait
//   Q2:    the energy that best matches what the block needs, so important work gets the right hours
//   Q3:    the lowest energy, so the sharp hours stay free for important work
function primary(c: Candidate, block: NewBlock, need: EnergyNeed): number {
  if (isRest(block.blockType)) return -c.startMin;
  if (block.urgency === 'important') return hundredths(Math.abs(c.energy - ENERGY_TARGET[need]));
  if (block.urgency === 'urgent') return hundredths(c.energy);
  return c.startMin;
}

function tomorrowReason(window: TimeWindow | null, nowMin: number): string {
  if (!window) return 'No room is left today. It goes to the earliest slot tomorrow.';
  if (nowMin >= window.endMin) return `The ${window.name} has passed. It goes to the earliest ${window.name} slot tomorrow.`;
  return `No room is left in the ${window.name} today. It goes to the earliest ${window.name} slot tomorrow.`;
}

function explain(c: Candidate, block: NewBlock, window: TimeWindow | null): string {
  const parts = [`after "${c.label}"`];
  if (window) parts.push(`inside your ${window.name}`);
  if (isRest(block.blockType)) parts.push('after everything else');
  else if (block.urgency === 'urgent-important') parts.push('the earliest it can go');
  else parts.push(`${describeEnergy(c.energy).toLowerCase()} energy`);
  return `${formatClock(c.startMin)} · ${parts.join(', ')}`;
}
