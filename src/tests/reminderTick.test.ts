import { describe, expect, it } from 'vitest';
import { describeStatus } from '../reminderTick';

// 10:05 AM local time on some day; only the clock part is shown.
const at = (h: number, m: number) => Math.floor(new Date(2026, 9, 20, h, m).getTime() / 1000);

describe('describeStatus', () => {
  it('says nothing has gone out yet', () => {
    expect(describeStatus(null, null)).toBe('No reminders sent yet.');
  });

  it('says when the last reminder went out', () => {
    expect(describeStatus(at(10, 5), null)).toBe('Last reminder sent at 10:05 AM.');
    expect(describeStatus(at(15, 30), null)).toBe('Last reminder sent at 3:30 PM.');
  });

  it('says plainly when reminders are not getting through, and that it will keep trying', () => {
    expect(describeStatus(null, 'Could not reach ntfy: timed out')).toBe(
      "Reminders are not getting through: Could not reach ntfy: timed out. It will keep trying.",
    );
  });

  it('puts the problem first even if an earlier reminder did go out', () => {
    expect(describeStatus(at(10, 5), 'ntfy answered 503.')).toMatch(/^Reminders are not getting through/);
  });
});
