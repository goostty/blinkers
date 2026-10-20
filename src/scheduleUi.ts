import { invoke } from '@tauri-apps/api/core';
import { attachOptions, parseAttach, type AttachOption } from './attach';
import type { Cue, Weekday } from './cues';
import { placementText, planDay, type DayBlock, type DayPlan } from './dayPlan';
import { describeMoment } from './scheduler';

export function todayKey(): string {
  return describeMoment(new Date()).isoDate;
}

export interface LoadedDay {
  isoDate: string;
  weekday: Weekday;
  cues: Cue[];
  blocks: DayBlock[];
  dayPlan: DayPlan;
}

// Whoever shows the day (the Today list) is told each time it has been planned again.
const dayListeners: Array<(day: LoadedDay) => void> = [];
export function onDayRefreshed(listener: (day: LoadedDay) => void) {
  dayListeners.push(listener);
}

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

// Loads today's cues and blocks, works out the day, and saves it as commitments (what reminders
// will fire against). It runs whenever the app starts or a block is made, not on a timer, so the
// plan is always the user's latest links applied to the day's rules.
async function planToday(): Promise<LoadedDay> {
  const when = describeMoment(new Date());
  const [cues, blocks] = await Promise.all([
    invoke<Cue[]>('list_cues'),
    invoke<DayBlock[]>('list_day_blocks', { on: when.isoDate }),
  ]);

  const dayPlan = planDay(blocks, cues, when.weekday, when.isoDate);

  // Saving the plan failing must not hide what the user is waiting to see.
  try {
    await invoke('sync_commitments', { on: when.isoDate, plan: dayPlan.plan });
  } catch (err) {
    console.error('Could not save the plan:', err);
  }

  return { isoDate: when.isoDate, weekday: when.weekday, cues, blocks, dayPlan };
}

function fillOptions(select: HTMLSelectElement, options: AttachOption[], placeholder: string) {
  const previous = select.value;
  select.replaceChildren();

  const first = document.createElement('option');
  first.value = '';
  first.textContent = placeholder;
  select.append(first);

  for (const option of options) {
    const node = document.createElement('option');
    node.value = option.value;
    node.textContent = option.label;
    select.append(node);
  }
  // Keep what the user already picked, as long as it is still a valid spot.
  if (options.some((o) => o.value === previous)) select.value = previous;
}

// Blocks with no place today (carried over from an earlier day, or whose parent was dropped) wait
// here for the user to say what they follow. Nothing places them automatically.
function renderUnattached(day: LoadedDay, options: AttachOption[]) {
  const section = el('unattached-section');
  const list = el('unattached-list');
  if (!section || !list) return;

  const waiting = day.dayPlan.placements.filter((p) => p.kind === 'unattached');
  list.replaceChildren();
  section.hidden = waiting.length === 0;

  // Blocks waiting for a place are easy to miss inside a tab, so the header says when some wait.
  const button = el('btn-place');
  if (button) {
    button.hidden = waiting.length === 0;
    button.textContent = `${waiting.length} to place`;
  }

  for (const p of waiting) {
    const block = day.blocks.find((b) => b.id === p.blockId)!;
    const row = document.createElement('li');
    row.className = 'flex flex-col gap-2 p-3 bg-slate-900 border border-slate-800 rounded-lg';

    const name = document.createElement('span');
    name.className = 'text-sm font-medium text-slate-100 truncate';
    name.textContent = `${block.title.trim() || 'Untitled block'} · ${block.durationMin} min`;

    const controls = document.createElement('div');
    controls.className = 'flex gap-2';

    const select = document.createElement('select');
    select.className =
      'flex-1 min-w-0 bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500 [color-scheme:dark]';
    fillOptions(select, options, 'Pick what it follows…');

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Attach';
    button.className =
      'cursor-pointer shrink-0 px-3 py-2 text-sm font-semibold text-slate-100 bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors';

    const error = document.createElement('p');
    error.hidden = true;
    error.className = 'text-xs text-rose-400';

    button.addEventListener('click', async () => {
      const parent = parseAttach(select.value);
      if (!parent) {
        error.textContent = 'Pick what this block follows.';
        error.hidden = false;
        return;
      }
      try {
        await invoke('attach_block', { blockId: block.id, parent, on: day.isoDate });
      } catch (err) {
        error.textContent = typeof err === 'string' ? err : 'Could not attach that block.';
        error.hidden = false;
        return;
      }
      await refreshDay();
    });

    // A block can be given up from the queue too, so one that is no longer wanted never has to be
    // placed first. The same action as Drop in the Today list: the block is dropped, not deleted.
    const drop = document.createElement('button');
    drop.type = 'button';
    drop.textContent = 'Drop';
    drop.title = 'Remove this block from today';
    drop.className =
      'cursor-pointer shrink-0 px-3 py-2 text-sm font-semibold text-slate-300 bg-slate-800 hover:bg-rose-600 hover:text-slate-100 rounded-lg transition-colors';
    drop.addEventListener('click', async () => {
      try {
        await invoke('dismiss_block', { blockId: block.id });
      } catch (err) {
        error.textContent = typeof err === 'string' ? err : 'Could not drop that block.';
        error.hidden = false;
        return;
      }
      await refreshDay();
    });

    controls.append(select, button, drop);
    row.append(name, controls, error);
    list.append(row);
  }
}

// Re-plans today and brings the screen in line: the "follows" choices in the new-block form and
// the list of blocks still waiting for a place.
export async function refreshDay(): Promise<LoadedDay | null> {
  try {
    const day = await planToday();
    const options = attachOptions(day.cues, day.blocks, day.dayPlan, day.weekday, day.isoDate);

    const select = el<HTMLSelectElement>('block-attach');
    if (select) fillOptions(select, options, 'Pick what it follows…');
    renderUnattached(day, options);
    dayListeners.forEach((listener) => listener(day));
    return day;
  } catch (err) {
    console.error('Could not plan the day:', err);
    return null;
  }
}

// The result goes in the header bar for now; there is no task list or timer to show it in yet.
export async function showSuggestedSlot(blockId: string, label: string) {
  // A planning hiccup must not look like the block failed to save.
  const day = await refreshDay();
  if (!day) return;

  const mine = day.dayPlan.placements.find((p) => p.blockId === blockId);
  if (!mine) return;

  const title = el('current-task-title');
  if (title) {
    title.textContent = `${label} · ${placementText(mine, day.cues)}`;
    title.title = mine.reason;
  }
}
