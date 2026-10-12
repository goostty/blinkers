import { describe, expect, it } from 'vitest';
import {
  cueSpan,
  cuesOverlap,
  formatClock,
  formatDays,
  parseClock,
  parseCue,
  toClockValue,
  type Cue,
  type CueInput,
  type Weekday,
} from '../cues';

const input = (over: Partial<CueInput> = {}): CueInput => ({
  label: 'After school',
  timeMin: 930, // 3:30 PM
  days: [1, 2, 3, 4, 5],
  flexMin: 0,
  ...over,
});
const cue = (over: Partial<Cue> = {}): Cue => ({ id: 'c1', ...input(), ...over });

describe('parseClock', () => {
  it.each([
    ['15:30', 930],
    ['00:00', 0],
    ['23:59', 1439],
    ['7:05', 425],
  ])('parses %s', (text, min) => expect(parseClock(text)).toBe(min));

  it.each(['', 'abc', '24:00', '12:60', '12', '12:5', '-1:30'])('rejects %j', (text) =>
    expect(parseClock(text)).toBeNull(),
  );
});

describe('toClockValue', () => {
  it.each([
    [930, '15:30'],
    [0, '00:00'],
    [425, '07:05'],
    [1439, '23:59'],
  ])('writes %d as %s for a time input', (min, text) => expect(toClockValue(min)).toBe(text));

  it.each([0, 5, 425, 930, 1439])('round-trips %d through parseClock', (min) =>
    expect(parseClock(toClockValue(min))).toBe(min),
  );
});

describe('formatClock', () => {
  it.each([
    [930, '3:30 PM'],
    [0, '12:00 AM'],
    [720, '12:00 PM'],
    [1439, '11:59 PM'],
    [425, '7:05 AM'],
  ])('formats %d', (min, text) => expect(formatClock(min)).toBe(text));
});

describe('formatDays', () => {
  it.each([
    [[1, 2, 3, 4, 5], 'Weekdays'],
    [[0, 6], 'Weekends'],
    [[0, 1, 2, 3, 4, 5, 6], 'Every day'],
    [[1, 3, 5], 'Mon, Wed, Fri'],
    [[3], 'Wed'],
    [[5, 1], 'Mon, Fri'],
  ])('formats %j as %s', (days, text) => expect(formatDays(days as Weekday[])).toBe(text));
});

describe('cueSpan', () => {
  it('is a single minute for an exact cue', () => {
    expect(cueSpan(input())).toEqual({ startMin: 930, durationMin: 1 });
  });
  it('covers the whole drift range either side of the time', () => {
    expect(cueSpan(input({ flexMin: 10 }))).toEqual({ startMin: 920, durationMin: 20 });
  });
  it('can start before midnight for an early-morning cue', () => {
    expect(cueSpan(input({ timeMin: 5, flexMin: 10 }))).toEqual({ startMin: -5, durationMin: 20 });
  });
});

describe('parseCue', () => {
  it('normalizes label, days and default flex', () => {
    const r = parseCue(
      { ...input({ label: '  After school  ', days: [5, 1, 1, 3] }), flexMin: undefined } as unknown as CueInput,
      [],
    );
    expect(r).toEqual({ ok: true, value: input({ days: [1, 3, 5] }) });
  });

  it.each([
    ['empty label', { label: '   ' }],
    ['41-char label', { label: 'x'.repeat(41) }],
    ['time out of range', { timeMin: 1440 }],
    ['negative time', { timeMin: -1 }],
    ['fractional minute', { timeMin: 600.5 }],
    ['no days', { days: [] }],
    ['day 7', { days: [7] }],
    ['negative flex', { flexMin: -5 }],
    ['fractional flex', { flexMin: 2.5 }],
    ['flex above the 120 minute cap', { flexMin: 121 }],
  ])('rejects %s', (_name, over) => {
    expect(parseCue(input(over as Partial<CueInput>), []).ok).toBe(false);
  });

  it('accepts the maximum flex', () => {
    expect(parseCue(input({ flexMin: 120 }), []).ok).toBe(true);
  });

  it('accepts a late-night cue whose drift range crosses midnight', () => {
    expect(parseCue(input({ timeMin: 1430, flexMin: 30 }), []).ok).toBe(true);
  });

  it('rejects the same time on a shared day and names the clashing cue', () => {
    const r = parseCue(input({ label: 'Study' }), [cue()]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('After school');
  });

  it('rejects drift ranges that touch', () => {
    // 3:30 +/-10 reaches 3:40, which is exactly where the other cue sits.
    expect(parseCue(input({ label: 'Snack', timeMin: 940 }), [cue({ flexMin: 10 })]).ok).toBe(false);
  });

  it('allows cues whose drift ranges stay apart', () => {
    expect(parseCue(input({ label: 'Snack', timeMin: 941 }), [cue({ flexMin: 10 })]).ok).toBe(true);
  });

  it('allows the same time on different days', () => {
    expect(parseCue(input({ days: [0, 6] }), [cue()]).ok).toBe(true);
  });
});

describe('cuesOverlap', () => {
  const satLate = input({ timeMin: 1430, days: [6], flexMin: 10 }); // Sat 11:50 PM

  it('catches Saturday night against early Sunday morning', () => {
    // 15 minutes apart across midnight; 10 + 10 flex reaches that far.
    expect(cuesOverlap(satLate, input({ timeMin: 5, days: [0], flexMin: 10 }))).toBe(true);
  });
  it('is clear when the flex does not reach across midnight', () => {
    expect(cuesOverlap({ ...satLate, flexMin: 5 }, input({ timeMin: 5, days: [0], flexMin: 5 }))).toBe(false);
  });
  it('is symmetric', () => {
    const other = input({ timeMin: 5, days: [0], flexMin: 10 });
    expect(cuesOverlap(other, satLate)).toBe(true);
  });
});
