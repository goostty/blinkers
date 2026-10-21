import type { BlockType } from './scheduler';

// Recharge breaks are never stored. They are worked out from a chain every time the day is
// built, so nothing can go stale when a block is moved, rolled or removed. This module only
// says how long each break is; timeline.ts decides where the time goes.

export interface ChainItem {
  id: string;
  blockType: BlockType;
  durationMin: number;
}

// A break is a share of the effort just spent, within limits: a short block still needs a
// real pause, and a very long one does not need a very long one.
const RULES: Partial<Record<BlockType, { share: number; minMin: number; maxMin: number }>> = {
  deep: { share: 0.2, minMin: 5, maxMin: 20 },
  routine: { share: 0.1, minMin: 3, maxMin: 10 },
};

const isWork = (type: BlockType) => RULES[type] !== undefined;

// Rest blocks earn no break, and neither does a bad duration (timeline.ts already reports
// that block, so it is not reported twice).
export function breakMinutes(blockType: BlockType, durationMin: number): number {
  const rule = RULES[blockType];
  if (!rule || !Number.isInteger(durationMin) || durationMin < 1) return 0;
  return Math.min(rule.maxMin, Math.max(rule.minMin, Math.round(durationMin * rule.share)));
}

// A break length follows the block before it, because it exists to recover from the effort
// that just happened. It sits only between two work blocks: none after the last block of a
// chain, and none next to a rest block, so a recharge the user made is not doubled up.
export function breaksAfter(chain: ChainItem[]): Map<string, number> {
  const result = new Map<string, number>();
  for (let i = 0; i < chain.length - 1; i++) {
    const current = chain[i];
    const next = chain[i + 1];
    if (!isWork(current.blockType) || !isWork(next.blockType)) continue;
    const minutes = breakMinutes(current.blockType, current.durationMin);
    if (minutes > 0) result.set(current.id, minutes);
  }
  return result;
}
