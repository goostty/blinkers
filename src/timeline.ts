// A day is a linked list: a cue (a fixed moment) is the head, and blocks hang off it one after
// another until the next cue. Each block stores only what it follows (`parent`); this module
// walks those links and works out when everything starts and ends.
//
//   cue 15:00 ──► deep 45m ──► routine 30m ──► rest 20m      cue 18:00 ──► ...
//
// It is pure: nothing here reads the clock or the database.

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
  endedAtMin?: number; // when the user finished it, if they did
}

export interface TimelineEntry {
  blockId: string;
  cueId: string; // the cue at the head of this block's chain
  position: number; // 0 = the block straight after the cue
  startMin: number;
  endMin: number;
  fits: boolean; // false = it would run past the next cue (or midnight)
}

export interface TimelineProblem {
  blockId: string;
  reason: string;
}

export interface Timeline {
  entries: TimelineEntry[];
  unattached: string[];
  invalid: TimelineProblem[];
}

const DAY = 1440;
const key = (ref: NodeRef) => `${ref.kind}:${ref.id}`;

// Time only ever moves forward through a chain, and the clock is what moves it: a block
// starts when the one before it ends. If the user finishes a block early, everything after it
// is pulled forward (and may now fit when it did not before). Starting late or running over
// never pushes the next block back, because the app moves on anyway. The next cue is fixed,
// so a chain that no longer fills its gap simply leaves free time before that cue.
// Anything that cannot be placed is reported instead of guessed at: a bad link must never hide
// a block or hang the planner.
export function buildTimeline(blocks: TimelineBlock[], cues: TimelineCue[]): Timeline {
  const sortedCues = [...cues].sort((a, b) => a.timeMin - b.timeMin);
  const cueIds = new Set(sortedCues.map((c) => c.id));
  const blockById = new Map(blocks.map((b) => [b.id, b]));

  const unattached: string[] = [];
  const problems = new Map<string, string>();
  const reached = new Set<string>();
  const entries: TimelineEntry[] = [];

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

      const startMin = cursor;
      const plannedEnd = startMin + node.durationMin;
      const endMin =
        node.endedAtMin === undefined ? plannedEnd : Math.max(startMin, Math.min(plannedEnd, node.endedAtMin));

      entries.push({
        blockId: node.id,
        cueId: cue.id,
        position: position++,
        startMin,
        endMin,
        fits: plannedEnd <= limit,
      });

      cursor = endMin;
      node = nextAfter({ kind: 'block', id: node.id });
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

  return {
    entries,
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
