import { describe, expect, it } from 'vitest';
import { describeMoment } from '../scheduler';

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
