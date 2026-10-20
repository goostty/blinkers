// The header has room for one block, but a day has several. This picks the one that matters now.
export interface FocusCommitment {
  blockId: string;
  status: string;
  startMin: number; // minutes since local midnight
  durationMin: number;
}

// Lower rank is shown first. Over or unknown statuses have no rank and are never shown.
const RANK: Record<string, number> = { started: 0, nagging: 1, planned: 2 };

// A started block always wins, even after its time is up: it is the commitment in progress and
// still needs Finish or Lapse. After that comes a block whose reminder has gone out (it is
// waiting on the user), then the next one that has not been reminded yet. A planned or nagging
// block whose window has already passed is skipped: it is about to be marked missed, and until
// something does that it would otherwise sit in the header all day.
export function pickFocus(commitments: FocusCommitment[], nowMin: number): string | null {
  const shown = commitments.filter((c) => {
    if (!(c.status in RANK)) return false;
    return c.status === 'started' || c.startMin + c.durationMin > nowMin;
  });

  shown.sort(
    (a, b) =>
      RANK[a.status] - RANK[b.status] ||
      a.startMin - b.startMin ||
      (a.blockId < b.blockId ? -1 : a.blockId > b.blockId ? 1 : 0),
  );
  return shown[0]?.blockId ?? null;
}

// With nothing in progress or coming up, a block that was missed is what needs the user. The
// earliest comes first so they are dealt with in the order they happened. The caller passes only
// blocks that are still alive: one that was dropped is not in the list, so it never comes back.
export function pickMissed(commitments: FocusCommitment[]): string | null {
  const missed = commitments
    .filter((c) => c.status === 'missed')
    .sort((a, b) => a.startMin - b.startMin || (a.blockId < b.blockId ? -1 : a.blockId > b.blockId ? 1 : 0));
  return missed[0]?.blockId ?? null;
}
