import { describe, expect, it } from 'vitest';
import type { BlockPlacement, DayBlock } from '../dayPlan';
import { buildTodayRows, type TodayCommitment } from '../todayRows';

const block = (id: string, over: Partial<DayBlock> = {}): DayBlock => ({
  id,
  blockType: 'deep',
  orderIndex: 0,
  title: id,
  urgency: 'important',
  createdOn: '2026-10-20',
  durationMin: 30,
  parentKind: 'cue',
  parentId: 'cue1',
  isCompleted: false,
  endedAtMin: null,
  committed: false,
  ...over,
});

const placed = (blockId: string, startMin: number, endMin = startMin + 30): BlockPlacement => ({
  blockId,
  kind: 'placed',
  cueId: 'cue1',
  startMin,
  endMin,
  reason: '',
});

const other = (blockId: string, kind: BlockPlacement['kind'], reason = ''): BlockPlacement => ({
  blockId,
  kind,
  cueId: null,
  startMin: null,
  endMin: null,
  reason,
});

const commitment = (blockId: string, status: string, startMin: number): TodayCommitment => ({
  blockId,
  status,
  startMin,
  durationMin: 30,
});

describe('buildTodayRows', () => {
  it('lists the day in the order it will happen, whatever order the blocks arrive in', () => {
    const rows = buildTodayRows(
      [block('late'), block('early')],
      [placed('late', 900), placed('early', 600)],
      [],
    );
    expect(rows.map((r) => r.blockId)).toEqual(['early', 'late']);
  });

  it('says when a placed block runs and for how long', () => {
    const [row] = buildTodayRows([block('a', { durationMin: 45 })], [placed('a', 600, 645)], []);
    expect(row.timeText).toBe('10:00 AM · 45 min');
  });

  it('uses the commitment\'s time when there is one, since that is what the reminder will use', () => {
    const [row] = buildTodayRows([block('a')], [placed('a', 600)], [commitment('a', 'planned', 615)]);
    expect(row.timeText).toBe('10:15 AM · 30 min');
  });

  it('names a block with no title after its type', () => {
    const [row] = buildTodayRows([block('a', { title: '  ', blockType: 'recharge', urgency: null })], [placed('a', 600)], []);
    expect(row.title).toBe('Recharge');
  });

  it('shows where each block stands, in words', () => {
    const cases: Array<[string, string, string]> = [
      ['planned', 'Planned', 'muted'],
      ['nagging', 'Waiting for you', 'waiting'],
      ['started', 'In progress', 'live'],
      ['finished', 'Done', 'done'],
      ['lapsed', 'Lapsed', 'warn'],
      ['missed', 'Missed', 'warn'],
    ];
    for (const [status, text, tone] of cases) {
      const [row] = buildTodayRows([block('a')], [placed('a', 600)], [commitment('a', status, 600)]);
      expect([status, row.statusText, row.tone]).toEqual([status, text, tone]);
    }
  });

  it('explains a block that has no time today', () => {
    const cases: Array<[BlockPlacement['kind'], string]> = [
      ['overflow', 'Rolls to tomorrow'],
      ['capped', "Over today's limit"],
      ['drop', 'Advised to drop'],
      ['unattached', 'Needs a place'],
      ['invalid', 'Needs attention'],
    ];
    for (const [kind, text] of cases) {
      const [row] = buildTodayRows([block('a')], [other('a', kind, 'because')], []);
      expect([kind, row.statusText]).toEqual([kind, text]);
      expect(row.timeText).toBe('30 min'); // no time, just the length
    }
  });

  it('puts blocks with no time after the ones that have one', () => {
    const rows = buildTodayRows(
      [block('waiting'), block('first'), block('second')],
      [other('waiting', 'unattached'), placed('second', 900), placed('first', 600)],
      [],
    );
    expect(rows.map((r) => r.blockId)).toEqual(['first', 'second', 'waiting']);
  });

  it('marks a block done once it is completed, even with no commitment', () => {
    const [row] = buildTodayRows([block('a', { isCompleted: true })], [placed('a', 600)], []);
    expect([row.statusText, row.tone, row.canEdit, row.canDrop]).toEqual(['Done', 'done', false, false]);
  });

  it('lets a block be edited and dropped while it is still open', () => {
    const [row] = buildTodayRows([block('a')], [placed('a', 600)], [commitment('a', 'nagging', 600)]);
    expect([row.canEdit, row.canDrop]).toEqual([true, true]);
  });

  it('does not let a block in progress be dropped, since Lapse is how that one ends', () => {
    const [row] = buildTodayRows([block('a')], [placed('a', 600)], [commitment('a', 'started', 600)]);
    expect([row.canEdit, row.canDrop]).toEqual([true, false]);
  });

  it('has nothing to edit on a recharge block', () => {
    const [row] = buildTodayRows([block('a', { blockType: 'recharge', urgency: null, title: '' })], [placed('a', 600)], []);
    expect([row.canEdit, row.canDrop]).toEqual([false, true]);
  });

  it('shows a block that has no placement at all rather than losing it', () => {
    const rows = buildTodayRows([block('a')], [], []);
    expect(rows).toHaveLength(1);
    expect(rows[0].statusText).toBe('Needs attention');
  });
});

describe('buildTodayRows: recharge breaks', () => {
  const rest = { afterBlockId: 'a', cueId: 'cue1', startMin: 645, endMin: 654 };

  it('shows a break in time order between the blocks it separates, named Recharge', () => {
    const rows = buildTodayRows(
      [block('a', { durationMin: 45 }), block('b')],
      [placed('a', 600, 645), placed('b', 654)],
      [],
      [rest],
    );
    expect(rows.map((r) => r.blockId)).toEqual(['a', 'break:a', 'b']);
    expect(rows[1]).toMatchObject({ title: 'Recharge', timeText: '10:45 AM · 9 min' });
  });

  it('says a break is rest and not free time', () => {
    const [, row] = buildTodayRows([block('a'), block('b')], [placed('a', 600), placed('b', 654)], [], [rest]);
    expect(row.statusText).toMatch(/not free time/i);
  });

  it('gives a break no Edit or Drop, because it is not a block the user manages', () => {
    const [, row] = buildTodayRows([block('a'), block('b')], [placed('a', 600), placed('b', 654)], [], [rest]);
    expect(row).toMatchObject({ canEdit: false, canDrop: false });
  });

  it('adds nothing when there are no breaks', () => {
    const rows = buildTodayRows([block('a')], [placed('a', 600)], []);
    expect(rows).toHaveLength(1);
  });
});

describe('buildTodayRows: lengths the plan changed', () => {
  it('shows the length the plan gave a block, so a shortened block says so', () => {
    const [row] = buildTodayRows([block('a', { durationMin: 130 })], [placed('a', 480, 591)], []);
    expect(row.timeText).toBe('8:00 AM · 111 min');
  });

  it('shows the length saved for a block that already has a reminder', () => {
    const [row] = buildTodayRows([block('a', { durationMin: 130 })], [placed('a', 480, 591)], [commitment('a', 'planned', 480)]);
    expect(row.timeText).toBe('8:00 AM · 30 min'); // the saved reminder is what the phone will say
  });

  it('keeps the length that was entered for a block that is running, which may be running over', () => {
    const [row] = buildTodayRows([block('a', { durationMin: 60, committed: true })], [placed('a', 480, 630)], []);
    expect(row.timeText).toBe('8:00 AM · 60 min');
  });
});

describe('buildTodayRows: telling the user what each cue leads to', () => {
  const morning = { id: 'cue1', label: 'Morning', timeMin: 480 };
  const lunch = { id: 'cue2', label: 'Lunch', timeMin: 720 };
  const plan = (id: string, cueId: string, startMin: number): BlockPlacement => ({
    blockId: id,
    kind: 'placed',
    cueId,
    startMin,
    endMin: startMin + 30,
    reason: '',
  });

  it('puts a cue ahead of its first block and says what comes next', () => {
    const rows = buildTodayRows([block('a', { title: 'Write report' })], [plan('a', 'cue1', 480)], [], [], [morning]);
    expect(rows.map((r) => r.blockId)).toEqual(['cue:cue1', 'a']);
    expect(rows[0]).toMatchObject({ title: 'Morning', timeText: '8:00 AM', statusText: 'Then: Write report', canEdit: false, canDrop: false });
  });

  it('names only the first block of the cue', () => {
    const rows = buildTodayRows(
      [block('a', { title: 'First' }), block('b', { title: 'Second' })],
      [plan('a', 'cue1', 480), plan('b', 'cue1', 520)],
      [],
      [],
      [morning],
    );
    expect(rows[0].statusText).toBe('Then: First');
  });

  it('says when the first block starts if that is not at the cue', () => {
    const rows = buildTodayRows([block('a', { title: 'Write report' })], [plan('a', 'cue1', 510)], [], [], [morning]);
    expect(rows[0].statusText).toBe('Then: Write report at 8:30 AM');
  });

  it('shows each cue with its own block, in time order', () => {
    const rows = buildTodayRows(
      [block('a', { title: 'Write report' }), block('b', { title: 'Call back' })],
      [plan('b', 'cue2', 720), plan('a', 'cue1', 480)],
      [],
      [],
      [lunch, morning],
    );
    expect(rows.map((r) => r.blockId)).toEqual(['cue:cue1', 'a', 'cue:cue2', 'b']);
  });

  it('leaves out a cue that nothing follows, and blocks that have no place', () => {
    const rows = buildTodayRows([block('a'), block('w')], [plan('a', 'cue1', 480), other('w', 'unattached')], [], [], [morning, lunch]);
    expect(rows.map((r) => r.blockId)).toEqual(['cue:cue1', 'a', 'w']);
  });

  it('adds nothing when it is not given any cues', () => {
    expect(buildTodayRows([block('a')], [plan('a', 'cue1', 480)], [])).toHaveLength(1);
  });
});
