import { describe, expect, it } from 'vitest';
import { dayCapacity, minutePolicy, rolledByCaps, type CapBlock } from '../caps';
import type { Urgency } from '../scheduler';

const Q1: Urgency = 'urgent-important';
const Q2: Urgency = 'important';
const Q3: Urgency = 'urgent';

const cap = (
  id: string,
  urgency: Urgency | null,
  durationMin: number,
  over: Partial<CapBlock> = {},
): CapBlock => ({ id, urgency, durationMin, createdOn: '2026-10-12', orderIndex: 0, committed: false, ...over });

describe('dayCapacity', () => {
  it('adds up the time each cue has before the next one', () => {
    // 9:00 -> 12:00 is 180 min, 12:00 -> 18:00 is 360, 18:00 -> midnight is 360.
    const cues = [{ id: 'a', timeMin: 540 }, { id: 'b', timeMin: 720 }, { id: 'c', timeMin: 1080 }];
    expect(dayCapacity(cues)).toBe(180 + 360 + 360);
  });

  it('stops at an end-of-day cue, which has no time of its own', () => {
    const cues = [{ id: 'a', timeMin: 540 }, { id: 'bed', timeMin: 1320, endsDay: true }];
    expect(dayCapacity(cues)).toBe(1320 - 540);
  });

  it('does not depend on the order the cues are listed in', () => {
    const cues = [{ id: 'b', timeMin: 720 }, { id: 'a', timeMin: 540 }];
    expect(dayCapacity(cues)).toBe(180 + 720);
  });

  it('is zero with no cues', () => {
    expect(dayCapacity([])).toBe(0);
  });
});

describe('minutePolicy', () => {
  it('lets Q1 use half the day and holds a quarter for Q2 when enough Q2 is waiting', () => {
    expect(minutePolicy(480, 300)).toEqual({ maxQ1Min: 240, reserveQ2Min: 120, maxUrgentMin: 360 });
  });

  it('reserves only as much as the Q2 work actually waiting', () => {
    expect(minutePolicy(480, 45)).toEqual({ maxQ1Min: 240, reserveQ2Min: 45, maxUrgentMin: 435 });
  });

  it('releases the whole reserve when no Q2 is waiting', () => {
    expect(minutePolicy(480, 0)).toEqual({ maxQ1Min: 240, reserveQ2Min: 0, maxUrgentMin: 480 });
  });

  it('gives nothing out with no capacity', () => {
    expect(minutePolicy(0, 60)).toEqual({ maxQ1Min: 0, reserveQ2Min: 0, maxUrgentMin: 0 });
    expect(minutePolicy(-5, 60)).toEqual({ maxQ1Min: 0, reserveQ2Min: 0, maxUrgentMin: 0 });
  });
});

describe('rolledByCaps: the Q1 limit', () => {
  it('rolls the Q1 blocks that go past half the day, newest first', () => {
    // capacity 480 -> Q1 may use 240 min
    const blocks = [
      cap('a', Q1, 120, { orderIndex: 0 }),
      cap('b', Q1, 120, { orderIndex: 1 }),
      cap('c', Q1, 30, { orderIndex: 2 }),
    ];
    expect(rolledByCaps(blocks, 480)).toEqual(['c']);
  });

  it('keeps everything while Q1 stays within its share', () => {
    expect(rolledByCaps([cap('a', Q1, 240)], 480)).toEqual([]);
  });

  it('rolls a block that does not fit even if a smaller one after it would', () => {
    const blocks = [cap('a', Q1, 200, { orderIndex: 0 }), cap('b', Q1, 100, { orderIndex: 1 }), cap('c', Q1, 10, { orderIndex: 2 })];
    expect(rolledByCaps(blocks, 480)).toEqual(['b', 'c']);
  });

  it('serves an older carried-over Q1 block before a newer one', () => {
    const blocks = [
      cap('new', Q1, 200, { createdOn: '2026-10-12', orderIndex: 0 }),
      cap('old', Q1, 200, { createdOn: '2026-10-11', orderIndex: 1 }),
    ];
    expect(rolledByCaps(blocks, 480)).toEqual(['new']);
  });

  it('never rolls a block the user has already started, but it still uses up the share', () => {
    const blocks = [cap('late', Q1, 100, { orderIndex: 0 }), cap('begun', Q1, 200, { orderIndex: 5, committed: true })];
    expect(rolledByCaps(blocks, 480)).toEqual(['late']);
  });

  it('keeps a started block even when it alone is over the share', () => {
    expect(rolledByCaps([cap('begun', Q1, 400, { committed: true })], 480)).toEqual([]);
  });
});

describe('rolledByCaps: protecting the Q2 reserve', () => {
  it('rolls Q3 blocks that would eat into the reserve', () => {
    // capacity 480, Q2 waiting 200 -> reserve 120 -> Q1+Q3 may use 360
    const blocks = [cap('q2', Q2, 200), cap('q1', Q1, 200, { orderIndex: 1 }), cap('q3a', Q3, 100, { orderIndex: 2 }), cap('q3b', Q3, 100, { orderIndex: 3 })];
    expect(rolledByCaps(blocks, 480)).toEqual(['q3b']);
  });

  it('rolls Q3 before Q1 when both are over', () => {
    const blocks = [cap('q2', Q2, 200), cap('q1', Q1, 240, { orderIndex: 1 }), cap('q3', Q3, 130, { orderIndex: 2 })];
    expect(rolledByCaps(blocks, 480)).toEqual(['q3']); // 240 + 130 > 360
  });

  it('does not touch Q3 when no Q2 is waiting', () => {
    const blocks = [cap('q1', Q1, 240), cap('q3', Q3, 240, { orderIndex: 1 })];
    expect(rolledByCaps(blocks, 480)).toEqual([]);
  });

  it('keeps a started Q3 block even if it eats into the reserve', () => {
    const blocks = [cap('q2', Q2, 200), cap('q3', Q3, 400, { committed: true })];
    expect(rolledByCaps(blocks, 480)).toEqual([]);
  });

  it('counts started Q1 minutes against the Q1 + Q3 limit', () => {
    const blocks = [cap('q2', Q2, 200), cap('q1', Q1, 240, { committed: true }), cap('q3', Q3, 130, { orderIndex: 1 })];
    expect(rolledByCaps(blocks, 480)).toEqual(['q3']);
  });
});

describe('rolledByCaps: everything else is left alone', () => {
  it('ignores Q2, Q4, rest and legacy blocks', () => {
    const blocks = [cap('q2', Q2, 900), cap('q4', 'neither', 900), cap('rest', null, 900), cap('old', null, 900)];
    expect(rolledByCaps(blocks, 480)).toEqual([]);
  });

  it('rolls every uncommitted Q1 block when the day has no capacity', () => {
    expect(rolledByCaps([cap('a', Q1, 30), cap('b', Q3, 30)], 0)).toEqual(['a', 'b']);
  });

  it('does not change its input', () => {
    const blocks = [cap('b', Q1, 200, { orderIndex: 1 }), cap('a', Q1, 200, { orderIndex: 0 })];
    const snapshot = JSON.stringify(blocks);
    rolledByCaps(blocks, 480);
    expect(JSON.stringify(blocks)).toBe(snapshot);
  });
});
