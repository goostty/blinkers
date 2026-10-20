import { describe, expect, it } from 'vitest';
import { placementText, planDay, type BlockPlacement, type DayBlock, type DayPlan } from '../dayPlan';
import type { Cue, Weekday } from '../cues';
import type { Urgency } from '../scheduler';

const MON: Weekday = 1;

const cue = (id: string, hour: number, over: Partial<Cue> = {}): Cue => ({
  id,
  label: id[0].toUpperCase() + id.slice(1),
  timeMin: hour * 60,
  days: [0, 1, 2, 3, 4, 5, 6],
  flexMin: 0,
  endsDay: false,
  ...over,
});

const block = (
  id: string,
  parent: { kind: 'cue' | 'block'; id: string } | null,
  durationMin = 30,
  over: Partial<DayBlock> = {},
): DayBlock => ({
  id,
  blockType: 'deep',
  orderIndex: 0,
  title: id,
  urgency: 'important',
  createdOn: '2026-10-12',
  durationMin,
  parentKind: parent?.kind ?? null,
  parentId: parent?.id ?? null,
  isCompleted: false,
  endedAtMin: null,
  committed: false,
  ...over,
});

const afterCue = (id: string) => ({ kind: 'cue' as const, id });
const afterBlock = (id: string) => ({ kind: 'block' as const, id });
const placement = (p: DayPlan, id: string) => p.placements.find((x) => x.blockId === id)!;
const inPlan = (p: DayPlan, id: string) => p.plan.find((x) => x.blockId === id);

const Q1: Urgency = 'urgent-important';
const Q3: Urgency = 'urgent';

const morning = cue('morning', 8); // 08:00
const bed = cue('bed', 22, { endsDay: true }); // 22:00, ends the day

describe('planDay: placing blocks in their chains', () => {
  it('lays a chain out after its cue and plans every block that fits', () => {
    const p = planDay(
      [block('a', afterCue('morning'), 45), block('b', afterBlock('a'), 30)],
      [morning, bed],
      MON,
    );
    expect(placement(p, 'a')).toMatchObject({ kind: 'placed', cueId: 'morning', startMin: 480, endMin: 525 });
    expect(placement(p, 'b')).toMatchObject({ kind: 'placed', startMin: 525, endMin: 555 });
    expect(p.plan).toEqual([
      { blockId: 'a', cueId: 'morning', startMin: 480, durationMin: 45 },
      { blockId: 'b', cueId: 'morning', startMin: 525, durationMin: 30 },
    ]);
  });

  it('does not plan a block that would run past the end of the day, and says it moves to tomorrow', () => {
    const p = planDay([block('long', afterCue('morning'), 900)], [morning, bed], MON); // 08:00 + 15h > 22:00
    expect(placement(p, 'long').kind).toBe('overflow');
    expect(placement(p, 'long').reason).toMatch(/tomorrow/i);
    expect(inPlan(p, 'long')).toBeUndefined();
  });

  it('reports a block with nothing to follow', () => {
    const p = planDay([block('a', null)], [morning], MON);
    expect(placement(p, 'a').kind).toBe('unattached');
    expect(placement(p, 'a').reason).toMatch(/follows/i);
    expect(p.plan).toEqual([]);
  });

  it('reports a block attached to a cue that does not run today', () => {
    const tueOnly = cue('tue', 9, { days: [2] });
    const p = planDay([block('a', afterCue('tue'))], [morning, tueOnly], MON);
    expect(placement(p, 'a').kind).toBe('invalid');
    expect(placement(p, 'a').reason).toMatch(/cue/i);
  });

  it('pulls the blocks after an early finish forward', () => {
    const p = planDay(
      [
        block('a', afterCue('morning'), 60, { isCompleted: true, committed: true, endedAtMin: 510 }),
        block('b', afterBlock('a'), 30),
      ],
      [morning, bed],
      MON,
    );
    expect(placement(p, 'b')).toMatchObject({ startMin: 510, endMin: 540 });
  });

  it('keeps a finished block in the plan as placed', () => {
    const p = planDay([block('a', afterCue('morning'), 30, { isCompleted: true, committed: true, endedAtMin: 500 })], [morning], MON);
    expect(placement(p, 'a').kind).toBe('placed');
  });

  it('lets the last cue run to midnight when no end-of-day cue is declared', () => {
    const p = planDay([block('a', afterCue('morning'), 960)], [morning], MON); // 08:00 + 16h = 24:00
    expect(placement(p, 'a').kind).toBe('placed');
  });
});

describe('planDay: blocks advised to drop', () => {
  it('never places a Q4 block and tells the user to drop it', () => {
    const p = planDay([block('q4', null, 30, { urgency: 'neither' })], [morning], MON);
    expect(placement(p, 'q4').kind).toBe('drop');
    expect(placement(p, 'q4').reason).toMatch(/drop/i);
    expect(p.plan).toEqual([]);
  });
});

describe('planDay: the daily limits', () => {
  // morning 08:00 -> bed 22:00 is 840 minutes: Q1 may use 420 of them.
  it('rolls Q1 blocks past half the day to tomorrow', () => {
    const p = planDay(
      [
        block('a', afterCue('morning'), 300, { urgency: Q1, orderIndex: 0 }),
        block('b', afterBlock('a'), 200, { urgency: Q1, orderIndex: 1 }),
      ],
      [morning, bed],
      MON,
    );
    expect(placement(p, 'a').kind).toBe('placed');
    expect(placement(p, 'b').kind).toBe('capped');
    expect(placement(p, 'b').reason).toMatch(/urgent and important/i);
    expect(placement(p, 'b').reason).toMatch(/tomorrow/i);
    expect(inPlan(p, 'b')).toBeUndefined();
  });

  it('closes the gap a rolled block leaves, pulling the blocks after it forward', () => {
    const p = planDay(
      [
        block('a', afterCue('morning'), 300, { urgency: Q1, orderIndex: 0 }),
        block('b', afterBlock('a'), 200, { urgency: Q1, orderIndex: 1 }),
        block('c', afterBlock('b'), 30, { urgency: 'important', orderIndex: 2 }),
      ],
      [morning, bed],
      MON,
    );
    expect(placement(p, 'c')).toMatchObject({ kind: 'placed', startMin: 480 + 300, endMin: 480 + 330 });
  });

  it('never rolls a Q1 block the user has already started', () => {
    const p = planDay([block('a', afterCue('morning'), 700, { urgency: Q1, committed: true })], [morning, bed], MON);
    expect(placement(p, 'a').kind).toBe('placed');
  });

  it('rolls Q3 work that would eat the time held for Q2, with a reason that says so', () => {
    // 840 min day, Q2 waiting 400 -> reserve 210 -> Q1 + Q3 may use 630
    const p = planDay(
      [
        block('q2', afterCue('morning'), 400, { urgency: 'important', orderIndex: 0 }),
        block('q3', afterBlock('q2'), 700, { urgency: Q3, orderIndex: 1 }),
      ],
      [morning, bed],
      MON,
    );
    expect(placement(p, 'q3').kind).toBe('capped');
    expect(placement(p, 'q3').reason).toMatch(/important/i);
  });

  it('leaves rest blocks and older blocks without an urgency alone', () => {
    const p = planDay(
      [block('rest', afterCue('morning'), 60, { blockType: 'recharge', urgency: null }), block('old', afterBlock('rest'), 60, { urgency: null })],
      [morning, bed],
      MON,
    );
    expect(p.placements.map((x) => x.kind)).toEqual(['placed', 'placed']);
  });
});

describe('planDay: purity and edge cases', () => {
  it('plans nothing for an empty day', () => {
    expect(planDay([], [morning], MON)).toEqual({ placements: [], plan: [] });
  });

  it('gives every block exactly one placement', () => {
    const blocks = [block('a', afterCue('morning')), block('b', null), block('c', null, 30, { urgency: 'neither' })];
    const p = planDay(blocks, [morning], MON);
    expect(p.placements.map((x) => x.blockId).sort()).toEqual(['a', 'b', 'c']);
  });

  it('does not change its inputs', () => {
    const blocks = [block('b', afterBlock('a')), block('a', afterCue('morning'))];
    const cues = [bed, morning];
    const snapshot = JSON.stringify([blocks, cues]);
    planDay(blocks, cues, MON);
    expect(JSON.stringify([blocks, cues])).toBe(snapshot);
  });
});

describe('placementText', () => {
  const cues = [morning];
  const base: BlockPlacement = { blockId: 'a', kind: 'placed', cueId: 'morning', startMin: 480, endMin: 525, reason: '' };

  it('names the start time and the cue for a placed block', () => {
    expect(placementText(base, cues)).toBe('8:00 AM · Morning');
  });

  it('falls back to the time alone if the cue is no longer in the list', () => {
    expect(placementText({ ...base, cueId: 'gone' }, cues)).toBe('8:00 AM');
  });

  it('says what happens to a block that has no place today', () => {
    const none = { ...base, cueId: null, startMin: null, endMin: null };
    expect(placementText({ ...none, kind: 'overflow' }, cues)).toBe('Moves to tomorrow');
    expect(placementText({ ...none, kind: 'capped' }, cues)).toBe('Moves to tomorrow');
    expect(placementText({ ...none, kind: 'drop' }, cues)).toBe('Consider dropping');
    expect(placementText({ ...none, kind: 'unattached' }, cues)).toBe('Needs a place today');
    expect(placementText({ ...none, kind: 'invalid' }, cues)).toBe('Needs attention');
  });
});
