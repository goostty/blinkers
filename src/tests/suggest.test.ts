import { describe, expect, it } from 'vitest';
import type { Cue, Weekday } from '../cues';
import type { DayBlock } from '../dayPlan';
import { suggestSlot, type SuggestInput } from '../suggest';

const MON: Weekday = 1;
const DATE = '2026-10-19';
const profile = { chronotype: 'neutral' as const };

const cue = (id: string, hour: number, over: Partial<Cue> = {}): Cue => ({
  id,
  label: id[0].toUpperCase() + id.slice(1),
  timeMin: hour * 60,
  days: [0, 1, 2, 3, 4, 5, 6],
  flexMin: 0,
  endsDay: false,
  ...over,
});

const existing = (
  id: string,
  parent: { kind: 'cue' | 'block'; id: string },
  durationMin: number,
  over: Partial<DayBlock> = {},
): DayBlock => ({
  id,
  blockType: 'deep',
  orderIndex: 0,
  title: id,
  urgency: 'important',
  createdOn: DATE,
  durationMin,
  parentKind: parent.kind,
  parentId: parent.id,
  isCompleted: false,
  endedAtMin: null,
  committed: false,
  ...over,
});

const wake = cue('wake', 7);
const mid = cue('mid', 10);
const lunch = cue('lunch', 12);
const afternoon = cue('afternoon', 15);
const dinner = cue('dinner', 18);
const bed = cue('bed', 22, { endsDay: true });

const ask = (over: Omit<Partial<SuggestInput>, 'block'> & { block?: Partial<SuggestInput['block']> } = {}): ReturnType<typeof suggestSlot> => {
  const { block, ...rest } = over;
  return suggestSlot({
    block: { blockType: 'deep', urgency: 'urgent-important', durationMin: 60, title: 'Write', ...block },
    blocks: [],
    cues: [wake, lunch, dinner, bed],
    weekday: MON,
    isoDate: DATE,
    nowMin: 6 * 60,
    profile,
    ...rest,
  });
};

const slot = (s: ReturnType<typeof suggestSlot>) => {
  if (s.kind !== 'slot') throw new Error(`expected a slot, got ${s.kind}: ${s.reason}`);
  return s;
};

describe('suggestSlot: when and where', () => {
  it('puts an urgent and important block in the earliest slot', () => {
    const s = slot(ask());
    expect(s.parent).toEqual({ kind: 'cue', id: 'wake' });
    expect(s.startMin).toBe(7 * 60);
    expect(s.endMin).toBe(8 * 60);
  });

  it('never suggests a slot that starts before now', () => {
    const s = slot(ask({ nowMin: 13 * 60 })); // lunch (12:00) has already begun
    expect(s.parent).toEqual({ kind: 'cue', id: 'dinner' });
  });

  it('puts important work in the slot that matches the energy its type needs', () => {
    // deep work needs high energy; 10:00 to 11:00 is the sharpest hour of the day
    const s = slot(ask({ cues: [wake, mid, lunch, bed], block: { urgency: 'important' } }));
    expect(s.parent).toEqual({ kind: 'cue', id: 'mid' });
  });

  it('puts urgent but unimportant work in the lowest-energy slot, keeping the sharp hours free', () => {
    const s = slot(ask({ cues: [wake, mid, afternoon, bed], block: { urgency: 'urgent', durationMin: 30 } }));
    expect(s.parent).toEqual({ kind: 'cue', id: 'afternoon' });
  });

  it('breaks ties by taking the earlier slot', () => {
    // 10:00 and 11:00 are both energy 5 for a 30 minute block, so the earlier wins
    const s = slot(ask({ cues: [mid, cue('eleven', 11), bed], block: { urgency: 'important', durationMin: 30 } }));
    expect(s.parent).toEqual({ kind: 'cue', id: 'mid' });
  });
});

describe('suggestSlot: what the name says', () => {
  it('keeps a morning routine inside the morning', () => {
    const s = slot(ask({ block: { blockType: 'routine', title: 'Morning routine', urgency: 'important', durationMin: 30 } }));
    expect(s.parent).toEqual({ kind: 'cue', id: 'wake' });
    expect(s.reason).toMatch(/morning/i);
  });

  it('never puts a morning routine at lunch, even in the sharpest slot', () => {
    const s = suggestSlot({
      block: { blockType: 'routine', urgency: 'important', durationMin: 30, title: 'Morning routine' },
      blocks: [],
      cues: [lunch, dinner, bed], // nothing in the morning at all
      weekday: MON,
      isoDate: DATE,
      nowMin: 6 * 60,
      profile,
    });
    expect(s.kind).toBe('tomorrow');
  });

  it('says tomorrow, and why, once the window has passed', () => {
    const s = ask({ nowMin: 14 * 60, block: { blockType: 'routine', title: 'Morning routine', urgency: 'important', durationMin: 30 } });
    expect(s.kind).toBe('tomorrow');
    expect(s.reason).toMatch(/morning/i);
    expect(s.reason).toMatch(/tomorrow/i);
  });

  it('says tomorrow when nothing is left today even with no window', () => {
    const s = ask({ nowMin: 23 * 60 });
    expect(s.kind).toBe('tomorrow');
  });
});

describe('suggestSlot: the rest of the day is protected', () => {
  it('does not take a slot that would push an existing block past the next cue', () => {
    // wake 07:00 to mid 10:00. "big" fills 07:00 to 09:30, so nothing of an hour fits around it.
    const big = existing('big', { kind: 'cue', id: 'wake' }, 150);
    const s = slot(ask({ cues: [wake, mid, bed], blocks: [big] }));
    expect(s.parent).toEqual({ kind: 'cue', id: 'mid' });
  });

  it('inserts into a chain and reports the time the block would really get, break included', () => {
    const a = existing('a', { kind: 'cue', id: 'wake' }, 60, { committed: true });
    const s = slot(ask({ blocks: [a], block: { urgency: 'urgent-important', durationMin: 30 }, nowMin: 7 * 60 + 30 }));
    // a ends 08:00 and earns a 12 minute break
    expect(s.parent).toEqual({ kind: 'block', id: 'a' });
    expect(s.startMin).toBe(8 * 60 + 12);
  });

  it('never puts a block ahead of one that is more urgent, even where its own ranking would like to', () => {
    // Q3 work likes the lowest-energy slot, which is 07:00, in front of the Q1 block already there
    const first = existing('first', { kind: 'cue', id: 'wake' }, 60, { urgency: 'urgent-important' });
    const s = slot(ask({ blocks: [first], block: { urgency: 'urgent', durationMin: 30 } }));
    expect(s.parent).toEqual({ kind: 'block', id: 'first' });
  });

  it('does put a block ahead of one that is less urgent', () => {
    const later = existing('later', { kind: 'cue', id: 'wake' }, 60, { urgency: 'urgent' });
    const s = slot(ask({ blocks: [later], block: { urgency: 'urgent-important', durationMin: 30 } }));
    expect(s.parent).toEqual({ kind: 'cue', id: 'wake' });
  });

  it('puts a routine block between two deep blocks', () => {
    const a = existing('a', { kind: 'cue', id: 'wake' }, 60);
    const b = existing('b', { kind: 'block', id: 'a' }, 60);
    const s = slot(
      ask({ blocks: [a, b], block: { blockType: 'routine', urgency: 'important', durationMin: 20, title: 'Laundry' } }),
    );
    expect(s.parent).toEqual({ kind: 'block', id: 'a' });
  });

  it('treats a routine block like any other when there is no gap between deep blocks', () => {
    const s = slot(ask({ block: { blockType: 'routine', urgency: 'urgent-important', durationMin: 20, title: 'Laundry' } }));
    expect(s.parent).toEqual({ kind: 'cue', id: 'wake' });
  });
});

describe('suggestSlot: blocks that do not get a slot', () => {
  it('gives a Q4 block no suggestion', () => {
    expect(ask({ block: { urgency: 'neither' } }).kind).toBe('none');
  });

  it('gives no suggestion when no cue runs today', () => {
    const s = ask({ cues: [] });
    expect(s.kind).toBe('none');
    expect(s.reason).toMatch(/cue/i);
  });

  it('puts a rest block you made yourself after everything else', () => {
    const a = existing('a', { kind: 'cue', id: 'wake' }, 60);
    const s = slot(ask({ blocks: [a], block: { blockType: 'recharge', urgency: null, durationMin: 60, title: '' } }));
    expect(s.parent).toEqual({ kind: 'cue', id: 'dinner' });
  });
});
