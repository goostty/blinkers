import { describe, expect, it } from 'vitest';
import { breakMinutes, breaksAfter, type ChainItem } from '../breaks';

const item = (id: string, blockType: ChainItem['blockType'], durationMin: number): ChainItem => ({
  id,
  blockType,
  durationMin,
});

describe('breakMinutes', () => {
  it('gives deep work 20% of its length', () => {
    expect(breakMinutes('deep', 50)).toBe(10);
    expect(breakMinutes('deep', 90)).toBe(18);
  });

  it('keeps a deep break between 5 and 20 minutes', () => {
    expect(breakMinutes('deep', 20)).toBe(5);
    expect(breakMinutes('deep', 150)).toBe(20);
  });

  it('gives routine work a shorter break: 10%, between 3 and 10 minutes', () => {
    expect(breakMinutes('routine', 60)).toBe(6);
    expect(breakMinutes('routine', 15)).toBe(3);
    expect(breakMinutes('routine', 120)).toBe(10);
  });

  it('gives rest blocks no break', () => {
    expect(breakMinutes('reset', 30)).toBe(0);
    expect(breakMinutes('recharge', 30)).toBe(0);
  });

  it('gives a bad duration no break', () => {
    expect(breakMinutes('deep', 0)).toBe(0);
    expect(breakMinutes('deep', -10)).toBe(0);
    expect(breakMinutes('deep', 45.5)).toBe(0);
    expect(breakMinutes('deep', Number.NaN)).toBe(0);
  });
});

describe('breaksAfter', () => {
  it('puts a break between two deep blocks', () => {
    const result = breaksAfter([item('a', 'deep', 50), item('b', 'deep', 50)]);
    expect(result.get('a')).toBe(10);
  });

  it('puts a break on both sides of a routine block between deep blocks', () => {
    const result = breaksAfter([item('a', 'deep', 50), item('r', 'routine', 30), item('b', 'deep', 50)]);
    expect(result.get('a')).toBe(10);
    expect(result.get('r')).toBe(3);
  });

  it('puts no break after the last block', () => {
    const result = breaksAfter([item('a', 'deep', 50), item('b', 'deep', 50)]);
    expect(result.has('b')).toBe(false);
  });

  it('puts no break before a rest block, so a recharge the user made is not doubled', () => {
    const result = breaksAfter([item('a', 'deep', 50), item('rest', 'recharge', 60)]);
    expect(result.has('a')).toBe(false);
  });

  it('puts no break after a rest block', () => {
    const result = breaksAfter([item('rest', 'reset', 10), item('a', 'deep', 50)]);
    expect(result.has('rest')).toBe(false);
  });

  it('handles an empty chain and a single block', () => {
    expect(breaksAfter([]).size).toBe(0);
    expect(breaksAfter([item('a', 'deep', 50)]).size).toBe(0);
  });

  it('leaves a block with a bad duration out of the result', () => {
    const result = breaksAfter([item('a', 'deep', 0), item('b', 'deep', 50)]);
    expect(result.has('a')).toBe(false);
  });
});
