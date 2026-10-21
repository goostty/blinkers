import type { BlockType } from './scheduler';

// Reads what a block's name and type say about where it belongs in the day. It is pure and
// works offline: a short list of words, no model. Anything it does not recognise is simply
// "no window", never a guess, because a wrong window hides good slots while a missing one only
// loses a tie-breaker.

export type WindowName = 'morning' | 'afternoon' | 'evening';
export type EnergyNeed = 'High' | 'Medium' | 'Low';

export interface TimeWindow {
  name: WindowName;
  startMin: number; // minutes since local midnight
  endMin: number;
}

export interface NameHints {
  window: TimeWindow | null;
  energyNeed: EnergyNeed;
}

const WINDOWS: Record<WindowName, TimeWindow> = {
  morning: { name: 'morning', startMin: 5 * 60, endMin: 12 * 60 },
  afternoon: { name: 'afternoon', startMin: 12 * 60, endMin: 17 * 60 },
  evening: { name: 'evening', startMin: 17 * 60, endMin: 22 * 60 },
};

// Single words only (matching is by whole word). Negation such as "not morning" is not
// understood: that is a known limit of word lists.
const WORDS: Record<string, WindowName> = {
  morning: 'morning',
  breakfast: 'morning',
  sunrise: 'morning',
  wake: 'morning',
  afternoon: 'afternoon',
  evening: 'evening',
  dinner: 'evening',
  night: 'evening',
  bedtime: 'evening',
};

// Deep work is the most demanding, rest the least. Same words describeEnergy() uses, so a need
// can be compared with a slot's energy directly.
const ENERGY_BY_TYPE: Record<BlockType, EnergyNeed> = {
  deep: 'High',
  routine: 'Medium',
  reset: 'Low',
  recharge: 'Low',
};

export function readNameHints(title: string, type: BlockType): NameHints {
  const found = new Set<WindowName>();
  for (const word of title.toLowerCase().split(/[^a-z]+/)) {
    const name = WORDS[word];
    if (name) found.add(name);
  }
  // Two different times in one name means the name does not pick one.
  const window = found.size === 1 ? WINDOWS[[...found][0]] : null;
  return { window, energyNeed: ENERGY_BY_TYPE[type] };
}
