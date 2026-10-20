import { formatClock } from './cues';
import type { BlockPlacement, DayBlock } from './dayPlan';

// A commitment as the Today list needs it (see Commitment in commitments.rs).
export interface TodayCommitment {
  blockId: string;
  status: string;
  startMin: number;
  durationMin: number;
}

export type Tone = 'live' | 'waiting' | 'done' | 'warn' | 'muted';

export interface TodayRow {
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
): TodayRow[] {
  const placementOf = new Map(placements.map((p) => [p.blockId, p]));
  const commitmentOf = new Map(commitments.map((c) => [c.blockId, c]));

  const rows = blocks.map((b, index) => {
    const commitment = commitmentOf.get(b.id);
    const placement = placementOf.get(b.id);

    const startMin = commitment?.startMin ?? (placement?.kind === 'placed' ? placement.startMin : null);
    const length = `${b.durationMin} min`;
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

  // Blocks with a time first, by time; the rest after, in the order they arrived.
  rows.sort((a, b) => {
    if (a.startMin !== null && b.startMin !== null) return a.startMin - b.startMin || a.index - b.index;
    if (a.startMin !== null) return -1;
    if (b.startMin !== null) return 1;
    return a.index - b.index;
  });
  return rows.map((r) => r.row);
}
