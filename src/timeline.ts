// A day is a linked list: a cue (a fixed moment) is the head, and blocks hang off it one after
// another until the next cue. Each block stores only what it follows (`parent`); this module
// walks those links and works out when everything starts and ends.
//
//   cue 15:00 ──► deep 45m ──► routine 30m ──► rest 20m      cue 18:00 ──► ...
//
// Between two work blocks the walk also leaves room for a recharge break (see breaks.ts). A break
// is not a block: it is never stored, only worked out here, so it cannot go stale.
//
//   cue 15:00 ──► deep 50m ──► recharge 10m ──► routine 30m ──► recharge 3m ──► deep 50m
//
// Times are projections, not appointments: block lengths are estimates, so the plan follows what
// has actually happened. A finished block ends when it was finished, a started block began when it
// was started and, while it is still running, ends no earlier than now. The current time is passed
// in, so this stays pure: nothing here reads the clock or the database.
import { breaksAfter } from './breaks';
import type { BlockType } from './scheduler';

export type NodeRef = { kind: 'cue'; id: string } | { kind: 'block'; id: string };

// `timeMin` is minutes since local midnight. Pass only the cues that run on the day being
// planned. `endsDay` marks a cue like "bedtime": the chain before it stops there, and it cannot
// hold blocks itself.
export interface TimelineCue {
  id: string;
  timeMin: number;
  endsDay?: boolean;
}

export interface TimelineBlock {
  id: string;
  durationMin: number; // as the user entered it; deep work is padded by the user, not here
  parent: NodeRef | null; // null = not attached yet
  startedAtMin?: number; // when the user pressed Start, if they did
  endedAtMin?: number; // when the user finished it, if they did
  blockType?: BlockType; // without it the block earns no recharge break, and is not one to wait for
}

export interface TimelineEntry {
  blockId: string;
  cueId: string; // the cue at the head of this block's chain
  position: number; // 0 = the block straight after the cue
  startMin: number;
  endMin: number;
  fits: boolean; // false = it would run past the next cue (or midnight)
}

// A recharge break placed after a block. It always fits: a break that would push the next block
// past the next cue is not placed at all.
export interface TimelineBreak {
  afterBlockId: string;
  cueId: string;
  startMin: number;
  endMin: number;
}

export interface TimelineProblem {
  blockId: string;
  reason: string;
}

export interface Timeline {
  entries: TimelineEntry[];
  breaks: TimelineBreak[];
  unattached: string[];
  invalid: TimelineProblem[];
}

const DAY = 1440;

// Minutes of recharge between a block and the one after it, 0 when either has no type.
function breakAfter(block: TimelineBlock, next: TimelineBlock | undefined): number {
  if (!next || !block.blockType || !next.blockType) return 0;
  const chain = [block, next].map((b) => ({ id: b.id, blockType: b.blockType!, durationMin: b.durationMin }));
  return breaksAfter(chain).get(block.id) ?? 0;
}

const hasHappened = (b: TimelineBlock) => b.startedAtMin !== undefined || b.endedAtMin !== undefined;

// A length shortened by the scale, to whole minutes and never under one. 0 stays 0 (no break).
const scaled = (minutes: number, options: TimelineOptions) =>
  minutes > 0 && options.scale !== undefined && options.scale < 1 ? Math.max(1, Math.round(minutes * options.scale)) : minutes;

// What has happened keeps the length it really had; only a block still to come can be shortened.
const lengthOf = (b: TimelineBlock, options: TimelineOptions) => (hasHappened(b) ? b.durationMin : scaled(b.durationMin, options));

const key = (ref: NodeRef) => `${ref.kind}:${ref.id}`;

// Time only ever moves forward through a chain, and the clock is what moves it: a block
// starts when the one before it ends. If the user finishes a block early, everything after it
// is pulled forward (and may now fit when it did not before). Starting late or running over
// never pushes the next block back, because the app moves on anyway. The next cue is fixed,
// so a chain that no longer fills its gap simply leaves free time before that cue.
// Anything that cannot be placed is reported instead of guessed at: a bad link must never hide
// a block or hang the planner.
// `nowMin` lets a running block keep the time it is really using. `notBeforeMin` is the earliest a
// block that has not started may begin: set when the day is re-planned after a decision, so
// nothing is ever placed in the past. Neither moves a block that has already started or finished.
//
// `scale` (for example 0.8) shortens every block that has not started, and the breaks between
// them, by the same share. It is how "shorten everything" is planned; 1 or nothing leaves lengths
// as entered.
export interface TimelineOptions {
  nowMin?: number;
  notBeforeMin?: number;
  scale?: number;
  // Put a break in even when it pushes the next block past the cue, which then shows as not
  // fitting. Shortening needs this: it must shrink the breaks, not quietly remove them.
  keepBreaks?: boolean;
}

export function buildTimeline(blocks: TimelineBlock[], cues: TimelineCue[], options: TimelineOptions = {}): Timeline {
  const sortedCues = [...cues].sort((a, b) => a.timeMin - b.timeMin);
  const cueIds = new Set(sortedCues.map((c) => c.id));
  const blockById = new Map(blocks.map((b) => [b.id, b]));

  const unattached: string[] = [];
  const problems = new Map<string, string>();
  const reached = new Set<string>();
  const entries: TimelineEntry[] = [];
  const breaks: TimelineBreak[] = [];

  const children = new Map<string, TimelineBlock[]>();
  for (const b of blocks) {
    if (b.parent === null) {
      unattached.push(b.id);
      continue;
    }
    const k = key(b.parent);
    children.set(k, [...(children.get(k) ?? []), b]);
  }

  // The first block listed continues the chain; a list has only one "next", so any other
  // claimant is reported.
  const nextAfter = (ref: NodeRef): TimelineBlock | undefined => {
    const [first, ...rest] = children.get(key(ref)) ?? [];
    for (const extra of rest) problems.set(extra.id, 'Another block already follows the same one.');
    return first;
  };

  sortedCues.forEach((cue, i) => {
    if (cue.endsDay) {
      for (const b of children.get(key({ kind: 'cue', id: cue.id })) ?? []) {
        problems.set(b.id, 'An end-of-day cue cannot hold blocks.');
      }
      return;
    }

    const limit = sortedCues[i + 1]?.timeMin ?? DAY;
    let cursor = cue.timeMin;
    let position = 0;
    let node = nextAfter({ kind: 'cue', id: cue.id });

    while (node) {
      reached.add(node.id);
      if (!Number.isInteger(node.durationMin) || node.durationMin < 1) {
        problems.set(node.id, 'Its duration must be a whole number of minutes, at least 1.');
        break;
      }

      const happened = hasHappened(node);
      const startMin = node.startedAtMin ?? (happened ? cursor : Math.max(cursor, options.notBeforeMin ?? 0));
      const plannedEnd = startMin + lengthOf(node, options);
      // What happened wins over the estimate: a finished block ends when it was finished, even
      // if late, and one that is still running ends no earlier than now.
      const endMin =
        node.endedAtMin !== undefined
          ? Math.max(startMin, node.endedAtMin)
          : node.startedAtMin !== undefined
            ? Math.max(plannedEnd, options.nowMin ?? plannedEnd)
            : plannedEnd;

      entries.push({
        blockId: node.id,
        cueId: cue.id,
        position: position++,
        startMin,
        endMin,
        // Something that already happened cannot be moved, so it always counts as fitting; the
        // blocks behind it are the ones that give way.
        fits: happened || plannedEnd <= limit,
      });

      // The break follows the block just done. The cues are fixed commitments, so a break only
      // takes the time if the next block still fits before the next cue with it in front. A block
      // that has already started has its time fixed, so nothing is put in front of it.
      const next = nextAfter({ kind: 'block', id: node.id });
      const breakMin = next && !hasHappened(next) ? scaled(breakAfter(node, next), options) : 0;
      const nextStart = Math.max(endMin + breakMin, options.notBeforeMin ?? 0);
      if (next && breakMin > 0 && (options.keepBreaks || nextStart + lengthOf(next, options) <= limit)) {
        breaks.push({ afterBlockId: node.id, cueId: cue.id, startMin: endMin, endMin: endMin + breakMin });
        cursor = endMin + breakMin;
      } else {
        cursor = endMin;
      }
      node = next;
    }
  });

  // Whatever the walk did not reach hangs off something that is missing, unattached or loops.
  for (const b of blocks) {
    if (b.parent === null || reached.has(b.id) || problems.has(b.id)) continue;
    if (b.parent.kind === 'cue' && !cueIds.has(b.parent.id)) {
      problems.set(b.id, 'Its cue does not run on this day.');
    } else if (b.parent.kind === 'block' && !blockById.has(b.parent.id)) {
      problems.set(b.id, 'The block it follows is missing.');
    } else if (b.parent.kind === 'block' && blockById.get(b.parent.id)?.parent === null) {
      problems.set(b.id, 'The block it follows is not attached yet.');
    } else {
      problems.set(b.id, 'Its chain is broken or loops back on itself.');
    }
  }

  entries.sort((a, b) => a.startMin - b.startMin || a.position - b.position);
  breaks.sort((a, b) => a.startMin - b.startMin);

  return {
    entries,
    breaks,
    unattached,
    invalid: [...problems].map(([blockId, reason]) => ({ blockId, reason })),
  };
}

// Takes blocks out of their chains (rolled to tomorrow, advised to drop) and closes the gap:
// whatever followed a removed block now follows whatever the removed block followed, so the
// blocks after it move up. The input is left alone. Removed blocks that follow each other are
// all skipped; the step limit only exists so a corrupt loop of removed blocks cannot hang this.
export function removeFromChains(blocks: TimelineBlock[], removedIds: Iterable<string>): TimelineBlock[] {
  const removed = new Set(removedIds);
  const byId = new Map(blocks.map((b) => [b.id, b]));

  return blocks
    .filter((b) => !removed.has(b.id))
    .map((b) => {
      let parent = b.parent;
      let steps = blocks.length;
      while (parent && parent.kind === 'block' && removed.has(parent.id) && byId.has(parent.id) && steps-- > 0) {
        parent = byId.get(parent.id)!.parent;
      }
      return parent === b.parent ? b : { ...b, parent };
    });
}
