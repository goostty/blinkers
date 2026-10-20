import { describe, expect, it } from 'vitest';
import { pickFocus, pickMissed, type FocusCommitment } from '../focus';

const c = (blockId: string, status: string, startMin: number, durationMin = 30): FocusCommitment => ({
  blockId,
  status,
  startMin,
  durationMin,
});

describe('pickFocus', () => {
  it('shows nothing when there is nothing to do', () => {
    expect(pickFocus([], 600)).toBeNull();
  });

  it('shows the earliest block that has not started yet', () => {
    expect(pickFocus([c('b', 'planned', 700), c('a', 'planned', 650)], 600)).toBe('a');
  });

  it('puts a started block ahead of everything, even an earlier one that is waiting', () => {
    const list = [c('waiting', 'nagging', 600), c('going', 'started', 630)];
    expect(pickFocus(list, 640)).toBe('going');
  });

  it('keeps showing a started block after its time is up, because it still needs Finish or Lapse', () => {
    expect(pickFocus([c('a', 'started', 600, 30)], 900)).toBe('a');
  });

  it('puts a block whose reminder went out ahead of one that has not been reminded yet', () => {
    const list = [c('later', 'planned', 620), c('now', 'nagging', 600)];
    expect(pickFocus(list, 610)).toBe('now');
  });

  it('skips planned and nagging blocks whose window has passed', () => {
    const list = [c('old', 'planned', 500, 30), c('gone', 'nagging', 520, 30), c('next', 'planned', 700)];
    expect(pickFocus(list, 600)).toBe('next');
  });

  it('still shows a block in the minute its window ends', () => {
    expect(pickFocus([c('a', 'planned', 600, 30)], 629)).toBe('a');
    expect(pickFocus([c('a', 'planned', 600, 30)], 630)).toBeNull();
  });

  it('never shows blocks that are over', () => {
    const list = [c('a', 'finished', 600), c('b', 'lapsed', 610), c('c', 'missed', 620)];
    expect(pickFocus(list, 600)).toBeNull();
  });

  it('ignores a status it does not know', () => {
    expect(pickFocus([c('a', 'paused', 600)], 600)).toBeNull();
  });

  it('breaks ties by start time and then by id, so the choice is stable', () => {
    expect(pickFocus([c('b', 'started', 600), c('a', 'started', 600)], 610)).toBe('a');
    expect(pickFocus([c('b', 'started', 610), c('a', 'started', 650)], 660)).toBe('b');
  });
});

describe('pickMissed', () => {
  it('shows nothing when no block was missed', () => {
    expect(pickMissed([c('a', 'planned', 600), c('b', 'started', 610)])).toBeNull();
  });

  it('shows the earliest missed block, so they are dealt with in the order they happened', () => {
    expect(pickMissed([c('b', 'missed', 700), c('a', 'missed', 650)])).toBe('a');
  });

  it('breaks ties by id, so the choice is stable', () => {
    expect(pickMissed([c('b', 'missed', 600), c('a', 'missed', 600)])).toBe('a');
  });

  it('ignores blocks that ended any other way', () => {
    expect(pickMissed([c('a', 'finished', 600), c('b', 'lapsed', 610), c('c', 'missed', 620)])).toBe('c');
  });
});
