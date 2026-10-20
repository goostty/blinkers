import { describe, expect, it } from 'vitest';
import { buildTimeline, removeFromChains, type NodeRef, type Timeline, type TimelineBlock, type TimelineCue } from '../timeline';

const cue = (id: string, hour: number, over: Partial<TimelineCue> = {}): TimelineCue => ({ id, timeMin: hour * 60, ...over });
const blk = (id: string, durationMin: number, parent: NodeRef | null, over: Partial<TimelineBlock> = {}): TimelineBlock => ({
  id,
  durationMin,
  parent,
  ...over,
});
const after = (kind: 'cue' | 'block', id: string): NodeRef => ({ kind, id });
const entry = (t: Timeline, id: string) => t.entries.find((e) => e.blockId === id);
const reasonOf = (t: Timeline, id: string) => t.invalid.find((p) => p.blockId === id)?.reason;

const school = cue('school', 15); // 15:00
const dinner = cue('dinner', 18); // 18:00

describe('buildTimeline: a chain after a cue', () => {
  it('starts the first block at its cue time', () => {
    const t = buildTimeline([blk('a', 45, after('cue', 'school'))], [school, dinner]);
    expect(entry(t, 'a')).toMatchObject({ cueId: 'school', position: 0, startMin: 900, endMin: 945, fits: true });
  });

  it('runs blocks back to back, each starting when the one before it ends', () => {
    const t = buildTimeline(
      [blk('a', 45, after('cue', 'school')), blk('b', 30, after('block', 'a')), blk('c', 20, after('block', 'b'))],
      [school, dinner],
    );
    expect(t.entries.map((e) => [e.blockId, e.position, e.startMin, e.endMin])).toEqual([
      ['a', 0, 900, 945],
      ['b', 1, 945, 975],
      ['c', 2, 975, 995],
    ]);
  });

  it('does not care what order the blocks are listed in', () => {
    const t = buildTimeline(
      [blk('c', 20, after('block', 'b')), blk('b', 30, after('block', 'a')), blk('a', 45, after('cue', 'school'))],
      [dinner, school],
    );
    expect(entry(t, 'c')!.startMin).toBe(975);
  });

  it('keeps each cue\'s chain separate', () => {
    const t = buildTimeline([blk('a', 30, after('cue', 'school')), blk('d', 30, after('cue', 'dinner'))], [school, dinner]);
    expect(entry(t, 'a')).toMatchObject({ cueId: 'school', startMin: 900 });
    expect(entry(t, 'd')).toMatchObject({ cueId: 'dinner', startMin: 1080 });
  });

  it('lists entries in start-time order across chains', () => {
    const t = buildTimeline([blk('d', 30, after('cue', 'dinner')), blk('a', 30, after('cue', 'school'))], [dinner, school]);
    expect(t.entries.map((e) => e.blockId)).toEqual(['a', 'd']);
  });
});

describe('buildTimeline: fitting before the next cue', () => {
  it('lets a block end exactly when the next cue starts', () => {
    const t = buildTimeline([blk('a', 180, after('cue', 'school'))], [school, dinner]); // 15:00 + 3h = 18:00
    expect(entry(t, 'a')!.fits).toBe(true);
  });

  it('marks a block that would run one minute past the next cue as not fitting', () => {
    const t = buildTimeline([blk('a', 181, after('cue', 'school'))], [school, dinner]);
    expect(entry(t, 'a')).toMatchObject({ fits: false, endMin: 1081 });
  });

  it('marks every block after one that does not fit as not fitting, however small', () => {
    const t = buildTimeline(
      [blk('a', 100, after('cue', 'school')), blk('b', 100, after('block', 'a')), blk('c', 5, after('block', 'b'))],
      [school, dinner],
    );
    expect(['a', 'b', 'c'].map((id) => entry(t, id)!.fits)).toEqual([true, false, false]);
  });

  it('does not let one chain\'s overflow affect another chain', () => {
    const t = buildTimeline([blk('a', 999, after('cue', 'school')), blk('d', 30, after('cue', 'dinner'))], [school, dinner]);
    expect(entry(t, 'a')!.fits).toBe(false);
    expect(entry(t, 'd')).toMatchObject({ fits: true, startMin: 1080 });
  });

  it('lets the last cue run to midnight when no end-of-day cue is declared', () => {
    const t = buildTimeline([blk('a', 360, after('cue', 'dinner')), blk('b', 1, after('block', 'a'))], [school, dinner]);
    expect(entry(t, 'a')).toMatchObject({ fits: true, endMin: 1440 });
    expect(entry(t, 'b')!.fits).toBe(false);
  });

  it('ends the chain before an end-of-day cue, which cannot hold blocks itself', () => {
    const bed = cue('bed', 22, { endsDay: true });
    const t = buildTimeline([blk('a', 241, after('cue', 'dinner')), blk('x', 10, after('cue', 'bed'))], [school, dinner, bed]);
    expect(entry(t, 'a')!.fits).toBe(false); // 18:00 + 4h1m runs past 22:00
    expect(entry(t, 'x')).toBeUndefined();
    expect(reasonOf(t, 'x')).toMatch(/end-of-day/i);
  });
});

describe('buildTimeline: finishing early', () => {
  it('pulls the following blocks forward when a block is finished early', () => {
    const t = buildTimeline(
      [
        blk('a', 45, after('cue', 'school'), { endedAtMin: 930 }), // planned 15:45, done 15:30
        blk('b', 30, after('block', 'a')),
      ],
      [school, dinner],
    );
    expect(entry(t, 'a')).toMatchObject({ startMin: 900, endMin: 930 });
    expect(entry(t, 'b')).toMatchObject({ startMin: 930, endMin: 960 });
  });

  it('shifts the whole rest of the chain, not just the next block', () => {
    const t = buildTimeline(
      [
        blk('a', 60, after('cue', 'school'), { endedAtMin: 930 }),
        blk('b', 30, after('block', 'a')),
        blk('c', 30, after('block', 'b')),
      ],
      [school, dinner],
    );
    expect(entry(t, 'c')).toMatchObject({ startMin: 960, endMin: 990 });
  });

  it('never moves the next cue', () => {
    const t = buildTimeline([blk('a', 60, after('cue', 'school'), { endedAtMin: 910 }), blk('d', 30, after('cue', 'dinner'))], [school, dinner]);
    expect(entry(t, 'd')!.startMin).toBe(1080);
  });

  it('can let a block that did not fit now fit', () => {
    const blocks = [blk('a', 120, after('cue', 'school')), blk('b', 90, after('block', 'a'))]; // 15:00 + 210 min > 18:00
    expect(entry(buildTimeline(blocks, [school, dinner]), 'b')!.fits).toBe(false);

    const early = [blk('a', 120, after('cue', 'school'), { endedAtMin: 15 * 60 + 60 }), blocks[1]]; // a done after 60 min
    expect(entry(buildTimeline(early, [school, dinner]), 'b')).toMatchObject({ fits: true, startMin: 960, endMin: 1050 });
  });

  it('never pushes later blocks back, even if a block is somehow recorded as ending late', () => {
    const t = buildTimeline([blk('a', 30, after('cue', 'school'), { endedAtMin: 1000 }), blk('b', 30, after('block', 'a'))], [school, dinner]);
    expect(entry(t, 'b')!.startMin).toBe(930);
  });

  it('does not let a block end before it began', () => {
    const t = buildTimeline([blk('a', 30, after('cue', 'school'), { endedAtMin: 800 })], [school, dinner]);
    expect(entry(t, 'a')).toMatchObject({ startMin: 900, endMin: 900 });
  });
});

describe('buildTimeline: blocks that cannot be placed', () => {
  it('reports a block with no parent as unattached and does not schedule it', () => {
    const t = buildTimeline([blk('a', 30, null)], [school]);
    expect(t.unattached).toEqual(['a']);
    expect(t.entries).toEqual([]);
    expect(t.invalid).toEqual([]);
  });

  it('reports a block attached to a cue that does not run today', () => {
    const t = buildTimeline([blk('a', 30, after('cue', 'gone'))], [school]);
    expect(reasonOf(t, 'a')).toMatch(/cue/i);
  });

  it('reports a block that follows a block that is missing', () => {
    const t = buildTimeline([blk('a', 30, after('block', 'ghost'))], [school]);
    expect(reasonOf(t, 'a')).toMatch(/missing/i);
  });

  it('holds back a block that follows a block still waiting to be attached', () => {
    const t = buildTimeline([blk('a', 30, null), blk('b', 30, after('block', 'a'))], [school]);
    expect(t.unattached).toEqual(['a']);
    expect(reasonOf(t, 'b')).toMatch(/not attached/i);
  });

  it('reports a loop instead of hanging', () => {
    const t = buildTimeline([blk('a', 30, after('block', 'b')), blk('b', 30, after('block', 'a'))], [school]);
    expect(t.entries).toEqual([]);
    expect(reasonOf(t, 'a')).toMatch(/loop|broken/i);
    expect(reasonOf(t, 'b')).toMatch(/loop|broken/i);
  });

  it('keeps the first block and reports the second when two follow the same node', () => {
    const t = buildTimeline([blk('a', 30, after('cue', 'school')), blk('b', 30, after('cue', 'school'))], [school]);
    expect(entry(t, 'a')).toBeDefined();
    expect(entry(t, 'b')).toBeUndefined();
    expect(reasonOf(t, 'b')).toMatch(/same/i);
  });

  it('refuses a duration that is not a whole number of minutes, and stops that chain there', () => {
    for (const bad of [0, -5, 2.5, NaN]) {
      const t = buildTimeline([blk('a', bad, after('cue', 'school')), blk('b', 30, after('block', 'a'))], [school]);
      expect(entry(t, 'a')).toBeUndefined();
      expect(reasonOf(t, 'a')).toMatch(/duration/i);
      expect(reasonOf(t, 'b')).toBeDefined();
    }
  });
});

describe('buildTimeline: purity', () => {
  it('does not change its inputs', () => {
    const blocks = [blk('b', 30, after('block', 'a')), blk('a', 45, after('cue', 'school'), { endedAtMin: 930 })];
    const cues = [dinner, school];
    const snapshot = JSON.stringify([blocks, cues]);
    buildTimeline(blocks, cues);
    expect(JSON.stringify([blocks, cues])).toBe(snapshot);
  });

  it('returns an empty timeline for no blocks', () => {
    expect(buildTimeline([], [school])).toEqual({ entries: [], unattached: [], invalid: [] });
  });
});

describe('removeFromChains', () => {
  it('takes the blocks out and links what followed them to what they followed', () => {
    const blocks = [blk('a', 30, after('cue', 'school')), blk('b', 30, after('block', 'a')), blk('c', 30, after('block', 'b'))];
    const got = removeFromChains(blocks, ['b']);
    expect(got.map((b) => b.id)).toEqual(['a', 'c']);
    expect(got.find((b) => b.id === 'c')!.parent).toEqual(after('block', 'a'));
  });

  it('closes the gap when several blocks in a row are removed', () => {
    const blocks = [blk('a', 30, after('cue', 'school')), blk('b', 30, after('block', 'a')), blk('c', 30, after('block', 'b')), blk('d', 30, after('block', 'c'))];
    const got = removeFromChains(blocks, ['b', 'c']);
    expect(got.find((b) => b.id === 'd')!.parent).toEqual(after('block', 'a'));
  });

  it('links what followed a removed first block straight to the cue', () => {
    const blocks = [blk('a', 30, after('cue', 'school')), blk('b', 30, after('block', 'a'))];
    expect(removeFromChains(blocks, ['a'])[0].parent).toEqual(after('cue', 'school'));
  });

  it('shifts the later blocks earlier once the gap is closed', () => {
    const blocks = [blk('a', 30, after('cue', 'school')), blk('b', 60, after('block', 'a')), blk('c', 30, after('block', 'b'))];
    const t = buildTimeline(removeFromChains(blocks, ['b']), [school, dinner]);
    expect(entry(t, 'c')).toMatchObject({ startMin: 930, endMin: 960 });
  });

  it('leaves a block that was waiting to be attached waiting', () => {
    const blocks = [blk('a', 30, null), blk('b', 30, after('block', 'a'))];
    expect(removeFromChains(blocks, ['b']).map((b) => b.parent)).toEqual([null]);
  });

  it('returns everything unchanged when nothing is removed, and does not change its input', () => {
    const blocks = [blk('a', 30, after('cue', 'school')), blk('b', 30, after('block', 'a'))];
    const snapshot = JSON.stringify(blocks);
    expect(removeFromChains(blocks, [])).toEqual(blocks);
    removeFromChains(blocks, ['a']);
    expect(JSON.stringify(blocks)).toBe(snapshot);
  });

  it('does not hang when removed blocks follow each other in a loop', () => {
    const blocks = [blk('a', 30, after('block', 'b')), blk('b', 30, after('block', 'a')), blk('c', 30, after('block', 'a'))];
    expect(() => removeFromChains(blocks, ['a', 'b'])).not.toThrow();
  });
});
