// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { autoPlaceEnabled, setAutoPlace } from '../prefs';

beforeEach(() => localStorage.clear());

describe('autoPlaceEnabled', () => {
  it('is on until the user turns it off', () => {
    expect(autoPlaceEnabled()).toBe(true);
  });

  it('remembers a choice either way', () => {
    setAutoPlace(false);
    expect(autoPlaceEnabled()).toBe(false);
    setAutoPlace(true);
    expect(autoPlaceEnabled()).toBe(true);
  });

  it('ignores a stored value it does not understand', () => {
    localStorage.setItem('blinkers.autoplace', 'maybe');
    expect(autoPlaceEnabled()).toBe(true);
  });

  it('falls back to on, and does not crash, when storage is not available', () => {
    const real = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });
    try {
      expect(() => setAutoPlace(false)).not.toThrow();
      expect(autoPlaceEnabled()).toBe(true);
    } finally {
      Object.defineProperty(window, 'localStorage', real);
    }
  });
});
