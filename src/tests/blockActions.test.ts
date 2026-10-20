import { describe, expect, it } from 'vitest';
import { blockActions } from '../blockActions';

const MIN = 60;

const input = (status: string, startedAt: number | null = null, durationMin = 60) => ({
  status,
  startedAt,
  durationMin,
});

describe('blockActions', () => {
  it('offers only Start for a block that has not been started', () => {
    for (const status of ['planned', 'nagging']) {
      expect(blockActions(input(status), 0)).toEqual({
        actions: [{ action: 'start', enabled: true, waitSec: 0 }],
        settled: null,
      });
    }
  });

  it('offers Finish and Lapse for a started block, both waiting at first', () => {
    const r = blockActions(input('started', 1000), 1000 + 10 * MIN);
    expect(r.settled).toBeNull();
    expect(r.actions).toEqual([
      { action: 'finish', enabled: false, waitSec: 20 * MIN },
      { action: 'lapse', enabled: false, waitSec: 50 * MIN },
    ]);
  });

  it('enables Finish at half the length, while Lapse still waits for the full length', () => {
    const r = blockActions(input('started', 1000), 1000 + 30 * MIN);
    expect(r.actions).toEqual([
      { action: 'finish', enabled: true, waitSec: 0 },
      { action: 'lapse', enabled: false, waitSec: 30 * MIN },
    ]);
  });

  it('enables Lapse once the full length has passed since Start', () => {
    const r = blockActions(input('started', 1000), 1000 + 60 * MIN);
    expect(r.actions).toEqual([
      { action: 'finish', enabled: true, waitSec: 0 },
      { action: 'lapse', enabled: true, waitSec: 0 },
    ]);
  });

  it('measures from Start, not from the plan, so a late start gets its full length', () => {
    const r = blockActions(input('started', 5000, 20), 5000 + 2 * MIN);
    expect(r.actions[1]).toEqual({ action: 'lapse', enabled: false, waitSec: 18 * MIN });
  });

  it('treats a clock that went backwards as no time passed', () => {
    const r = blockActions(input('started', 5000, 10), 4000);
    expect(r.actions).toEqual([
      { action: 'finish', enabled: false, waitSec: 5 * MIN },
      { action: 'lapse', enabled: false, waitSec: 10 * MIN },
    ]);
  });

  it('shows nothing to press for a block that was finished or lapsed, and says how it ended', () => {
    for (const status of ['finished', 'lapsed'] as const) {
      expect(blockActions(input(status, 1000), 9999)).toEqual({ actions: [], settled: status });
    }
  });

  it('offers Reschedule and Drop for a missed block, both always available', () => {
    expect(blockActions(input('missed'), 9999)).toEqual({
      actions: [
        { action: 'reschedule', enabled: true, waitSec: 0 },
        { action: 'drop', enabled: true, waitSec: 0 },
      ],
      settled: 'missed',
    });
  });

  it('shows nothing for a status it does not know', () => {
    expect(blockActions(input('paused'), 0)).toEqual({ actions: [], settled: null });
  });

  it('disables both buttons when a started block has no start time', () => {
    const r = blockActions(input('started', null), 100);
    expect(r.actions).toEqual([
      { action: 'finish', enabled: false, waitSec: Infinity },
      { action: 'lapse', enabled: false, waitSec: Infinity },
    ]);
  });
});
