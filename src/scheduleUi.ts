import { invoke } from '@tauri-apps/api/core';
import { attachOptions, parseAttach, type AttachOption } from './attach';
import { nextToPlace } from './autoPlace';
import { cueRunsOn, type Cue, type Weekday } from './cues';
import { loadChoices, minuteOfDay, setFitChoice } from './dayState';
import { placementText, planDay, type DayBlock, type DayPlan } from './dayPlan';
import type { UserProfile } from './energy';
import { autoPlaceEnabled } from './prefs';
import { describeMoment } from './scheduler';
import { suggestSlot, type NewBlock, type Suggestion } from './suggest';

export function todayKey(): string {
  return describeMoment(new Date()).isoDate;
}

export interface LoadedDay {
  isoDate: string;
  weekday: Weekday;
  cues: Cue[];
  blocks: DayBlock[];
  dayPlan: DayPlan;
  profile: UserProfile; // the energy curve the suggestions are matched against
  nowMin: number; // the minute the day was planned at
  overrunning: boolean; // a started block is past its end, so the plan keeps moving with the clock
}

// What planning needs to know about the day's commitments: when blocks really started.
interface StartedCommitment {
  blockId: string;
  status: string;
  durationMin: number;
  startedAt: number | null; // unix seconds
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
  const [cues, listed, profile, commitments] = await Promise.all([
    invoke<Cue[]>('list_cues'),
    invoke<DayBlock[]>('list_day_blocks', { on: when.isoDate }),
    // Only the suggestions use the profile, so failing to read it must not stop the day loading.
    invoke<UserProfile | null>('get_profile').catch(() => null),
    // Without the commitments the plan still works, it just cannot see when blocks really started.
    invoke<StartedCommitment[]>('list_commitments', { on: when.isoDate }).catch(() => [] as StartedCommitment[]),
  ]);

  // The plan follows what happened: a block begins when it was really started, and one still
  // running past its end keeps the time it is using.
  const startedAt = new Map((commitments ?? []).filter((c) => c.startedAt != null).map((c) => [c.blockId, minuteOfDay(c.startedAt!)]));
  const blocks = listed.map((b) => (startedAt.has(b.id) ? { ...b, startedAtMin: startedAt.get(b.id)! } : b));
  const overrunning = (commitments ?? []).some(
    (c) => c.status === 'started' && c.startedAt != null && minuteOfDay(c.startedAt) + c.durationMin <= when.nowMin,
  );

  const choices = loadChoices(when.isoDate);
  const dayPlan = planDay(blocks, cues, when.weekday, when.isoDate, {
    nowMin: when.nowMin,
    notBeforeMin: choices.notBeforeMin,
    fit: choices.fit,
  });
  // A choice was made for a day that did not fit. Once it fits again the choice is spent, so a
  // later problem asks again instead of silently reusing it.
  if (choices.fit && dayPlan.fit.applied === null) setFitChoice(when.isoDate, undefined);

  // Saving the plan failing must not hide what the user is waiting to see.
  try {
    await invoke('sync_commitments', { on: when.isoDate, plan: dayPlan.plan });
  } catch (err) {
    console.error('Could not save the plan:', err);
  }

  return {
    isoDate: when.isoDate,
    weekday: when.weekday,
    cues,
    blocks,
    dayPlan,
    profile: profile ?? { chronotype: 'neutral' },
    nowMin: when.nowMin,
    overrunning,
  };
}

let lastDay: LoadedDay | null = null;

// Whether any cue runs today. Every block is placed after a cue, so without one there is nothing
// to schedule around. True until the day has been planned, so the notice does not flash at startup.
export function todayHasCues(): boolean {
  if (!lastDay) return true;
  const today = { isoDate: lastDay.isoDate, weekday: lastDay.weekday };
  return lastDay.cues.some((c) => !c.endsDay && cueRunsOn(c, today));
}

// Where `block` would best go in the day as it was last planned. `leaving` is a block already in
// the list that is being placed (a waiting one): it must not count against itself.
function suggestFor(day: LoadedDay, block: NewBlock, leaving?: string): Suggestion {
  return suggestSlot({
    block,
    blocks: day.blocks.filter((b) => b.id !== leaving),
    cues: day.cues,
    weekday: day.weekday,
    isoDate: day.isoDate,
    nowMin: describeMoment(new Date()).nowMin,
    profile: day.profile,
  });
}

// For the new-block form. Null until the day has been planned once.
export function suggestForNewBlock(block: NewBlock): Suggestion | null {
  return lastDay ? suggestFor(lastDay, block) : null;
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

    // The place is suggested the same way as in the new-block form; the user still presses Attach.
    const suggestion = suggestFor(
      day,
      { blockType: block.blockType, urgency: block.urgency, durationMin: block.durationMin, title: block.title },
      block.id,
    );
    if (suggestion.kind === 'slot') select.value = `${suggestion.parent.kind}:${suggestion.parent.id}`;
    const why = document.createElement('span'); // a span, so the error below stays the row's only <p>
    why.className = 'text-xs text-indigo-300';
    why.textContent = suggestion.kind === 'slot' ? `Suggested: ${suggestion.reason}` : suggestion.reason;

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
    row.append(name, why, controls, error);
    list.append(row);
  }
}

// While a started block runs past its end the plan moves with the clock, so the day is planned
// again; on a day where nothing is overrunning this costs nothing.
export async function replanIfOverrunning() {
  if (lastDay?.overrunning) await refreshDay();
}

const OVERRUN_CHECK_MS = 30_000;
export function startOverrunWatch() {
  setInterval(() => void replanIfOverrunning(), OVERRUN_CHECK_MS);
}

// Places the blocks that are waiting, one at a time, planning again after each because every block
// that goes in changes the room left for the next. A block is tried once per round, so one the
// backend refuses is left waiting instead of being retried forever.
async function placeWaiting(first: LoadedDay): Promise<LoadedDay> {
  let day = first;
  const tried = new Set<string>();
  for (let round = 0; round <= first.blocks.length; round++) {
    const next = nextToPlace({
      blocks: day.blocks,
      cues: day.cues,
      weekday: day.weekday,
      isoDate: day.isoDate,
      nowMin: describeMoment(new Date()).nowMin,
      profile: day.profile,
      skip: tried,
    });
    if (!next) break;
    tried.add(next.blockId);
    try {
      await invoke('attach_block', { blockId: next.blockId, parent: next.parent, on: day.isoDate });
    } catch (err) {
      console.error('Could not place a block:', err);
      continue;
    }
    day = await planToday();
  }
  return day;
}

// Refreshes run one after another. Placing makes several backend calls, and a refresh that started
// before the user's last action must not finish after one that saw it.
let queue: Promise<unknown> = Promise.resolve();
export function refreshDay(): Promise<LoadedDay | null> {
  const run = queue.then(refresh, refresh);
  queue = run;
  return run;
}

// Re-plans today and brings the screen in line: the "follows" choices in the new-block form and
// the list of blocks still waiting for a place. Unless the user turned it off, the app places those
// blocks itself first.
async function refresh(): Promise<LoadedDay | null> {
  try {
    let day = await planToday();
    if (autoPlaceEnabled()) day = await placeWaiting(day);
    lastDay = day;
    const options = attachOptions(day.cues, day.blocks, day.dayPlan, day.weekday, day.isoDate);

    const select = el<HTMLSelectElement>('block-attach');
    if (select) fillOptions(select, options, autoPlaceEnabled() ? 'Automatic: the app picks' : 'Pick what it follows…');
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
