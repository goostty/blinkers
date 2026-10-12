import { describe, expect, it } from 'vitest';
import { assignBlocks, describeMoment, suggestionText, type Assignment, type BlockRequest } from '../scheduler';
import type { Cue, Weekday } from '../cues';
import type { UserProfile } from '../energy';

// Neutral curve reference: 10h=5, 13h=3, 14h=2, 15h=2, 19h=4.
const profile: UserProfile = { chronotype: 'neutral' };
const MON: Weekday = 1;

const cue = (id: string, label: string, hour: number, over: Partial<Cue> = {}): Cue => ({
  id,
  label,
  timeMin: hour * 60,
  days: [1, 2, 3, 4, 5],
  flexMin: 0,
  ...over,
});
const peak = cue('peak', 'Morning', 10); // energy 5
const dip = cue('dip', 'After school', 15); // energy 2
const eve = cue('eve', 'After dinner', 19); // energy 4

const block = (id: string, type: BlockRequest['type'], orderIndex = 0): BlockRequest => ({ id, type, orderIndex });
const cueOf = (out: ReturnType<typeof assignBlocks>, id: string) => out.find((a) => a.blockId === id)?.cueId;

describe('assignBlocks: energy matching', () => {
  it('gives deep work the peak cue even when a lighter block is listed first', () => {
    const out = assignBlocks([block('r', 'routine', 0), block('d', 'deep', 1)], [peak, dip, eve], profile, MON);
    expect(cueOf(out, 'd')).toBe('peak');
  });

  it('puts recharge in the lowest-energy cue', () => {
    const out = assignBlocks([block('c', 'recharge')], [peak, dip, eve], profile, MON);
    expect(cueOf(out, 'c')).toBe('dip');
  });

  it('prefers a cue that is not underpowered when two are equally far from the target', () => {
    // routine wants 3: dip (2) and eve (4) are both 1 away; eve is not underpowered.
    const out = assignBlocks([block('r', 'routine')], [dip, eve], profile, MON);
    expect(cueOf(out, 'r')).toBe('eve');
  });

  it('breaks a full tie by the earlier cue', () => {
    const a = cue('a', 'A', 10);
    const b = cue('b', 'B', 11); // also energy 5
    expect(cueOf(assignBlocks([block('d', 'deep')], [b, a], profile, MON), 'd')).toBe('a');
  });

  it('lets orderIndex decide between blocks of the same type', () => {
    const early = cue('early', 'Early', 10); // 5
    const late = cue('late', 'Late', 13); // 3
    const out = assignBlocks([block('second', 'deep', 1), block('first', 'deep', 0)], [late, early], profile, MON);
    expect(cueOf(out, 'first')).toBe('early');
    expect(cueOf(out, 'second')).toBe('late');
  });

  it('judges a drifty cue by its whole drift range, not just its time', () => {
    // 14:00 +/- 60 spans 13:00-15:00: hours 13 (3) and 14 (2) average 2.5.
    const drifty = cue('d', 'Drifty', 14, { flexMin: 60 });
    const out = assignBlocks([block('r', 'routine')], [drifty], profile, MON);
    expect(out[0].reason).toContain('2.5');
  });
});

describe('assignBlocks: one block per cue', () => {
  it('leaves the block that loses out unscheduled with a reason', () => {
    const out = assignBlocks(
      [block('d', 'deep'), block('r', 'routine'), block('s', 'reset'), block('c', 'recharge')],
      [peak, dip, eve],
      profile,
      MON,
    );
    expect(cueOf(out, 'd')).toBe('peak');
    expect(cueOf(out, 'c')).toBeNull();
    const lost = out.find((a) => a.blockId === 'c')!;
    expect(lost.startMin).toBeNull();
    expect(lost.reason).toMatch(/already has a block/i);
  });

  it('does not put two blocks in the same cue', () => {
    const out = assignBlocks([block('a', 'routine', 0), block('b', 'routine', 1)], [peak], profile, MON);
    expect(out[0].cueId).toBe('peak');
    expect(out[1].cueId).toBeNull();
  });

  it('starts the block at the cue time', () => {
    expect(assignBlocks([block('d', 'deep')], [peak], profile, MON)[0].startMin).toBe(600);
  });

  it('ignores cues that do not run on the given day', () => {
    const out = assignBlocks([block('d', 'deep')], [peak], profile, 6);
    expect(out[0].cueId).toBeNull();
    expect(out[0].reason).toMatch(/no cues on this day/i);
  });
});

describe('assignBlocks: output', () => {
  it('returns assignments in the same order as the input blocks', () => {
    const out = assignBlocks([block('r', 'routine', 0), block('d', 'deep', 1)], [peak, eve], profile, MON);
    expect(out.map((a) => a.blockId)).toEqual(['r', 'd']);
  });

  it('explains the choice with the cue name and time', () => {
    const out = assignBlocks([block('d', 'deep')], [peak], profile, MON);
    expect(out[0].reason).toContain('Morning');
    expect(out[0].reason).toContain('10:00 AM');
  });

  it('does not mutate its inputs', () => {
    const blocks = [block('r', 'routine', 0), block('d', 'deep', 1)];
    const cues = [peak, dip];
    const snapshot = JSON.stringify([blocks, cues]);
    assignBlocks(blocks, cues, profile, MON);
    expect(JSON.stringify([blocks, cues])).toBe(snapshot);
  });
});

describe('assignBlocks: time of day (nowMin)', () => {
  it('does not use a cue whose time has passed', () => {
    const out = assignBlocks([block('d', 'deep')], [peak], profile, MON, 10 * 60 + 1);
    expect(out[0].cueId).toBeNull();
    expect(out[0].reason).toMatch(/no cues left/i);
  });

  it('still says "no cues on this day" when none run that day at all', () => {
    const out = assignBlocks([block('d', 'deep')], [peak], profile, 6, 11 * 60);
    expect(out[0].reason).toMatch(/no cues on this day/i);
  });

  it('keeps a cue usable while now is still inside its drift range, and starts the block now', () => {
    const drifty = cue('d', 'Drifty', 10, { flexMin: 15 });
    const out = assignBlocks([block('d', 'deep')], [drifty], profile, MON, 10 * 60 + 10);
    expect(out[0].cueId).toBe('d');
    expect(out[0].startMin).toBe(10 * 60 + 10);
  });

  it('includes the very last minute of the drift range, and drops the cue after it', () => {
    const drifty = cue('d', 'Drifty', 10, { flexMin: 15 });
    expect(assignBlocks([block('d', 'deep')], [drifty], profile, MON, 10 * 60 + 15)[0].cueId).toBe('d');
    expect(assignBlocks([block('d', 'deep')], [drifty], profile, MON, 10 * 60 + 16)[0].cueId).toBeNull();
  });

  it('keeps a cue that has not started yet exactly at its time', () => {
    const out = assignBlocks([block('d', 'deep')], [peak], profile, MON, 9 * 60);
    expect(out[0].startMin).toBe(600);
  });
});

describe('describeMoment', () => {
  it('reads the local date, weekday and minute of day', () => {
    // Monday 12 Oct 2026, 3:30 PM local time
    expect(describeMoment(new Date(2026, 9, 12, 15, 30))).toEqual({ isoDate: '2026-10-12', weekday: 1, nowMin: 930 });
  });

  it('zero-pads the month and day', () => {
    expect(describeMoment(new Date(2026, 0, 5, 0, 0))).toEqual({ isoDate: '2026-01-05', weekday: 1, nowMin: 0 });
  });

  it('numbers Sunday as 0 and Saturday as 6', () => {
    expect(describeMoment(new Date(2026, 9, 11, 12, 0)).weekday).toBe(0);
    expect(describeMoment(new Date(2026, 9, 17, 12, 0)).weekday).toBe(6);
  });
});

describe('suggestionText', () => {
  const cues = [peak];

  it('names the start time and the cue for a scheduled block', () => {
    const a: Assignment = { blockId: 'd', cueId: 'peak', startMin: 600, reason: '' };
    expect(suggestionText(a, cues)).toBe('10:00 AM · Morning');
  });

  it('says unscheduled when there is no slot', () => {
    const a: Assignment = { blockId: 'd', cueId: null, startMin: null, reason: 'No cues left today.' };
    expect(suggestionText(a, cues)).toBe('Unscheduled');
  });

  it('falls back to the time alone if the cue is no longer in the list', () => {
    const a: Assignment = { blockId: 'd', cueId: 'gone', startMin: 600, reason: '' };
    expect(suggestionText(a, cues)).toBe('10:00 AM');
  });
});
