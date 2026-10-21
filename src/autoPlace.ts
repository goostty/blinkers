import type { ParentChoice } from './attach';
import type { Cue, Weekday } from './cues';
import { planDay, type DayBlock } from './dayPlan';
import type { UserProfile } from './energy';
import { priorityOf, suggestSlot } from './suggest';

// Placing blocks is the app's job: the user says what to do and for how long, and the app decides
// where it goes, including the first block after a cue. This picks the next waiting block it can
// place, one at a time. After each placement the day is planned again, because every block that
// goes in changes what room is left for the next one.

export interface AutoPlaceInput {
  blocks: DayBlock[]; // everything on today's list
  cues: Cue[];
  weekday: Weekday;
  isoDate: string;
  nowMin: number;
  profile: UserProfile;
  skip: Set<string>; // blocks already tried this round, so a refusal can never loop
}

export interface AutoPlacement {
  blockId: string;
  parent: ParentChoice;
}

// Most urgent first, so a Q3 block cannot take the room a Q1 block needed. Rest blocks the user
// made come last. Among equals the older block goes first, as everywhere else.

export function nextToPlace(input: AutoPlaceInput): AutoPlacement | null {
  const { blocks, cues, weekday, isoDate, nowMin, profile, skip } = input;

  // Fixing is switched off for the same reason as in suggest.ts: placing a block must never be
  // allowed to reshape the day.
  const plan = planDay(blocks, cues, weekday, isoDate, { fit: 'off' });
  const waitingIds = new Set(plan.placements.filter((p) => p.kind === 'unattached').map((p) => p.blockId));

  const waiting = blocks
    .filter((b) => waitingIds.has(b.id) && !skip.has(b.id))
    .sort((a, b) => priorityOf(a.urgency) - priorityOf(b.urgency) || a.createdOn.localeCompare(b.createdOn) || a.orderIndex - b.orderIndex);

  for (const block of waiting) {
    const suggestion = suggestSlot({
      block: { blockType: block.blockType, urgency: block.urgency, durationMin: block.durationMin, title: block.title },
      blocks: blocks.filter((b) => b.id !== block.id), // it must not count against itself
      cues,
      weekday,
      isoDate,
      nowMin,
      profile,
    });
    if (suggestion.kind === 'slot') return { blockId: block.id, parent: suggestion.parent };
  }
  return null;
}
