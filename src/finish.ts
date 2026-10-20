// A block can only be finished early once the user has really been at it. Pressing Start is the
// commitment; this makes sure it is not followed straight away by Finish.
export const FINISH_FRACTION = 0.5;

// Half of the length the user entered (no padding), counted from when they pressed Start, not
// from when the block was planned: starting late must not make finishing easier or harder.
// `waitSec` is how long until finishing is allowed, rounded up to a whole second.
export function canFinish(
  startedAtSec: number | null,
  nowSec: number,
  durationMin: number,
): { ok: boolean; waitSec: number } {
  if (startedAtSec === null) return { ok: false, waitSec: Infinity };

  const elapsed = Math.max(0, nowSec - startedAtSec);
  const needed = Math.ceil(durationMin * 60 * FINISH_FRACTION);
  return { ok: elapsed >= needed, waitSec: Math.max(0, needed - elapsed) };
}
