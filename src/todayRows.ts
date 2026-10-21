import { formatClock } from './cues';
import type { BlockPlacement, DayBlock } from './dayPlan';
import type { TimelineBreak } from './timeline';

// A commitment as the Today list needs it (see Commitment in commitments.rs).
export interface TodayCommitment {
  blockId: string;
  status: string;
  startMin: number;
  durationMin: number;
}

export type Tone = 'live' | 'waiting' | 'done' | 'warn' | 'muted';

// A cue as the Today list needs it: the moment a chain of blocks hangs from.
export interface TodayCue {
  id: string;
  label: string;
  timeMin: number;
}

export interface TodayRow {
  kind?: 'cue'; // a cue, not a block: it only tells the user what comes next
  blockId: string;
  title: string;
  timeText: string;
  statusText: string;
  tone: Tone;
  canEdit: boolean;
  canDrop: boolean;
}

const TYPE_LABEL: Record<string, string> = {
  deep: 'Deep work',
  routine: 'Routine',
  reset: 'Reset',
  recharge: 'Recharge',
};

const COMMITMENT_STATUS: Record<string, [string, Tone]> = {
  planned: ['Planned', 'muted'],
  nagging: ['Waiting for you', 'waiting'],
  started: ['In progress', 'live'],
  finished: ['Done', 'done'],
  lapsed: ['Lapsed', 'warn'],
  missed: ['Missed', 'warn'],
};

// What a block with no time today is waiting on. `placed` is here only for a block the plan has
// not saved a commitment for yet.
const PLACEMENT_STATUS: Record<BlockPlacement['kind'], [string, Tone]> = {
  placed: ['Planned', 'muted'],
  overflow: ['Rolls to tomorrow', 'muted'],
  capped: ["Over today's limit", 'muted'],
  drop: ['Advised to drop', 'muted'],
  unattached: ['Needs a place', 'warn'],
  invalid: ['Needs attention', 'warn'],
};

// A recharge break is part of the day but not something the user manages, so its row has no
// buttons. It says plainly that it is rest: the time is kept for recovery, not for anything else.
function breakRow(b: TimelineBreak): TodayRow {
  return {
    blockId: `break:${b.afterBlockId}`,
    title: 'Recharge',
    timeText: `${formatClock(b.startMin)} · ${b.endMin - b.startMin} min`,
    statusText: 'Rest, not free time',
    tone: 'muted',
    canEdit: false,
    canDrop: false,
  };
}

// The user did not place the blocks, so each cue says what it leads to: the first block that
// follows it, and when, if that is not at the cue itself. That is the transition the user is about
// to make, so they are told before they reach it.
function cueRow(cue: TodayCue, first: { title: string; startMin: number }): TodayRow {
  const when = first.startMin === cue.timeMin ? '' : ` at ${formatClock(first.startMin)}`;
  return {
    kind: 'cue',
    blockId: `cue:${cue.id}`,
    title: cue.label,
    timeText: formatClock(cue.timeMin),
    statusText: `Then: ${first.title}${when}`,
    tone: 'muted',
    canEdit: false,
    canDrop: false,
  };
}

// One row per block for the Today list, in the order the day will happen. A block's status comes
// from its commitment when it has one, because that is what the reminders act on; otherwise from
// why the plan could not give it a time. A block the plan knows nothing about is shown as needing
// attention rather than dropped from the list, so nothing can quietly disappear from the screen.
// Buttons mirror what the backend allows: a finished block is history, a recharge block has no
// text to edit, and one in progress ends through Lapse, not Drop.
export function buildTodayRows(
  blocks: DayBlock[],
  placements: BlockPlacement[],
  commitments: TodayCommitment[],
  breaks: TimelineBreak[] = [],
  cues: TodayCue[] = [],
): TodayRow[] {
  const placementOf = new Map(placements.map((p) => [p.blockId, p]));
  const commitmentOf = new Map(commitments.map((c) => [c.blockId, c]));

  const rows = blocks.map((b, index) => {
    const commitment = commitmentOf.get(b.id);
    const placement = placementOf.get(b.id);

    const startMin = commitment?.startMin ?? (placement?.kind === 'placed' ? placement.startMin : null);
    // The length the plan gave the block, which is shorter than the one entered when the day was
    // shortened to fit. A reminder that was already saved says what the phone will say; a block
    // that has started keeps the length it was entered with, since it may be running over.
    const planned = placement?.kind === 'placed' && !b.committed && !b.isCompleted ? placement.endMin! - placement.startMin! : b.durationMin;
    const length = `${commitment?.durationMin ?? planned} min`;
    const timeText = startMin === null ? length : `${formatClock(startMin)} · ${length}`;

    let [statusText, tone]: [string, Tone] = placement
      ? PLACEMENT_STATUS[placement.kind]
      : ['Needs attention', 'warn'];
    if (commitment && COMMITMENT_STATUS[commitment.status]) [statusText, tone] = COMMITMENT_STATUS[commitment.status];
    if (b.isCompleted) [statusText, tone] = COMMITMENT_STATUS.finished;

    const open = !b.isCompleted && commitment?.status !== 'finished';
    const row: TodayRow = {
      blockId: b.id,
      title: b.title.trim() || TYPE_LABEL[b.blockType] || 'Block',
      timeText,
      statusText,
      tone,
      canEdit: open && b.blockType !== 'recharge',
      canDrop: open && commitment?.status !== 'started',
    };
    return { row, startMin, index };
  });

  // Each cue goes in just ahead of its first block, even when they share a minute.
  cues.forEach((cue, i) => {
    const first = rows
      .filter((r) => placementOf.get(r.row.blockId)?.kind === 'placed' && placementOf.get(r.row.blockId)?.cueId === cue.id)
      .sort((a, b) => a.startMin! - b.startMin!)[0];
    if (first) rows.push({ row: cueRow(cue, { title: first.row.title, startMin: first.startMin! }), startMin: cue.timeMin, index: -1000 + i });
  });

  // The breaks sit among the blocks by their time, so they sort in with the ones that have one.
  breaks.forEach((b, i) => rows.push({ row: breakRow(b), startMin: b.startMin, index: blocks.length + i }));

  // Blocks with a time first, by time; the rest after, in the order they arrived.
  rows.sort((a, b) => {
    if (a.startMin !== null && b.startMin !== null) return a.startMin - b.startMin || a.index - b.index;
    if (a.startMin !== null) return -1;
    if (b.startMin !== null) return 1;
    return a.index - b.index;
  });
  return rows.map((r) => r.row);
}
