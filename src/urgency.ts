import type { Result } from './cues';
import type { BlockType, Urgency } from './scheduler';

// The picker's four choices, worded as what to do about the task rather than as quadrant jargon.
export const URGENCY_OPTIONS: { value: Urgency; label: string; hint: string }[] = [
  { value: 'urgent-important', label: 'Do now', hint: 'Urgent and important' },
  { value: 'important', label: 'Schedule', hint: 'Important, not urgent' },
  { value: 'urgent', label: 'Quick', hint: 'Urgent, not important' },
  { value: 'neither', label: 'Drop?', hint: 'Neither urgent nor important' },
];

// Rest blocks are never ranked against each other, so only work is classified.
export function needsUrgency(type: BlockType): boolean {
  return type === 'deep' || type === 'routine';
}

// A work block cannot be saved without an urgency: the scheduler's cap and reserve only mean
// something if every work block has a quadrant. A rest block always resolves to null, even when
// a quadrant was picked on the Deep tab before switching, so a stale pick never reaches the
// database (which would refuse it).
export function resolveUrgency(type: BlockType, picked: string | null): Result<Urgency | null> {
  if (!needsUrgency(type)) return { ok: true, value: null };
  if (picked === null) return { ok: false, error: 'Pick how urgent and important this is.' };
  const option = URGENCY_OPTIONS.find((o) => o.value === picked);
  if (!option) return { ok: false, error: 'Pick how urgent and important this is.' };
  return { ok: true, value: option.value };
}
