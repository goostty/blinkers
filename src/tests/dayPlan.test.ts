import { describe, expect, it } from 'vitest';
import { placementText, planDay, type BlockPlacement, type DayBlock, type DayPlan } from '../dayPlan';
import { weekdayOf, type Cue, type Weekday } from '../cues';
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
    // a 45 minute work block earns a 9 minute break (525 to 534) before b
    expect(placement(p, 'b')).toMatchObject({ kind: 'placed', startMin: 534, endMin: 564 });
    expect(p.plan).toEqual([
      { blockId: 'a', cueId: 'morning', startMin: 480, durationMin: 45 },
      { blockId: 'b', cueId: 'morning', startMin: 534, durationMin: 30 },
    ]);
  });

  it('does not plan a block that would run past the end of the day, and says it moves to tomorrow', () => {
    // 08:00 + 23h is past 22:00, and even shortened by a third (to about 15h) it would not fit
    const p = planDay([block('long', afterCue('morning'), 1380)], [morning, bed], MON);
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
    // a ended at 510 and earned a 12 minute break, so b starts at 522
    expect(placement(p, 'b')).toMatchObject({ startMin: 522, endMin: 552 });
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
    // a ends at 780 and earns the longest break, 20 minutes, so c starts at 800
    expect(placement(p, 'c')).toMatchObject({ kind: 'placed', startMin: 800, endMin: 830 });
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
    expect(planDay([], [morning], MON)).toEqual({
      placements: [],
      plan: [],
      breaks: [],
      fit: { needsDecision: false, applied: null, recommended: null, shortenPercent: null, dropped: [] },
    });
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

describe('cues that belong to one date', () => {
  const WED_DATE = '2026-10-21';
  const WED: Weekday = 3;
  const once = (id: string, hour: number, date: string) => cue(id, hour, { days: [weekdayOf(date)], onDate: date });

  it('places a block after a cue made for today', () => {
    const plan = planDay([block('b', afterCue('midday'))], [once('midday', 13, WED_DATE)], WED, WED_DATE);
    expect(plan.plan).toEqual([{ blockId: 'b', cueId: 'midday', startMin: 780, durationMin: 30 }]);
  });

  it('does not run a cue made for another date, even on the same weekday', () => {
    const nextWeek = once('midday', 13, '2026-10-28');
    const plan = planDay([block('b', afterCue('midday'))], [nextWeek], WED, WED_DATE);
    expect(plan.plan).toEqual([]);
    expect(plan.placements[0].kind).not.toBe('placed');
  });

  it('does not run a dated cue when no date is given, rather than guessing', () => {
    const plan = planDay([block('b', afterCue('midday'))], [once('midday', 13, WED_DATE)], WED);
    expect(plan.plan).toEqual([]);
  });

  it('still runs weekly cues with or without a date', () => {
    const weekly = [cue('morning', 9)];
    expect(planDay([block('b', afterCue('morning'))], weekly, WED).plan).toHaveLength(1);
    expect(planDay([block('b', afterCue('morning'))], weekly, WED, WED_DATE).plan).toHaveLength(1);
  });

  it('treats a cue made for today as a fixed moment, so the chain before it must fit', () => {
    const cues = [cue('morning', 9), once('midday', 10, WED_DATE)];
    const plan = planDay([block('long', afterCue('morning'), 150)], cues, WED, WED_DATE);
    expect(plan.placements[0].kind).toBe('overflow'); // 9:00 + 150 min runs past the 10:00 cue, even shortened
  });
});

describe('planDay: recharge breaks', () => {
  it('leaves room for a break between two work blocks and reports it', () => {
    const p = planDay(
      [block('a', afterCue('morning'), 50), block('b', afterBlock('a'), 50)],
      [morning, bed],
      MON,
    );
    expect(p.breaks).toEqual([{ afterBlockId: 'a', cueId: 'morning', startMin: 530, endMin: 540 }]);
    expect(placement(p, 'b')).toMatchObject({ kind: 'placed', startMin: 540, endMin: 590 });
    expect(inPlan(p, 'b')).toMatchObject({ startMin: 540 });
  });

  it('has no breaks when there is only one block', () => {
    const p = planDay([block('a', afterCue('morning'), 50)], [morning, bed], MON);
    expect(p.breaks).toEqual([]);
  });

  it('closes the chain up around a rolled block, so the break is not left behind for it', () => {
    // b is rolled by the Q1 limit, so a and c are neighbours again and share a single break.
    const p = planDay(
      [
        block('a', afterCue('morning'), 300, { urgency: Q1, orderIndex: 0 }),
        block('b', afterBlock('a'), 200, { urgency: Q1, orderIndex: 1 }),
        block('c', afterBlock('b'), 30, { urgency: 'important', orderIndex: 2 }),
      ],
      [morning, bed],
      MON,
    );
    expect(placement(p, 'b').kind).toBe('capped');
    expect(p.breaks).toEqual([{ afterBlockId: 'a', cueId: 'morning', startMin: 780, endMin: 800 }]);
  });
});

describe('planDay: a day that does not fit', () => {
  const noon = cue('noon', 12);
  const tight = [morning, noon, bed]; // 08:00 to 12:00 is 240 minutes
  const full = () => [
    block('a', afterCue('morning'), 130, { urgency: Q3 }),
    block('b', afterBlock('a'), 130, { urgency: Q1 }),
  ]; // 260 minutes in 240

  it('recommends shortening, applies it for now, and says a decision is waiting', () => {
    const p = planDay(full(), tight, MON);
    // 130 + a 20 minute break + 130 is 280 minutes in 240, so everything, the break included,
    // has to come down 15%: 111 + 17 + 111 = 239
    expect(p.fit).toMatchObject({ needsDecision: true, applied: 'shorten', recommended: 'shorten', shortenPercent: 15 });
    expect(placement(p, 'a')).toMatchObject({ kind: 'placed', startMin: 480, endMin: 591 });
    expect(placement(p, 'b')).toMatchObject({ kind: 'placed', startMin: 608, endMin: 719 });
    expect(inPlan(p, 'a')!.durationMin).toBe(111); // saved at the shortened length
  });

  it('says how much shorter a block was made', () => {
    const p = planDay(full(), tight, MON);
    expect(placement(p, 'a').reason).toMatch(/111 min/);
  });

  it('drops the lowest priority block when the user chose to drop, and asks no more', () => {
    const p = planDay(full(), tight, MON, undefined, { fit: 'drop' });
    expect(p.fit).toMatchObject({ needsDecision: false, applied: 'drop' });
    expect(placement(p, 'a').kind).toBe('overflow');
    expect(placement(p, 'a').reason).toMatch(/tomorrow/i);
    expect(placement(p, 'a').reason).toMatch(/room/i); // it fitted itself, it was dropped for b
    expect(placement(p, 'b')).toMatchObject({ kind: 'placed', startMin: 480, endMin: 610 });
    expect(inPlan(p, 'a')).toBeUndefined();
  });

  it('says why a block that is itself too long moves to tomorrow', () => {
    const p = planDay([block('long', afterCue('morning'), 900)], tight, MON);
    expect(placement(p, 'long').kind).toBe('overflow');
    expect(placement(p, 'long').reason).toMatch(/does not fit/i);
  });

  it('asks no more once the user chose to shorten', () => {
    const p = planDay(full(), tight, MON, undefined, { fit: 'shorten' });
    expect(p.fit).toMatchObject({ needsDecision: false, applied: 'shorten' });
  });

  it('asks again when a chosen shortening is no longer enough', () => {
    const p = planDay(
      [block('a', afterCue('morning'), 200, { urgency: Q3 }), block('b', afterBlock('a'), 200, { urgency: Q1 })],
      tight,
      MON,
      undefined,
      { fit: 'shorten' },
    ); // 400 minutes in 240 needs far more than shortening can give
    expect(p.fit).toMatchObject({ needsDecision: true, applied: 'drop', recommended: 'drop', shortenPercent: null });
  });

  it('keeps the old behaviour when adjusting is switched off, so a suggestion never reshapes the day', () => {
    const p = planDay(full(), tight, MON, undefined, { fit: 'off' });
    expect(placement(p, 'b').kind).toBe('overflow');
    expect(p.fit.needsDecision).toBe(false);
  });

  it('has nothing to decide when the day fits', () => {
    const p = planDay([block('a', afterCue('morning'), 60)], tight, MON);
    expect(p.fit).toEqual({ needsDecision: false, applied: null, recommended: null, shortenPercent: null, dropped: [] });
  });

  it('never drops a block the user has started', () => {
    const p = planDay(
      [
        block('a', afterCue('morning'), 130, { urgency: Q3, committed: true, startedAtMin: 480 }),
        block('b', afterBlock('a'), 130, { urgency: Q1 }),
      ],
      tight,
      MON,
      undefined,
      { fit: 'drop', nowMin: 490 },
    );
    expect(placement(p, 'a').kind).toBe('placed');
    expect(placement(p, 'b').kind).toBe('overflow');
  });
});

describe('planDay: following the clock', () => {
  const noon = cue('noon', 12);
  const tight = [morning, noon, bed];

  it('lets a running block that is past its end push the blocks behind it', () => {
    const p = planDay(
      [block('a', afterCue('morning'), 60, { committed: true, startedAtMin: 480 }), block('b', afterBlock('a'), 30)],
      tight,
      MON,
      undefined,
      { nowMin: 600 }, // 10:00, and a has been running for two hours
    );
    // a ends at 10:00 (now) and, being deep work, earns a 12 minute break before b
    expect(placement(p, 'b')).toMatchObject({ kind: 'placed', startMin: 612 });
  });

  it('never starts a block that has not started before the "not before" time', () => {
    const p = planDay([block('a', afterCue('morning'), 60), block('b', afterBlock('a'), 30)], tight, MON, undefined, { notBeforeMin: 540 });
    expect(placement(p, 'a')).toMatchObject({ startMin: 540, endMin: 600 });
    expect(placement(p, 'b').startMin).toBe(612); // after a 12 minute break
  });
});
