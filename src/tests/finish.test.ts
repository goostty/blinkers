import { describe, expect, it } from 'vitest';
import { canFinish } from '../finish';

const MIN = 60;

describe('canFinish', () => {
  it('refuses until half the entered length has passed since Start', () => {
    expect(canFinish(1000, 1000 + 29 * MIN, 60).ok).toBe(false);
  });

  it('allows it exactly at half', () => {
    expect(canFinish(1000, 1000 + 30 * MIN, 60).ok).toBe(true);
  });

  it('allows it any time after half', () => {
    expect(canFinish(1000, 1000 + 59 * MIN, 60).ok).toBe(true);
  });

  it('says how long is left to wait', () => {
    expect(canFinish(1000, 1000 + 10 * MIN, 60)).toEqual({ ok: false, waitSec: 20 * MIN });
    expect(canFinish(1000, 1000 + 30 * MIN, 60)).toEqual({ ok: true, waitSec: 0 });
  });

  it('counts the length as entered, with no padding', () => {
    expect(canFinish(0, 5 * MIN, 10).ok).toBe(true); // half of 10 min
  });

  it('measures from when Start was pressed, not from when the block was planned', () => {
    // started late: only 2 minutes of work so far, however long ago it was planned
    expect(canFinish(5000, 5000 + 2 * MIN, 20).ok).toBe(false);
  });

  it('cannot finish a block that was never started', () => {
    expect(canFinish(null, 9999, 10)).toEqual({ ok: false, waitSec: Infinity });
  });

  it('treats a clock that went backwards as no time passed', () => {
    expect(canFinish(5000, 4000, 10)).toEqual({ ok: false, waitSec: 5 * MIN });
  });

  it('handles odd lengths by rounding the wait up to a whole second', () => {
    expect(canFinish(0, 0, 1)).toEqual({ ok: false, waitSec: 30 });
    expect(canFinish(0, 30, 1).ok).toBe(true);
  });
});
