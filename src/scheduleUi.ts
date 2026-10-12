import { invoke } from '@tauri-apps/api/core';
import type { Cue } from './cues';
import type { UserProfile } from './energy';
import { assignBlocks, describeMoment, suggestionText, type BlockType } from './scheduler';

interface PendingBlock {
  id: string;
  blockType: BlockType;
  orderIndex: number;
  title: string;
}

export function todayKey(): string {
  return describeMoment(new Date()).isoDate;
}

// The schedule is recomputed from today's pending blocks every time, not stored: adding a
// block can legitimately move earlier ones (deep work claims the best cue first).
// The result goes in the header bar for now; there is no task list or timer to show it in yet.
export async function showSuggestedSlot(blockId: string, label: string) {
  try {
    const when = describeMoment(new Date());
    const [cues, profile, pending] = await Promise.all([
      invoke<Cue[]>('list_cues'),
      invoke<UserProfile>('get_profile'),
      invoke<PendingBlock[]>('list_pending_blocks', { on: when.isoDate }),
    ]);

    const assignments = assignBlocks(
      pending.map((p) => ({ id: p.id, type: p.blockType, orderIndex: p.orderIndex })),
      cues,
      profile,
      when.weekday,
      when.nowMin,
    );
    const mine = assignments.find((a) => a.blockId === blockId);
    if (!mine) return;

    const title = document.getElementById('current-task-title');
    if (title) {
      title.textContent = `${label} · ${suggestionText(mine, cues)}`;
      title.title = mine.reason;
    }
  } catch (err) {
    // A scheduling hiccup must not look like the block failed to save.
    console.error('Could not compute a suggested time:', err);
  }
}
