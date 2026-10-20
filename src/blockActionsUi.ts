import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { AppEntry } from './appTargets';
import { blockActions, type BlockAction, type BlockActionKind } from './blockActions';
import { formatClock } from './cues';
import type { DayBlock } from './dayPlan';
import { pickFocus, pickMissed } from './focus';
import { describeMoment } from './scheduler';
import { refreshDay, todayKey } from './scheduleUi';

// A commitment as the backend lists it (see Commitment in commitments.rs).
interface Commitment {
  blockId: string;
  status: string;
  startMin: number;
  durationMin: number;
  startedAt: number | null;
}

interface StartedBlock {
  title: string;
  actionTrigger: string | null;
  definitionOfDone: string | null;
  apps: AppEntry[];
}

const TYPE_LABEL: Record<string, string> = {
  deep: 'Deep work',
  routine: 'Routine',
  reset: 'Reset',
  recharge: 'Recharge',
};

const BUTTON_LABEL: Record<BlockActionKind, string> = {
  start: 'Start',
  finish: 'Finish',
  lapse: 'Lapse',
  reschedule: 'Reschedule',
  drop: 'Drop',
};
const BUTTON_STYLE: Record<BlockActionKind, string> = {
  start: 'bg-indigo-600 hover:bg-indigo-500 text-slate-100',
  finish: 'bg-emerald-600 hover:bg-emerald-500 text-slate-100',
  lapse: 'bg-slate-800 hover:bg-rose-600 text-slate-300 hover:text-slate-100',
  reschedule: 'bg-indigo-600 hover:bg-indigo-500 text-slate-100',
  drop: 'bg-slate-800 hover:bg-rose-600 text-slate-300 hover:text-slate-100',
};

// The backend is asked again this often, so a status the reminder loop changes shows up; between
// those asks the screen is only repainted from what it already has.
const RELOAD_EVERY_SEC = 10;

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

let commitments: Commitment[] = [];
let blocks: DayBlock[] = [];
let busy = false;
let error = '';
let shownKey = '';
let visible = false;
let onVisibilityChange: (visible: boolean) => void = () => {};
let onNeedsPlace: () => void = () => {};

function formatSpan(totalSec: number): string {
  const s = Math.max(0, Math.ceil(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

// Where the block stands: when it is due before Start, how long is left after it.
function describeTiming(c: Commitment, nowSec: number, nowMin: number): string {
  if (c.status === 'missed') return `Missed ${formatClock(c.startMin)}`;
  if (c.status === 'started' && c.startedAt !== null) {
    const left = c.durationMin * 60 - Math.max(0, nowSec - c.startedAt);
    return left > 0 ? `${formatSpan(left)} left` : `over by ${formatSpan(-left)}`;
  }
  return nowMin >= c.startMin ? 'Due now' : `Starts ${formatClock(c.startMin)}`;
}

function buttonText(a: BlockAction): string {
  const label = BUTTON_LABEL[a.action];
  return a.enabled || !Number.isFinite(a.waitSec) ? label : `${label} · ${formatSpan(a.waitSec)}`;
}

function setBusy(next: boolean) {
  busy = next;
  paint();
}

async function openApps(apps: AppEntry[]) {
  // One broken target (app not installed, scope denied) must not stop the others from opening.
  for (const app of apps) {
    try {
      await openUrl(app.url);
    } catch (err) {
      console.error(`Could not open ${app.label}:`, err);
    }
  }
}

// Runs one button press. The backend is the judge of what is allowed (it re-checks the same rules
// the buttons mirror), so a refusal is shown as it is worded there instead of being second-guessed.
async function perform(action: BlockActionKind, blockId: string) {
  if (busy) return;
  setBusy(true);
  error = '';
  const on = todayKey();
  const nowUnix = Math.floor(Date.now() / 1000);
  try {
    if (action === 'start') {
      const started = await invoke<StartedBlock>('start_block', { blockId, on, nowUnix });
      await openApps(started.apps);
    } else if (action === 'finish') {
      await invoke('finish_block', { blockId, on, nowUnix, nowMin: describeMoment(new Date()).nowMin });
    } else if (action === 'lapse') {
      await invoke('lapse_block', { blockId, on });
    } else if (action === 'reschedule') {
      await invoke('reschedule_block', { blockId, on });
    } else {
      await invoke('dismiss_block', { blockId });
    }
    // Finishing pulls the blocks after it forward, and lapsing, rescheduling or dropping closes
    // the chain up, so the day is planned again; starting only changes this block.
    if (action !== 'start') await refreshDay();
    // A rescheduled block is waiting for the user to say what it follows, so show where.
    if (action === 'reschedule') onNeedsPlace();
  } catch (err) {
    error = typeof err === 'string' ? err : 'That did not work.';
  }
  await reload();
  setBusy(false);
}

async function reload() {
  const on = todayKey();
  try {
    [commitments, blocks] = await Promise.all([
      invoke<Commitment[]>('list_commitments', { on }),
      invoke<DayBlock[]>('list_day_blocks', { on }),
    ]);
  } catch (err) {
    console.error('Could not load the day:', err);
  }
  paint();
}

function setVisible(next: boolean) {
  if (visible === next) return;
  visible = next;
  onVisibilityChange(next);
}

// The buttons are only rebuilt when the block or its status changes. Rebuilding them on every
// tick would replace a button between mouse-down and mouse-up and swallow the click, so the
// second-by-second changes (countdowns, enabled state) are written into the existing ones.
function paint() {
  const strip = el('focus-strip');
  if (!strip) return;

  const nowSec = Math.floor(Date.now() / 1000);
  const nowMin = describeMoment(new Date()).nowMin;
  // A missed block only counts while it is still alive: a dropped one is not in `blocks`.
  const alive = commitments.filter((x) => blocks.some((b) => b.id === x.blockId && !b.isCompleted));
  const focusId = pickFocus(commitments, nowMin) ?? pickMissed(alive);
  const c = commitments.find((x) => x.blockId === focusId);

  if (!c) {
    strip.hidden = true;
    shownKey = '';
    setVisible(false);
    return;
  }

  const day = blocks.find((b) => b.id === c.blockId);
  const name = day?.title.trim() || TYPE_LABEL[day?.blockType ?? ''] || 'Block';
  const { actions } = blockActions(c, nowSec);

  const key = `${c.blockId}:${c.status}`;
  if (key !== shownKey) {
    shownKey = key;
    strip.replaceChildren();

    const label = document.createElement('span');
    label.dataset.role = 'name';
    label.className = 'text-xs font-medium text-slate-200 truncate min-w-0 flex-1';

    const timing = document.createElement('span');
    timing.dataset.role = 'timing';
    timing.className = 'text-xs font-mono text-slate-400 shrink-0';

    const buttons = document.createElement('div');
    buttons.className = 'flex gap-1.5 shrink-0';
    for (const a of actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.action = a.action;
      btn.className = `cursor-pointer px-2.5 py-1 text-xs font-semibold rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${BUTTON_STYLE[a.action]}`;
      btn.addEventListener('click', () => void perform(a.action, c.blockId));
      buttons.append(btn);
    }

    const problem = document.createElement('p');
    problem.dataset.role = 'error';
    problem.className = 'basis-full text-xs text-rose-400';

    strip.append(label, timing, buttons, problem);
  }

  strip.querySelector<HTMLElement>('[data-role="name"]')!.textContent = name;
  strip.querySelector<HTMLElement>('[data-role="timing"]')!.textContent = describeTiming(c, nowSec, nowMin);
  for (const a of actions) {
    const btn = strip.querySelector<HTMLButtonElement>(`[data-action="${a.action}"]`);
    if (!btn) continue;
    btn.textContent = buttonText(a);
    btn.disabled = busy || !a.enabled;
  }
  const problem = strip.querySelector<HTMLElement>('[data-role="error"]')!;
  problem.textContent = error;
  problem.hidden = error === '';

  strip.hidden = false;
  setVisible(true);
}

// `onVisibility` is told when the strip appears or goes away, so the window can grow to fit it.
// `onPlaceNeeded` is told when a block was sent back to "needs a place today".
export async function initBlockActionsUi(
  onVisibility: (visible: boolean) => void = () => {},
  onPlaceNeeded: () => void = () => {},
) {
  onVisibilityChange = onVisibility;
  onNeedsPlace = onPlaceNeeded;
  await reload();

  let ticks = 0;
  setInterval(() => {
    ticks += 1;
    if (ticks % RELOAD_EVERY_SEC === 0 && !busy) void reload();
    else paint();
  }, 1000);
}
