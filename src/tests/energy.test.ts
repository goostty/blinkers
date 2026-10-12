import { describe, expect, it } from 'vitest';
import { describeEnergy, energyAt, energyCurve, windowEnergy, type Chronotype, type UserProfile } from '../energy';

const profile = (chronotype: Chronotype, energyOverrides?: Record<number, number>): UserProfile => ({
  chronotype,
  energyOverrides,
});
const TYPES: Chronotype[] = ['morning', 'neutral', 'night'];

// First hour at which the curve reaches its maximum.
const peakHour = (c: number[]) => c.indexOf(Math.max(...c));

describe('default curves', () => {
  it.each(TYPES)('%s has 24 integer values between 1 and 5', (t) => {
    const c = energyCurve(profile(t));
    expect(c).toHaveLength(24);
    expect(c.every((v) => Number.isInteger(v) && v >= 1 && v <= 5)).toBe(true);
  });

  it.each(TYPES)('%s has an afternoon dip (13:00-17:00 reaches 2 or lower)', (t) => {
    const afternoon = energyCurve(profile(t)).slice(13, 17);
    expect(Math.min(...afternoon)).toBeLessThanOrEqual(2);
  });

  it('peaks earlier for a morning person than neutral, and neutral than a night owl', () => {
    const m = peakHour(energyCurve(profile('morning')));
    const n = peakHour(energyCurve(profile('neutral')));
    const o = peakHour(energyCurve(profile('night')));
    expect(m).toBeLessThan(n);
    expect(n).toBeLessThan(o);
  });

  it('returns a copy so callers can not corrupt the defaults', () => {
    const c = energyCurve(profile('neutral'));
    c[10] = 1;
    expect(energyCurve(profile('neutral'))[10]).not.toBe(1);
  });
});

describe('overrides', () => {
  it('replaces the chosen hour only', () => {
    const base = energyCurve(profile('neutral'));
    const c = energyCurve(profile('neutral', { 15: 5 }));
    expect(c[15]).toBe(5);
    expect(c.filter((_, i) => i !== 15)).toEqual(base.filter((_, i) => i !== 15));
  });

  it.each([
    ['hour 24', { 24: 3 }],
    ['negative hour', { [-1]: 3 }],
    ['value 6', { 10: 6 }],
    ['value 0', { 10: 0 }],
    ['fractional value', { 10: 2.5 }],
  ])('ignores invalid override: %s', (_name, o) => {
    expect(energyCurve(profile('neutral', o))).toEqual(energyCurve(profile('neutral')));
  });
});

describe('energyAt', () => {
  const c = energyCurve(profile('neutral'));
  it('reads the hour the minute falls in', () => expect(energyAt(profile('neutral'), 930)).toBe(c[15]));
  it('wraps minutes past midnight', () => expect(energyAt(profile('neutral'), 1440 + 60)).toBe(c[1]));
  it('wraps negative minutes', () => expect(energyAt(profile('neutral'), -60)).toBe(c[23]));
});

describe('windowEnergy', () => {
  it('equals the hour value inside a single hour', () => {
    const c = energyCurve(profile('morning'));
    expect(windowEnergy(profile('morning'), 8 * 60, 60)).toBe(c[8]);
  });

  it('weights by minutes when the window straddles two hours', () => {
    const c = energyCurve(profile('neutral'));
    const expected = (c[13] * 30 + c[14] * 30) / 60;
    expect(windowEnergy(profile('neutral'), 13 * 60 + 30, 60)).toBeCloseTo(expected);
  });

  it('wraps across midnight', () => {
    const c = energyCurve(profile('night'));
    expect(windowEnergy(profile('night'), 23 * 60, 120)).toBeCloseTo((c[23] + c[0]) / 2);
  });

  it('accepts a start beyond 1439 (a wrapped cue window)', () => {
    const c = energyCurve(profile('night'));
    expect(windowEnergy(profile('night'), 1440 + 60, 60)).toBe(c[1]);
  });

  it('accepts a negative start (an early-morning cue whose drift reaches back before midnight)', () => {
    const c = energyCurve(profile('night'));
    // -5..+5 minutes around midnight: 5 minutes of hour 23, 5 minutes of hour 0.
    expect(windowEnergy(profile('night'), -5, 10)).toBeCloseTo((c[23] * 5 + c[0] * 5) / 10);
  });

  it('falls back to the point value for a zero-length window', () => {
    expect(windowEnergy(profile('neutral'), 600, 0)).toBe(energyAt(profile('neutral'), 600));
  });

  it('respects overrides', () => {
    expect(windowEnergy(profile('neutral', { 15: 5 }), 15 * 60, 60)).toBe(5);
  });
});

describe('describeEnergy', () => {
  it.each([
    [5, 'High'],
    [3.5, 'High'],
    [3.4, 'Medium'],
    [2.5, 'Medium'],
    [2.4, 'Low'],
    [1, 'Low'],
  ])('labels %d as %s', (value, label) => expect(describeEnergy(value)).toBe(label));
});
