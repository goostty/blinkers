// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { hydrateDayState, loadChoices, minuteOfDay, raiseNotBefore, setFitChoice } from '../dayState';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
const backend = vi.mocked(invoke);

const TODAY = '2026-10-21';

beforeEach(() => {
  localStorage.clear();
  backend.mockReset();
  backend.mockResolvedValue(null);
});

describe('loadChoices', () => {
  it('has nothing for a day the user has not decided anything on', () => {
    expect(loadChoices(TODAY)).toEqual({});
  });

  it('remembers how the user chose to fix the day', () => {
    setFitChoice(TODAY, 'drop');
    expect(loadChoices(TODAY)).toEqual({ fit: 'drop' });
  });

  it('forgets a choice made on another day', () => {
    setFitChoice('2026-10-20', 'shorten');
    raiseNotBefore('2026-10-20', 600);
    expect(loadChoices(TODAY)).toEqual({});
  });

  it('ignores stored data that is not valid', () => {
    localStorage.setItem('blinkers.day', '{not json');
    expect(loadChoices(TODAY)).toEqual({});
    localStorage.setItem('blinkers.day', JSON.stringify({ date: TODAY, fit: 'burn it', notBeforeMin: 'soon' }));
    expect(loadChoices(TODAY)).toEqual({});
    localStorage.setItem('blinkers.day', JSON.stringify({ date: TODAY, notBeforeMin: 2000 }));
    expect(loadChoices(TODAY)).toEqual({});
  });
});

describe('setFitChoice', () => {
  it('can clear the choice so the user is asked again, and keeps the not-before time', () => {
    setFitChoice(TODAY, 'shorten');
    raiseNotBefore(TODAY, 600);
    setFitChoice(TODAY, undefined);
    expect(loadChoices(TODAY)).toEqual({ notBeforeMin: 600 });
  });

  it('replaces the stored day when the date changes', () => {
    setFitChoice('2026-10-20', 'drop');
    setFitChoice(TODAY, 'shorten');
    expect(loadChoices('2026-10-20')).toEqual({});
    expect(loadChoices(TODAY)).toEqual({ fit: 'shorten' });
  });
});

describe('raiseNotBefore', () => {
  it('only ever moves later, so a re-plan cannot put blocks back into the past', () => {
    raiseNotBefore(TODAY, 600);
    raiseNotBefore(TODAY, 540);
    expect(loadChoices(TODAY).notBeforeMin).toBe(600);
    raiseNotBefore(TODAY, 660);
    expect(loadChoices(TODAY).notBeforeMin).toBe(660);
  });

  it('refuses a minute that is not in the day', () => {
    raiseNotBefore(TODAY, -5);
    raiseNotBefore(TODAY, 1440);
    raiseNotBefore(TODAY, 600.5);
    expect(loadChoices(TODAY)).toEqual({});
  });
});

describe('when storage is not available', () => {
  it('does not crash, and just has no memory', () => {
    const real = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });
    try {
      expect(() => setFitChoice(TODAY, 'drop')).not.toThrow();
      expect(() => raiseNotBefore(TODAY, 600)).not.toThrow();
      expect(loadChoices(TODAY)).toEqual({});
    } finally {
      Object.defineProperty(window, 'localStorage', real);
    }
  });
});

describe('minuteOfDay', () => {
  it('is the local minute since midnight', () => {
    const at = (h: number, m: number) => Math.floor(new Date(2026, 9, 21, h, m, 30).getTime() / 1000);
    expect(minuteOfDay(at(0, 0))).toBe(0);
    expect(minuteOfDay(at(9, 5))).toBe(545);
    expect(minuteOfDay(at(23, 59))).toBe(1439);
  });
});

describe('keeping the choices in the database, so they sync with everything else', () => {
  const saved = () => backend.mock.calls.filter(([cmd]) => cmd === 'set_synced_setting').map(([, args]) => args as { key: string; value: string });

  it('writes a choice to the database as well', async () => {
    setFitChoice(TODAY, 'drop');
    await vi.waitFor(() => expect(saved()).toHaveLength(1));
    expect(saved()[0].key).toBe('day_state');
    expect(JSON.parse(saved()[0].value)).toEqual({ date: TODAY, fit: 'drop' });
  });

  it('writes the not-before time too, along with a choice already made', async () => {
    setFitChoice(TODAY, 'shorten');
    raiseNotBefore(TODAY, 600);
    await vi.waitFor(() => expect(saved()).toHaveLength(2));
    expect(JSON.parse(saved()[1].value)).toEqual({ date: TODAY, fit: 'shorten', notBeforeMin: 600 });
  });

  it('does not write when a not-before time is refused', () => {
    raiseNotBefore(TODAY, 5000);
    expect(saved()).toHaveLength(0);
  });

  it('carries on when the database cannot be written', () => {
    backend.mockRejectedValue('no database');
    expect(() => setFitChoice(TODAY, 'drop')).not.toThrow();
    expect(loadChoices(TODAY)).toEqual({ fit: 'drop' });
  });
});

describe('hydrateDayState', () => {
  const fromDatabase = (value: string | null) =>
    backend.mockImplementation(async (cmd: string) => (cmd === 'get_synced_setting' ? value : null));

  it("takes the database's choices for today, because that is what was synced", async () => {
    localStorage.setItem('blinkers.day', JSON.stringify({ date: TODAY, fit: 'shorten' }));
    fromDatabase(JSON.stringify({ date: TODAY, fit: 'drop', notBeforeMin: 600 }));
    await hydrateDayState(TODAY);
    expect(loadChoices(TODAY)).toEqual({ fit: 'drop', notBeforeMin: 600 });
  });

  it("ignores the database's choices when they are for another day", async () => {
    localStorage.setItem('blinkers.day', JSON.stringify({ date: TODAY, fit: 'shorten' }));
    fromDatabase(JSON.stringify({ date: '2026-10-20', fit: 'drop' }));
    await hydrateDayState(TODAY);
    expect(loadChoices(TODAY)).toEqual({ fit: 'shorten' });
  });

  it('keeps what is here when the database has nothing, or something unreadable', async () => {
    localStorage.setItem('blinkers.day', JSON.stringify({ date: TODAY, fit: 'shorten' }));
    fromDatabase(null);
    await hydrateDayState(TODAY);
    fromDatabase('{not json');
    await hydrateDayState(TODAY);
    expect(loadChoices(TODAY)).toEqual({ fit: 'shorten' });
  });

  it('does not write back what it has just read', async () => {
    fromDatabase(JSON.stringify({ date: TODAY, fit: 'drop' }));
    await hydrateDayState(TODAY);
    expect(backend.mock.calls.some(([cmd]) => cmd === 'set_synced_setting')).toBe(false);
  });

  it('copes with the database being unavailable', async () => {
    backend.mockRejectedValue('no database');
    await expect(hydrateDayState(TODAY)).resolves.toBeUndefined();
  });
});
