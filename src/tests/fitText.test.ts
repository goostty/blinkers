import { describe, expect, it } from 'vitest';
import type { FitSummary } from '../dayPlan';
import { describeFit, listNames } from '../fitText';

const titles: Record<string, string> = { a: 'Email', b: 'Laundry', c: 'Report', d: 'Gym' };
const titleOf = (id: string) => titles[id] ?? 'A block';

const asking = (over: Partial<FitSummary> = {}): FitSummary => ({
  needsDecision: true,
  applied: 'shorten',
  recommended: 'shorten',
  shortenPercent: 15,
  dropped: ['a', 'b'],
  ...over,
});

describe('listNames', () => {
  it('reads like a sentence', () => {
    expect(listNames(['Email'])).toBe('Email');
    expect(listNames(['Email', 'Laundry'])).toBe('Email and Laundry');
    expect(listNames(['Email', 'Laundry', 'Report'])).toBe('Email, Laundry and Report');
  });

  it('keeps a long list short', () => {
    expect(listNames(['Email', 'Laundry', 'Report', 'Gym', 'Walk'])).toBe('Email, Laundry and 3 more');
  });
});

describe('describeFit when the user has to choose', () => {
  it('says nothing when the day fits', () => {
    expect(describeFit({ needsDecision: false, applied: null, recommended: null, shortenPercent: null, dropped: [] }, titleOf)).toBeNull();
  });

  it('offers both ways out and marks the recommended one', () => {
    const panel = describeFit(asking(), titleOf)!;
    expect(panel.asking).toBe(true);
    expect(panel.headline).toMatch(/does not fit/i);
    expect(panel.options).toEqual([
      { choice: 'shorten', label: 'Shorten everything by 15%', hint: 'Blocks and breaks get a little shorter. Nothing moves.', recommended: true },
      { choice: 'drop', label: 'Move to tomorrow: Email and Laundry', hint: 'The lowest priority work goes first.', recommended: false },
    ]);
  });

  it('marks drop as recommended when shortening is not enough, and does not offer shortening', () => {
    const panel = describeFit(asking({ recommended: 'drop', applied: 'drop', shortenPercent: null }), titleOf)!;
    expect(panel.options.map((o) => [o.choice, o.recommended])).toEqual([['drop', true]]);
  });

  it('says what is applied until the user chooses', () => {
    expect(describeFit(asking(), titleOf)!.note).toMatch(/until you choose/i);
    expect(describeFit(asking(), titleOf)!.note).toMatch(/shortened/i);
    expect(describeFit(asking({ recommended: 'drop', applied: 'drop', shortenPercent: null }), titleOf)!.note).toMatch(/tomorrow/i);
  });

  it('says plainly when nothing more can be done', () => {
    const panel = describeFit(asking({ applied: 'drop', recommended: 'drop', shortenPercent: null, dropped: [] }), titleOf)!;
    expect(panel.options).toEqual([]);
    expect(panel.headline).toMatch(/nothing/i);
  });
});

describe('describeFit once the user has chosen', () => {
  it('says what was done to the day, and offers to change it', () => {
    const shortened = describeFit(asking({ needsDecision: false }), titleOf)!;
    expect(shortened).toMatchObject({ asking: false, options: [], canChange: true });
    expect(shortened.headline).toBe('Everything is 15% shorter so today fits.');

    const dropped = describeFit(asking({ needsDecision: false, applied: 'drop', recommended: 'drop' }), titleOf)!;
    expect(dropped.headline).toBe('Email and Laundry moved to tomorrow so today fits.');
  });
});
