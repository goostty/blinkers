import { cueRunsOn, formatClock, type Cue, type Result, type Weekday } from './cues';
import type { DayBlock, DayPlan } from './dayPlan';
import type { BlockType, Urgency } from './scheduler';

// What a block can be attached to, as the backend expects it (ParentRef in containers.rs).
export interface ParentChoice {
  kind: 'cue' | 'block';
  id: string;
}

export interface AttachOption {
  value: string; // 'cue:<id>' or 'block:<id>', the form of the <select> values
  label: string;
}

const TYPE_LABEL: Record<BlockType, string> = {
  deep: 'Deep work',
  routine: 'Routine',
  reset: 'Reset',
  recharge: 'Recharge',
};

// Every spot a new block could go today: each cue that runs today (except an end-of-day cue,
// which cannot hold blocks), each followed by the blocks already in its chain, in order. A block
// with no place today (waiting to be attached, moved to tomorrow, advised to drop) is left out,
// since nothing can follow something that is not in the day.
export function attachOptions(
  cues: Cue[],
  blocks: DayBlock[],
  plan: DayPlan,
  weekday: Weekday,
  isoDate?: string,
): AttachOption[] {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const options: AttachOption[] = [];

  const today = { isoDate: isoDate ?? '', weekday };
  const todays = cues.filter((c) => cueRunsOn(c, today) && !c.endsDay).sort((a, b) => a.timeMin - b.timeMin);
  for (const cue of todays) {
    options.push({ value: `cue:${cue.id}`, label: `After ${cue.label} · ${formatClock(cue.timeMin)}` });

    const chain = plan.placements
      .filter((p) => p.kind === 'placed' && p.cueId === cue.id)
      .sort((a, b) => a.startMin! - b.startMin!);
    for (const p of chain) {
      const block = byId.get(p.blockId)!;
      const name = block.title.trim() || TYPE_LABEL[block.blockType];
      options.push({ value: `block:${p.blockId}`, label: `    then after "${name}" · ends ${formatClock(p.endMin!)}` });
    }
  }
  return options;
}

export function parseAttach(value: string): ParentChoice | null {
  const split = value.indexOf(':');
  if (split < 0) return null;
  const kind = value.slice(0, split);
  const id = value.slice(split + 1);
  if ((kind !== 'cue' && kind !== 'block') || id === '') return null;
  return { kind, id };
}

// Every block has to say what it follows, because nothing is scheduled by guessing. The one
// exception is a block advised to drop (Q4): it is not part of the day, so a choice picked before
// switching to Q4 is ignored rather than sent.
export function resolveAttach(urgency: Urgency | null, picked: string): Result<ParentChoice | null> {
  if (urgency === 'neither') return { ok: true, value: null };
  const parent = parseAttach(picked);
  if (!parent) return { ok: false, error: 'Pick what this block follows.' };
  return { ok: true, value: parent };
}

const MAX_DURATION_MIN = 1440;

// The length is typed in, in whole minutes, and used exactly as entered: padding a deep-work
// estimate is up to the user (the form tells them to), so nothing is multiplied here.
export function resolveDuration(text: string): Result<number> {
  const trimmed = text.trim();
  const minutes = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_DURATION_MIN) {
    return { ok: false, error: `Enter the length in whole minutes, from 1 to ${MAX_DURATION_MIN}.` };
  }
  return { ok: true, value: minutes };
}
