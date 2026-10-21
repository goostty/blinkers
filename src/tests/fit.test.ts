import { describe, expect, it } from 'vitest';
import { resolveFit, type FitMeta } from '../fit';
import type { Urgency } from '../scheduler';
import type { NodeRef, TimelineBlock, TimelineCue } from '../timeline';

const cue = (id: string, hour: number): TimelineCue => ({ id, timeMin: hour * 60 });
const school = cue('school', 15); // 15:00
const dinner = cue('dinner', 18); // 18:00, so a chain after school has 180 minutes
const cues = [school, dinner];

const after = (kind: 'cue' | 'block', id: string): NodeRef => ({ kind, id });
const blk = (id: string, durationMin: number, parent: NodeRef, over: Partial<TimelineBlock> = {}): TimelineBlock => ({
  id,
  durationMin,
  parent,
  ...over,
});

const metaFor = (entries: Record<string, Partial<FitMeta> & { urgency?: Urgency | null }>): Map<string, FitMeta> =>
  new Map(
    Object.entries(entries).map(([id, m], i) => [
      id,
      { urgency: 'important', createdOn: '2026-10-19', orderIndex: i, committed: false, ...m } as FitMeta,
    ]),
  );

describe('resolveFit: a day that already fits', () => {
  it('changes nothing and offers nothing', () => {
    const r = resolveFit([blk('a', 60, after('cue', 'school'))], cues, metaFor({ a: {} }));
    expect(r).toMatchObject({ fits: true, applied: null, recommended: null, shortenPercent: null, dropped: [], scale: 1 });
  });
});

describe('resolveFit: shortening everything', () => {
  const two = [blk('a', 100, after('cue', 'school')), blk('b', 100, after('block', 'a'))]; // 200 minutes in 180

  it('finds the smallest shortening that fits, and recommends it', () => {
    const r = resolveFit(two, cues, metaFor({ a: {}, b: {} }));
    expect(r).toMatchObject({ fits: false, recommended: 'shorten', applied: 'shorten', shortenPercent: 10, scale: 0.9 });
    expect(r.timeline.entries.every((e) => e.fits)).toBe(true);
  });

  it('shortens the breaks too', () => {
    const deep = (id: string, parent: NodeRef) => blk(id, 100, parent, { blockType: 'deep' }); // 100 + 20 break + 100
    const r = resolveFit([deep('a', after('cue', 'school')), deep('b', after('block', 'a'))], cues, metaFor({ a: {}, b: {} }));
    expect(r.shortenPercent).toBe(18);
    expect(r.timeline.breaks).toHaveLength(1);
  });

  it('is not offered when it would take blocks below two thirds of their length', () => {
    const big = [blk('a', 150, after('cue', 'school')), blk('b', 150, after('block', 'a'))]; // needs 40% off
    const r = resolveFit(big, cues, metaFor({ a: {}, b: {} }));
    expect(r.shortenPercent).toBeNull();
    expect(r.recommended).toBe('drop');
  });

  it('honours a choice to shorten when it is possible', () => {
    const r = resolveFit(two, cues, metaFor({ a: {}, b: {} }), {}, 'shorten');
    expect(r.applied).toBe('shorten');
  });

  it('falls back to what it recommends when the chosen shortening is no longer enough', () => {
    const big = [blk('a', 150, after('cue', 'school')), blk('b', 150, after('block', 'a'))];
    const r = resolveFit(big, cues, metaFor({ a: {}, b: {} }), {}, 'shorten');
    expect(r.applied).toBe('drop');
  });
});

describe('resolveFit: dropping, lowest priority first', () => {
  // x, y and z take 300 minutes in 180, which is too much to shorten away
  const three = [
    blk('x', 100, after('cue', 'school')),
    blk('y', 100, after('block', 'x')),
    blk('z', 100, after('block', 'y')),
  ];

  it('drops urgent-but-unimportant before important, and important before urgent and important', () => {
    const r = resolveFit(three, cues, metaFor({ x: { urgency: 'urgent-important' }, y: { urgency: 'urgent' }, z: { urgency: 'important' } }));
    expect(r.applied).toBe('drop');
    expect(r.dropped).toEqual(['y', 'z']);
    expect(r.timeline.entries.map((e) => e.blockId)).toEqual(['x']);
  });

  it('can drop a block earlier in the chain when that is what frees the time', () => {
    const r = resolveFit(
      [blk('a', 100, after('cue', 'school')), blk('b', 100, after('block', 'a'))],
      cues,
      metaFor({ a: { urgency: 'urgent' }, b: { urgency: 'urgent-important' } }),
      {},
      'drop',
    );
    expect(r.dropped).toEqual(['a']);
    expect(r.timeline.entries.map((e) => [e.blockId, e.fits])).toEqual([['b', true]]);
  });

  it('drops rest the user made before any work', () => {
    const r = resolveFit(
      [blk('a', 100, after('cue', 'school')), blk('rest', 100, after('block', 'a'))],
      cues,
      metaFor({ a: { urgency: 'urgent' }, rest: { urgency: null } }),
      {},
      'drop',
    );
    expect(r.dropped).toEqual(['rest']);
  });

  it('keeps older work and drops the newer block when two are equally important', () => {
    const r = resolveFit(
      [blk('old', 100, after('cue', 'school')), blk('new', 100, after('block', 'old'))],
      cues,
      metaFor({ old: { urgency: 'urgent', createdOn: '2026-10-10' }, new: { urgency: 'urgent', createdOn: '2026-10-19' } }),
      {},
      'drop',
    );
    expect(r.dropped).toEqual(['new']);
  });

  it('never drops a block that has started', () => {
    const r = resolveFit(
      [blk('a', 100, after('cue', 'school'), { startedAtMin: 900 }), blk('b', 100, after('block', 'a'))],
      cues,
      metaFor({ a: { urgency: 'urgent', committed: true }, b: { urgency: 'urgent-important' } }),
      { nowMin: 910 },
      'drop',
    );
    expect(r.dropped).toEqual(['b']);
  });

  it('reports a block that still does not fit when nothing that could give is left', () => {
    // b is marked as committed (it cannot be dropped) but the timeline has no start for it
    const r = resolveFit(
      [blk('a', 100, after('cue', 'school')), blk('b', 100, after('block', 'a'))],
      cues,
      metaFor({ a: { committed: true }, b: { committed: true } }),
      {},
      'drop',
    );
    expect(r.dropped).toEqual([]);
    expect(r.stillOverflowing).toEqual(['b']);
  });

  it('only drops from the chain that does not fit', () => {
    const r = resolveFit(
      [
        blk('a', 100, after('cue', 'school')),
        blk('b', 100, after('block', 'a')),
        blk('c', 30, after('cue', 'dinner')),
      ],
      cues,
      metaFor({ a: { urgency: 'urgent' }, b: { urgency: 'urgent' }, c: { urgency: null } }),
      {},
      'drop',
    );
    expect(r.dropped).toEqual(['b']); // not c, which is lower priority but in another chain
  });

  it('still reports what dropping would do when shortening is what gets applied', () => {
    const r = resolveFit(
      [blk('a', 100, after('cue', 'school')), blk('b', 100, after('block', 'a'))],
      cues,
      metaFor({ a: { urgency: 'urgent' }, b: { urgency: 'important' } }),
    );
    expect(r.applied).toBe('shorten');
    expect(r.dropped).toEqual(['a']);
  });
});

describe('resolveFit: which blocks did not fit to begin with', () => {
  it('names them, so a block dropped only to make room can be told apart', () => {
    const r = resolveFit(
      [blk('a', 100, after('cue', 'school')), blk('b', 100, after('block', 'a'))],
      cues,
      metaFor({ a: { urgency: 'urgent' }, b: { urgency: 'urgent-important' } }),
      {},
      'drop',
    );
    expect(r.unfitBefore).toEqual(['b']);
    expect(r.dropped).toEqual(['a']);
  });

  it('is empty when everything fits', () => {
    expect(resolveFit([blk('a', 60, after('cue', 'school'))], cues, metaFor({ a: {} })).unfitBefore).toEqual([]);
  });
});

describe('resolveFit: only dropping what helps', () => {
  it('does not drop a block whose removal frees nothing the problem block can use', () => {
    // b is longer than the whole window, so dropping a (equal priority) would change nothing for it
    const r = resolveFit(
      [blk('a', 30, after('cue', 'school')), blk('b', 400, after('block', 'a'))],
      cues,
      metaFor({ a: { orderIndex: 5 }, b: { orderIndex: 1 } }), // a is "newer", so a is dropped first unless it is ruled out
    );
    expect(r.applied).toBe('drop');
    expect(r.dropped).toEqual(['b']);
    expect(r.timeline.entries.map((e) => e.blockId)).toEqual(['a']);
  });

  it('still drops several blocks in priority order when no single drop is enough', () => {
    // x, y and z are 100 each in 180: y alone helps, then z
    const r = resolveFit(
      [blk('x', 100, after('cue', 'school')), blk('y', 100, after('block', 'x')), blk('z', 100, after('block', 'y'))],
      cues,
      metaFor({ x: { urgency: 'urgent-important' }, y: { urgency: 'urgent' }, z: { urgency: 'important' } }),
    );
    expect(r.dropped).toEqual(['y', 'z']);
  });
});
