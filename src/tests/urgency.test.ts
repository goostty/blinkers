import { describe, expect, it } from 'vitest';
import { needsUrgency, resolveUrgency, URGENCY_OPTIONS } from '../urgency';

describe('needsUrgency', () => {
  it('is true for work blocks and false for rest blocks', () => {
    expect(needsUrgency('deep')).toBe(true);
    expect(needsUrgency('routine')).toBe(true);
    expect(needsUrgency('reset')).toBe(false);
    expect(needsUrgency('recharge')).toBe(false);
  });
});

describe('resolveUrgency', () => {
  it('forces a work block to be classified', () => {
    for (const type of ['deep', 'routine'] as const) {
      const result = resolveUrgency(type, null);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/pick/i);
    }
  });

  it('accepts every quadrant for a work block', () => {
    for (const option of URGENCY_OPTIONS) {
      expect(resolveUrgency('deep', option.value)).toEqual({ ok: true, value: option.value });
    }
  });

  it('refuses a value that is not a quadrant', () => {
    expect(resolveUrgency('deep', 'soon').ok).toBe(false);
    expect(resolveUrgency('routine', '').ok).toBe(false);
  });

  it('gives a rest block no urgency, even if one was picked before switching tabs', () => {
    expect(resolveUrgency('reset', null)).toEqual({ ok: true, value: null });
    expect(resolveUrgency('recharge', 'important')).toEqual({ ok: true, value: null });
  });
});

describe('URGENCY_OPTIONS', () => {
  it('offers the four Eisenhower quadrants once each', () => {
    expect(URGENCY_OPTIONS.map((o) => o.value).sort()).toEqual(['important', 'neither', 'urgent', 'urgent-important']);
  });
});
