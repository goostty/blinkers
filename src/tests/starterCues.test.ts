import { describe, expect, it } from 'vitest';
import { cuesOverlap } from '../cues';
import { STARTER_CUES } from '../starterCues';

describe('STARTER_CUES', () => {
  it('is a typical day: waking up, lunch, dinner and bedtime', () => {
    expect(STARTER_CUES.map((c) => c.label)).toEqual(['Wake up', 'Lunch', 'Dinner', 'Bedtime']);
  });

  it('repeats every day', () => {
    for (const cue of STARTER_CUES) expect(cue.days).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('is in order through the day, with valid times', () => {
    const times = STARTER_CUES.map((c) => c.timeMin);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    for (const t of times) {
      expect(Number.isInteger(t)).toBe(true);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThan(1440);
    }
  });

  it('ends the day with bedtime and with nothing else', () => {
    expect(STARTER_CUES.filter((c) => c.endsDay).map((c) => c.label)).toEqual(['Bedtime']);
  });

  it('has no two cues that overlap, so they can all be saved', () => {
    for (let i = 0; i < STARTER_CUES.length; i++) {
      for (let j = i + 1; j < STARTER_CUES.length; j++) {
        expect(cuesOverlap(STARTER_CUES[i], STARTER_CUES[j]), `${STARTER_CUES[i].label} / ${STARTER_CUES[j].label}`).toBe(false);
      }
    }
  });
});
