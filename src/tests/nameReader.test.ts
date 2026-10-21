import { describe, expect, it } from 'vitest';
import { readNameHints } from '../nameReader';

describe('readNameHints window', () => {
  it('reads a morning word as the morning window', () => {
    expect(readNameHints('Morning routine', 'routine').window).toEqual({ name: 'morning', startMin: 300, endMin: 720 });
  });

  it('reads an afternoon word as the afternoon window', () => {
    expect(readNameHints('afternoon review', 'deep').window).toEqual({ name: 'afternoon', startMin: 720, endMin: 1020 });
  });

  it('reads an evening word as the evening window', () => {
    expect(readNameHints('Evening wind down', 'routine').window).toEqual({ name: 'evening', startMin: 1020, endMin: 1320 });
  });

  it('knows words that imply a time of day without naming it', () => {
    expect(readNameHints('Make breakfast', 'routine').window?.name).toBe('morning');
    expect(readNameHints('Cook dinner', 'routine').window?.name).toBe('evening');
  });

  it('ignores case, spacing and punctuation', () => {
    expect(readNameHints('  MORNING,   stretch!! ', 'routine').window?.name).toBe('morning');
  });

  it('matches whole words only', () => {
    expect(readNameHints('Plan tomorrow', 'deep').window).toBeNull();
    expect(readNameHints('Mourning the old design', 'deep').window).toBeNull();
  });

  it('gives no window when the name says nothing about the time', () => {
    expect(readNameHints('Write chapter 3', 'deep').window).toBeNull();
    expect(readNameHints('', 'deep').window).toBeNull();
  });

  it('gives no window when the name points at two different times', () => {
    expect(readNameHints('Morning or evening run', 'routine').window).toBeNull();
  });

  it('is fine with the same time named twice', () => {
    expect(readNameHints('Morning pages, early morning', 'routine').window?.name).toBe('morning');
  });
});

describe('readNameHints energyNeed', () => {
  it('comes from the block type alone', () => {
    expect(readNameHints('anything', 'deep').energyNeed).toBe('High');
    expect(readNameHints('anything', 'routine').energyNeed).toBe('Medium');
    expect(readNameHints('anything', 'reset').energyNeed).toBe('Low');
    expect(readNameHints('anything', 'recharge').energyNeed).toBe('Low');
  });

  it('is not changed by the window words', () => {
    expect(readNameHints('Morning deep work', 'deep').energyNeed).toBe('High');
  });
});
