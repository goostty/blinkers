import { describe, expect, it } from 'vitest';
import { nextToPlace } from '../autoPlace';
import type { Cue, Weekday } from '../cues';
import type { DayBlock } from '../dayPlan';

const MON: Weekday = 1;
const DATE = '2026-10-19';

const cue = (id: string, hour: number, over: Partial<Cue> = {}): Cue => ({
  id,
  label: id[0].toUpperCase() + id.slice(1),
  timeMin: hour * 60,
  days: [0, 1, 2, 3, 4, 5, 6],
  flexMin: 0,
  endsDay: false,
  ...over,
});

const waiting = (id: string, over: Partial<DayBlock> = {}): DayBlock => ({
  id,
  blockType: 'deep',
  orderIndex: 0,
  title: id,
  urgency: 'important',
  createdOn: DATE,
  durationMin: 60,
  parentKind: null,
  parentId: null,
  isCompleted: false,
  endedAtMin: null,
  committed: false,
  ...over,
});

const placed = (id: string, over: Partial<DayBlock> = {}): DayBlock =>
  waiting(id, { parentKind: 'cue', parentId: 'wake', ...over });

const cues = [cue('wake', 7), cue('lunch', 12), cue('dinner', 18), cue('bed', 22, { endsDay: true })];

const next = (blocks: DayBlock[], over: { nowMin?: number; skip?: Set<string>; cues?: Cue[] } = {}) =>
  nextToPlace({
    blocks,
    cues: over.cues ?? cues,
    weekday: MON,
    isoDate: DATE,
    nowMin: over.nowMin ?? 6 * 60,
    profile: { chronotype: 'neutral' },
    skip: over.skip ?? new Set(),
  });

describe('nextToPlace', () => {
  it('has nothing to do when every block already has a place', () => {
    expect(next([placed('a')])).toBeNull();
    expect(next([])).toBeNull();
  });

  it('places a waiting block where the suggestion says', () => {
    const r = next([waiting('a', { urgency: 'urgent-important' })])!;
    expect(r.blockId).toBe('a');
    expect(r.parent).toEqual({ kind: 'cue', id: 'wake' });
  });

  it('places the most urgent waiting block first', () => {
    const r = next([
      waiting('q3', { urgency: 'urgent' }),
      waiting('q2', { urgency: 'important' }),
      waiting('q1', { urgency: 'urgent-important' }),
    ])!;
    expect(r.blockId).toBe('q1');
  });

  it('places rest the user made after work', () => {
    const r = next([waiting('rest', { blockType: 'recharge', urgency: null }), waiting('q3', { urgency: 'urgent' })])!;
    expect(r.blockId).toBe('q3');
  });

  it('places older work before newer work of the same urgency', () => {
    const r = next([
      waiting('new', { createdOn: '2026-10-19', orderIndex: 1 }),
      waiting('old', { createdOn: '2026-10-12', orderIndex: 0 }),
    ])!;
    expect(r.blockId).toBe('old');
  });

  it('skips a block that has no room today and places the next one', () => {
    // it is 14:00, so "Morning routine" has nowhere to go today, but "Email" does
    const r = next([waiting('morning', { title: 'Morning routine', urgency: 'urgent-important' }), waiting('email', { title: 'Email' })], {
      nowMin: 14 * 60,
    })!;
    expect(r.blockId).toBe('email');
  });

  it('has nothing to do when no waiting block has room today', () => {
    expect(next([waiting('morning', { title: 'Morning routine' })], { nowMin: 14 * 60 })).toBeNull();
  });

  it('does not try a block it was told to skip', () => {
    const blocks = [waiting('a', { urgency: 'urgent-important' }), waiting('b')];
    expect(next(blocks, { skip: new Set(['a']) })!.blockId).toBe('b');
    expect(next(blocks, { skip: new Set(['a', 'b']) })).toBeNull();
  });

  it('does not let a waiting block count against itself', () => {
    // the only block fills almost the whole window, so it only fits if it is not counted twice
    const r = next([waiting('big', { durationMin: 290, urgency: 'urgent-important' })], { cues: [cue('wake', 7), cue('noon', 12)] });
    expect(r?.blockId).toBe('big');
  });

  it('never places anything in the past', () => {
    const r = next([waiting('a', { urgency: 'urgent-important' })], { nowMin: 13 * 60 })!;
    expect(r.parent).toEqual({ kind: 'cue', id: 'dinner' });
  });
});
