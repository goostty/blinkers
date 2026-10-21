import type { Urgency } from './scheduler';
import { buildTimeline, removeFromChains, type Timeline, type TimelineBlock, type TimelineCue, type TimelineOptions } from './timeline';

// When the blocks in a chain no longer fit before the next cue, there are two ways out, and the
// user picks:
//   shorten - every block still to come, and the breaks between them, get a little shorter
//   drop    - the lowest priority blocks roll to tomorrow until the rest fit
// This works out both, so the screen can say what each would do, and applies the one the user
// chose, or the one it recommends if they have not chosen yet. It is pure.

export type FitChoice = 'shorten' | 'drop';

export interface FitMeta {
  urgency: Urgency | null; // null is a rest block the user made
  createdOn: string;
  orderIndex: number;
  committed: boolean; // the user pressed Start on it
}

export interface FitResult {
  timeline: Timeline; // the day under the option that was applied
  fits: boolean; // everything already fitted, so nothing was changed
  applied: FitChoice | null;
  recommended: FitChoice | null;
  shortenPercent: number | null; // how much shorter shortening makes everything, if it can work
  dropped: string[]; // what dropping rolls, lowest priority first (whether or not it was applied)
  scale: number; // 1 unless shortening was applied
  stillOverflowing: string[]; // blocks that do not fit and have nothing left that could give
  unfitBefore: string[]; // blocks that did not fit as the day stood, before anything was changed
}

// The form asks the user to enter about 1.5 times what they think a task takes, so a block can be
// shortened back to two thirds of its entered length and no further: that is the padding, not
// the work. A day that needs more than that is not fixed by shortening.
export const SHORTEN_FLOOR = 2 / 3;
const MAX_PERCENT = Math.floor((1 - SHORTEN_FLOOR) * 100);

const unfitOf = (t: Timeline) => t.entries.filter((e) => !e.fits);
const hasHappened = (b: TimelineBlock) => b.startedAtMin !== undefined || b.endedAtMin !== undefined;

// Lower is dropped first: rest the user made, then Q3, Q2 and Q1 last.
const RANK: Record<string, number> = { urgent: 1, important: 2, 'urgent-important': 3 };
const rankOf = (m: FitMeta | undefined) => (m ? (m.urgency === null ? 0 : (RANK[m.urgency] ?? 2)) : 2);

function findShorten(blocks: TimelineBlock[], cues: TimelineCue[], options: TimelineOptions) {
  for (let percent = 1; percent <= MAX_PERCENT; percent++) {
    const scale = 1 - percent / 100;
    const timeline = buildTimeline(blocks, cues, { ...options, scale, keepBreaks: true });
    if (unfitOf(timeline).length === 0) return { percent, scale, timeline };
  }
  return null;
}

// Takes the lowest priority block that could free the time, one at a time, until everything fits.
// Only a block at or before the first one that does not fit can help (time freed after it changes
// nothing), and one that has started is never touched. Each chain between two cues is its own
// problem, so a block in another chain is never dropped to help this one.
function findDrop(blocks: TimelineBlock[], cues: TimelineCue[], meta: Map<string, FitMeta>, options: TimelineOptions) {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const dropped: string[] = [];
  const stuck = new Set<string>(); // chains where nothing is left to drop
  let timeline = buildTimeline(blocks, cues, options);

  for (let guard = blocks.length; guard > 0; guard--) {
    const problem = unfitOf(timeline).find((e) => !stuck.has(e.cueId));
    if (!problem) break;

    const candidates = timeline.entries
      .filter((e) => e.cueId === problem.cueId && e.position <= problem.position)
      .map((e) => e.blockId)
      .filter((id) => !meta.get(id)?.committed && !hasHappened(byId.get(id)!));
    if (candidates.length === 0) {
      stuck.add(problem.cueId);
      continue;
    }

    // Dropping something that does not make the day any better (a block that is too long to ever
    // fit, say, while its neighbour is perfectly fine) would only lose work for nothing, so only
    // blocks whose removal leaves fewer problems are considered. If no single drop helps, any can.
    const problems = unfitOf(timeline).length;
    const helpful = candidates.filter(
      (id) => unfitOf(buildTimeline(removeFromChains(blocks, [...dropped, id]), cues, options)).length < problems,
    );
    const pool = helpful.length > 0 ? helpful : candidates;

    // Lowest priority first; among equals the newest goes, so older work is kept.
    pool.sort((a, b) => {
      const ma = meta.get(a);
      const mb = meta.get(b);
      return (
        rankOf(ma) - rankOf(mb) ||
        (mb?.createdOn ?? '').localeCompare(ma?.createdOn ?? '') ||
        (mb?.orderIndex ?? 0) - (ma?.orderIndex ?? 0)
      );
    });
    dropped.push(pool[0]);
    timeline = buildTimeline(removeFromChains(blocks, dropped), cues, options);
  }
  return { dropped, timeline };
}

export function resolveFit(
  blocks: TimelineBlock[],
  cues: TimelineCue[],
  meta: Map<string, FitMeta>,
  options: TimelineOptions = {},
  choice?: FitChoice,
): FitResult {
  const base = buildTimeline(blocks, cues, options);
  if (unfitOf(base).length === 0) {
    return { timeline: base, fits: true, applied: null, recommended: null, shortenPercent: null, dropped: [], scale: 1, stillOverflowing: [], unfitBefore: [] };
  }

  const unfitBefore = unfitOf(base).map((e) => e.blockId);
  const shorten = findShorten(blocks, cues, options);
  const drop = findDrop(blocks, cues, meta, options);
  const recommended: FitChoice = shorten ? 'shorten' : 'drop';
  // A chosen shortening that no longer works is not applied: the day is not left broken.
  const applied: FitChoice = choice === 'drop' ? 'drop' : choice === 'shorten' && shorten ? 'shorten' : recommended;

  if (applied === 'shorten' && shorten) {
    return {
      timeline: shorten.timeline,
      fits: false,
      applied,
      recommended,
      shortenPercent: shorten.percent,
      dropped: drop.dropped,
      scale: shorten.scale,
      stillOverflowing: [],
      unfitBefore,
    };
  }
  return {
    timeline: drop.timeline,
    fits: false,
    applied: 'drop',
    recommended,
    shortenPercent: shorten?.percent ?? null,
    dropped: drop.dropped,
    scale: 1,
    stillOverflowing: unfitOf(drop.timeline).map((e) => e.blockId),
    unfitBefore,
  };
}
