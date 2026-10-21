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

  it('pushes later blocks back when a block was finished late, because the plan follows what happened', () => {
    const t = buildTimeline([blk('a', 30, after('cue', 'school'), { endedAtMin: 1000 }), blk('b', 30, after('block', 'a'))], [school, dinner]);
    expect(entry(t, 'a')).toMatchObject({ startMin: 900, endMin: 1000 });
    expect(entry(t, 'b')!.startMin).toBe(1000);
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
    expect(buildTimeline([], [school])).toEqual({ entries: [], breaks: [], unattached: [], invalid: [] });
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

describe('buildTimeline: recharge breaks', () => {
  const typed = (id: string, durationMin: number, parent: NodeRef | null, blockType: TimelineBlock['blockType'], over: Partial<TimelineBlock> = {}) =>
    blk(id, durationMin, parent, { blockType, ...over });

  it('leaves room for a break between two deep blocks and tags it', () => {
    const t = buildTimeline(
      [typed('a', 50, after('cue', 'school'), 'deep'), typed('b', 50, after('block', 'a'), 'deep')],
      [school, dinner],
    );
    expect(t.breaks).toEqual([{ afterBlockId: 'a', cueId: 'school', startMin: 950, endMin: 960 }]);
    expect(entry(t, 'a')).toMatchObject({ startMin: 900, endMin: 950 });
    expect(entry(t, 'b')).toMatchObject({ startMin: 960, endMin: 1010, fits: true });
  });

  it('puts a long break after deep work and a short one after routine work', () => {
    const t = buildTimeline(
      [
        typed('a', 50, after('cue', 'school'), 'deep'),
        typed('r', 30, after('block', 'a'), 'routine'),
        typed('b', 50, after('block', 'r'), 'deep'),
      ],
      [school, dinner],
    );
    expect(t.breaks.map((x) => [x.afterBlockId, x.endMin - x.startMin])).toEqual([
      ['a', 10],
      ['r', 3],
    ]);
    expect(entry(t, 'r')!.startMin).toBe(960);
    expect(entry(t, 'b')!.startMin).toBe(993);
  });

  it('adds no break when the blocks have no type', () => {
    const t = buildTimeline([blk('a', 50, after('cue', 'school')), blk('b', 50, after('block', 'a'))], [school, dinner]);
    expect(t.breaks).toEqual([]);
    expect(entry(t, 'b')!.startMin).toBe(950);
  });

  it('adds no break after the last block, or next to a rest block', () => {
    const last = buildTimeline([typed('a', 50, after('cue', 'school'), 'deep')], [school, dinner]);
    expect(last.breaks).toEqual([]);
    const beforeRest = buildTimeline(
      [typed('a', 50, after('cue', 'school'), 'deep'), typed('rest', 60, after('block', 'a'), 'recharge')],
      [school, dinner],
    );
    expect(beforeRest.breaks).toEqual([]);
    expect(entry(beforeRest, 'rest')!.startMin).toBe(950);
  });

  it('drops a break that would push the next block past the next cue', () => {
    // 15:00 to 18:00 is 180 minutes. 50 + 130 fills it exactly, so a 10 minute break cannot fit.
    const t = buildTimeline(
      [typed('a', 50, after('cue', 'school'), 'deep'), typed('b', 130, after('block', 'a'), 'deep')],
      [school, dinner],
    );
    expect(t.breaks).toEqual([]);
    expect(entry(t, 'b')).toMatchObject({ startMin: 950, endMin: 1080, fits: true });
  });

  it('starts the break when the block was actually finished', () => {
    const t = buildTimeline(
      [typed('a', 50, after('cue', 'school'), 'deep', { endedAtMin: 930 }), typed('b', 50, after('block', 'a'), 'deep')],
      [school, dinner],
    );
    expect(t.breaks).toEqual([{ afterBlockId: 'a', cueId: 'school', startMin: 930, endMin: 940 }]);
    expect(entry(t, 'b')!.startMin).toBe(940);
  });
});

describe('buildTimeline: following what actually happened', () => {
  const typed = (id: string, durationMin: number, parent: NodeRef | null, blockType: TimelineBlock['blockType'], over: Partial<TimelineBlock> = {}) =>
    blk(id, durationMin, parent, { blockType, ...over });

  it('lets a running block that is past its end keep the time, pushing the blocks behind it', () => {
    // a started at 15:00 for 45 minutes; it is 16:10 and it is still going
    const t = buildTimeline(
      [blk('a', 45, after('cue', 'school'), { startedAtMin: 900 }), blk('b', 30, after('block', 'a'))],
      [school, dinner],
      { nowMin: 970 },
    );
    expect(entry(t, 'a')).toMatchObject({ startMin: 900, endMin: 970 });
    expect(entry(t, 'b')).toMatchObject({ startMin: 970, endMin: 1000 });
  });

  it('ends a running block at its planned end while there is time left on it', () => {
    const t = buildTimeline(
      [blk('a', 45, after('cue', 'school'), { startedAtMin: 900 }), blk('b', 30, after('block', 'a'))],
      [school, dinner],
      { nowMin: 920 },
    );
    expect(entry(t, 'b')!.startMin).toBe(945);
  });

  it('uses the planned end when it is not told the time', () => {
    const t = buildTimeline(
      [blk('a', 45, after('cue', 'school'), { startedAtMin: 900 }), blk('b', 30, after('block', 'a'))],
      [school, dinner],
    );
    expect(entry(t, 'b')!.startMin).toBe(945);
  });

  it('begins a block when it was really started, even if that was later than planned', () => {
    const t = buildTimeline(
      [blk('a', 45, after('cue', 'school'), { startedAtMin: 920 }), blk('b', 30, after('block', 'a'))],
      [school, dinner],
      { nowMin: 930 },
    );
    expect(entry(t, 'a')).toMatchObject({ startMin: 920, endMin: 965 });
    expect(entry(t, 'b')!.startMin).toBe(965);
  });

  it('never calls a block that has started "not fitting", but the blocks behind it give way', () => {
    // it is 18:20, a started at 15:00 and is still running past the 18:00 cue
    const t = buildTimeline(
      [blk('a', 60, after('cue', 'school'), { startedAtMin: 900 }), blk('b', 30, after('block', 'a'))],
      [school, dinner],
      { nowMin: 1100 },
    );
    expect(entry(t, 'a')).toMatchObject({ fits: true, endMin: 1100 });
    expect(entry(t, 'b')).toMatchObject({ fits: false, startMin: 1100 });
  });

  it('lifts a block that has not started to the "not before" time', () => {
    const t = buildTimeline(
      [blk('a', 30, after('cue', 'school')), blk('b', 30, after('block', 'a'))],
      [school, dinner],
      { notBeforeMin: 960 },
    );
    expect(entry(t, 'a')).toMatchObject({ startMin: 960, endMin: 990 });
    expect(entry(t, 'b')!.startMin).toBe(990);
  });

  it('leaves a block alone when "not before" is earlier than it would start anyway', () => {
    const t = buildTimeline([blk('a', 30, after('cue', 'school'))], [school, dinner], { notBeforeMin: 600 });
    expect(entry(t, 'a')!.startMin).toBe(900);
  });

  it('does not move a block that has started or finished because of "not before"', () => {
    const started = buildTimeline([blk('a', 30, after('cue', 'school'), { startedAtMin: 900 })], [school, dinner], { notBeforeMin: 960, nowMin: 910 });
    expect(entry(started, 'a')!.startMin).toBe(900);
    const finished = buildTimeline([blk('a', 30, after('cue', 'school'), { startedAtMin: 900, endedAtMin: 925 })], [school, dinner], { notBeforeMin: 960 });
    expect(entry(finished, 'a')).toMatchObject({ startMin: 900, endMin: 925 });
  });

  it('starts the break after a running block when that block really ends', () => {
    const t = buildTimeline(
      [typed('a', 45, after('cue', 'school'), 'deep', { startedAtMin: 900 }), typed('b', 45, after('block', 'a'), 'deep')],
      [school, dinner],
      { nowMin: 970 },
    );
    expect(t.breaks).toEqual([{ afterBlockId: 'a', cueId: 'school', startMin: 970, endMin: 979 }]);
    expect(entry(t, 'b')!.startMin).toBe(979);
  });

  it('adds no break in front of a block that has already started', () => {
    const t = buildTimeline(
      [typed('a', 45, after('cue', 'school'), 'deep', { startedAtMin: 900, endedAtMin: 940 }), typed('b', 45, after('block', 'a'), 'deep', { startedAtMin: 941 })],
      [school, dinner],
    );
    expect(t.breaks).toEqual([]);
    expect(entry(t, 'b')!.startMin).toBe(941);
  });
});

describe('buildTimeline: shortening everything', () => {
  const typed = (id: string, durationMin: number, parent: NodeRef | null, blockType: TimelineBlock['blockType'], over: Partial<TimelineBlock> = {}) =>
    blk(id, durationMin, parent, { blockType, ...over });

  it('shortens every block that has not started, and the break between them, by the same share', () => {
    const t = buildTimeline(
      [typed('a', 50, after('cue', 'school'), 'deep'), typed('b', 50, after('block', 'a'), 'deep')],
      [school, dinner],
      { scale: 0.8 },
    );
    // 50 -> 40 minutes each; the 10 minute break becomes 8
    expect(entry(t, 'a')).toMatchObject({ startMin: 900, endMin: 940 });
    expect(t.breaks).toEqual([{ afterBlockId: 'a', cueId: 'school', startMin: 940, endMin: 948 }]);
    expect(entry(t, 'b')).toMatchObject({ startMin: 948, endMin: 988 });
  });

  it('can make a day fit that did not', () => {
    const blocks = [blk('a', 100, after('cue', 'school')), blk('b', 100, after('block', 'a'))]; // 200 > 180 minutes
    expect(entry(buildTimeline(blocks, [school, dinner]), 'b')!.fits).toBe(false);
    expect(entry(buildTimeline(blocks, [school, dinner], { scale: 0.9 }), 'b')).toMatchObject({ fits: true, endMin: 1080 });
  });

  it('leaves a block that has started or finished at the length it really had', () => {
    const t = buildTimeline(
      [blk('a', 60, after('cue', 'school'), { startedAtMin: 900, endedAtMin: 960 }), blk('b', 60, after('block', 'a'))],
      [school, dinner],
      { scale: 0.5 },
    );
    expect(entry(t, 'a')).toMatchObject({ startMin: 900, endMin: 960 });
    expect(entry(t, 'b')).toMatchObject({ startMin: 960, endMin: 990 });
  });

  it('never shortens a block to less than a minute', () => {
    const t = buildTimeline([blk('a', 1, after('cue', 'school'))], [school, dinner], { scale: 0.1 });
    expect(entry(t, 'a')).toMatchObject({ startMin: 900, endMin: 901 });
  });

  it('does nothing when the scale is 1 or not given', () => {
    const blocks = [blk('a', 50, after('cue', 'school'))];
    expect(buildTimeline(blocks, [school, dinner], { scale: 1 })).toEqual(buildTimeline(blocks, [school, dinner]));
  });
});

describe('buildTimeline: keeping breaks', () => {
  const deep = (id: string, durationMin: number, parent: NodeRef) => blk(id, durationMin, parent, { blockType: 'deep' });

  it('drops a break that would push the next block past the cue, by default', () => {
    const t = buildTimeline([deep('a', 90, after('cue', 'school')), deep('b', 90, after('block', 'a'))], [school, dinner]);
    expect(t.breaks).toEqual([]);
    expect(entry(t, 'b')!.fits).toBe(true); // 90 + 90 = 180, exactly the time there is
  });

  it('can keep the break anyway, so the block after it shows as not fitting', () => {
    const t = buildTimeline([deep('a', 90, after('cue', 'school')), deep('b', 90, after('block', 'a'))], [school, dinner], { keepBreaks: true });
    expect(t.breaks).toHaveLength(1);
    expect(entry(t, 'b')!.fits).toBe(false);
  });
});
