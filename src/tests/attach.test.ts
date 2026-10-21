import { describe, expect, it } from 'vitest';
import { attachOptions, parseAttach, resolveAttach, resolveDuration } from '../attach';
import { planDay, type DayBlock } from '../dayPlan';
import { weekdayOf, type Cue, type Weekday } from '../cues';

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

const block = (id: string, parent: { kind: 'cue' | 'block'; id: string } | null, over: Partial<DayBlock> = {}): DayBlock => ({
  id,
  blockType: 'deep',
  orderIndex: 0,
  title: id,
  urgency: 'important',
  createdOn: '2026-10-12',
  durationMin: 30,
  parentKind: parent?.kind ?? null,
  parentId: parent?.id ?? null,
  isCompleted: false,
  endedAtMin: null,
  committed: false,
  ...over,
});

describe('attachOptions', () => {
  const morning = cue('morning', 8);
  const evening = cue('evening', 18);

  it('lists each cue, each followed by the blocks already in its chain', () => {
    const blocks = [
      block('a', { kind: 'cue', id: 'morning' }),
      block('b', { kind: 'block', id: 'a' }, { durationMin: 45 }),
      block('c', { kind: 'cue', id: 'evening' }),
    ];
    const opts = attachOptions([evening, morning], blocks, planDay(blocks, [evening, morning], MON), MON);
    expect(opts.map((o) => o.value)).toEqual(['cue:morning', 'block:a', 'block:b', 'cue:evening', 'block:c']);
  });

  it('says when a cue starts and when a block ends', () => {
    const blocks = [block('a', { kind: 'cue', id: 'morning' })];
    const opts = attachOptions([morning], blocks, planDay(blocks, [morning], MON), MON);
    expect(opts[0].label).toContain('Morning');
    expect(opts[0].label).toContain('8:00 AM');
    expect(opts[1].label).toContain('a');
    expect(opts[1].label).toContain('8:30 AM'); // a runs 8:00-8:30
  });

  it('leaves out end-of-day cues and cues that do not run today', () => {
    const bed = cue('bed', 22, { endsDay: true });
    const tue = cue('tue', 9, { days: [2] });
    const opts = attachOptions([morning, bed, tue], [], planDay([], [morning, bed, tue], MON), MON);
    expect(opts.map((o) => o.value)).toEqual(['cue:morning']);
  });

  it('leaves out blocks that have no place today, since nothing can follow them', () => {
    const blocks = [
      block('placed', { kind: 'cue', id: 'morning' }),
      block('lost', null),
      block('q4', null, { urgency: 'neither' }),
      block('long', { kind: 'block', id: 'placed' }, { durationMin: 2000 }),
    ];
    const opts = attachOptions([morning], blocks, planDay(blocks, [morning], MON), MON);
    expect(opts.map((o) => o.value)).toEqual(['cue:morning', 'block:placed']);
  });

  it('names an untitled block after its type', () => {
    const blocks = [block('r', { kind: 'cue', id: 'morning' }, { title: '', blockType: 'recharge', urgency: null })];
    const opts = attachOptions([morning], blocks, planDay(blocks, [morning], MON), MON);
    expect(opts[1].label).toContain('Recharge');
  });

  it('offers nothing when there are no cues', () => {
    expect(attachOptions([], [], planDay([], [], MON), MON)).toEqual([]);
  });
});

describe('parseAttach', () => {
  it('reads a cue or a block choice', () => {
    expect(parseAttach('cue:abc')).toEqual({ kind: 'cue', id: 'abc' });
    expect(parseAttach('block:x-1')).toEqual({ kind: 'block', id: 'x-1' });
  });

  it('keeps ids that contain a colon whole', () => {
    expect(parseAttach('block:a:b')).toEqual({ kind: 'block', id: 'a:b' });
  });

  it.each(['', 'cue', 'cue:', 'moon:abc', ':abc'])('rejects %j', (value) => {
    expect(parseAttach(value)).toBeNull();
  });
});

describe('resolveAttach', () => {
  it('makes the user say what a block follows', () => {
    const r = resolveAttach('important', '');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/follows/i);
  });

  it('accepts a valid choice', () => {
    expect(resolveAttach('urgent-important', 'cue:abc')).toEqual({ ok: true, value: { kind: 'cue', id: 'abc' } });
    expect(resolveAttach(null, 'block:x')).toEqual({ ok: true, value: { kind: 'block', id: 'x' } });
  });

  it('refuses a choice that is not a cue or a block', () => {
    expect(resolveAttach('important', 'moon:x').ok).toBe(false);
  });

  it('needs nothing for a block advised to drop, even if something was picked before switching', () => {
    expect(resolveAttach('neither', '')).toEqual({ ok: true, value: null });
    expect(resolveAttach('neither', 'cue:abc')).toEqual({ ok: true, value: null });
  });

  describe('when the app places blocks itself', () => {
    it('lets a block be made with no place, because the app will place it', () => {
      expect(resolveAttach('important', '', true)).toEqual({ ok: true, value: null });
      expect(resolveAttach(null, '', true)).toEqual({ ok: true, value: null });
    });

    it('still honours a place the user picked', () => {
      expect(resolveAttach('important', 'cue:abc', true)).toEqual({ ok: true, value: { kind: 'cue', id: 'abc' } });
    });

    it('still refuses a choice that is not a cue or a block', () => {
      expect(resolveAttach('important', 'moon:x', true).ok).toBe(false);
    });
  });
});

describe('resolveDuration', () => {
  it.each([
    ['30', 30],
    [' 45 ', 45],
    ['1', 1],
    ['1440', 1440],
  ])('accepts %j', (text, minutes) => {
    expect(resolveDuration(text)).toEqual({ ok: true, value: minutes });
  });

  it.each(['', '  ', '0', '-5', '1441', '2.5', '1e2', 'abc', '30 min', '+30'])('rejects %j', (text) => {
    expect(resolveDuration(text).ok).toBe(false);
  });
});

describe('attachOptions with cues that belong to one date', () => {
  const WED_DATE = '2026-10-21';
  const WED: Weekday = 3;
  const once = (id: string, hour: number, date: string) => cue(id, hour, { days: [weekdayOf(date)], onDate: date });
  const labels = (cues: Cue[], date?: string) => {
    const plan = planDay([], cues, WED, date);
    return attachOptions(cues, [], plan, WED, date).map((o) => o.label);
  };

  it('offers a cue made for today', () => {
    expect(labels([once('midday', 13, WED_DATE)], WED_DATE)).toEqual(['After Midday · 1:00 PM']);
  });

  it('leaves out a cue made for another date, even on the same weekday', () => {
    expect(labels([once('midday', 13, '2026-10-28')], WED_DATE)).toEqual([]);
  });

  it('leaves out dated cues when no date is given, and keeps the weekly ones', () => {
    expect(labels([cue('morning', 9), once('midday', 13, WED_DATE)])).toEqual(['After Morning · 9:00 AM']);
  });

  it('lists today\'s cues in time order, weekly and dated together', () => {
    expect(labels([once('midday', 13, WED_DATE), cue('morning', 9), cue('evening', 18)], WED_DATE)).toEqual([
      'After Morning · 9:00 AM',
      'After Midday · 1:00 PM',
      'After Evening · 6:00 PM',
    ]);
  });
});
