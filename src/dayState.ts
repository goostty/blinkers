import { invoke } from '@tauri-apps/api/core';
import type { FitChoice } from './fit';

// What the user has decided about today: how to fix a day that does not fit, and the earliest time
// an unstarted block may begin after they dealt with a missed block. It only matters for one day,
// so it is stored with its date and yesterday's choices are simply not found today (shortening
// yesterday's overfull day must not quietly apply to today's).
//
// The working copy is in the browser's storage, which the planning reads instantly. Every change is
// also written to the database, because that is what syncs between devices: switching computers
// mid-day should not ask the same question again. On startup the database's copy for today wins
// (see hydrateDayState), since it is the one that travelled.

export interface DayChoices {
  fit?: FitChoice;
  notBeforeMin?: number;
}

const KEY = 'blinkers.day';

const isMinute = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 1440;

// Storage can be missing or throw (a private window, blocked site data), and the app must work
// without it, so every access is guarded and "nothing stored" is the fallback.
function read(isoDate: string): DayChoices {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return {};
    const stored = JSON.parse(raw);
    if (!stored || stored.date !== isoDate) return {};
    const choices: DayChoices = {};
    if (stored.fit === 'shorten' || stored.fit === 'drop') choices.fit = stored.fit;
    if (isMinute(stored.notBeforeMin)) choices.notBeforeMin = stored.notBeforeMin;
    return choices;
  } catch {
    return {};
  }
}

function write(isoDate: string, choices: DayChoices) {
  const text = JSON.stringify({ date: isoDate, ...choices });
  try {
    window.localStorage.setItem(KEY, text);
  } catch {
    // No storage: the choice only lasts until the next plan, which is better than failing.
  }
  // Best effort: a database that cannot be written must not lose the choice the user just made.
  invoke('set_synced_setting', { key: 'day_state', value: text }).catch(() => {});
}

// Reads the database's copy of today's choices into the working copy. Used after the app opens or
// data has been loaded from another device. A copy for another day, or one that cannot be read, is
// ignored. It writes only to the working copy: writing back what was just read would be pointless.
export async function hydrateDayState(isoDate: string): Promise<void> {
  try {
    const text = await invoke<string | null>('get_synced_setting', { key: 'day_state' });
    if (!text) return;
    const stored = JSON.parse(text);
    if (!stored || stored.date !== isoDate) return;
    window.localStorage.setItem(KEY, text);
  } catch {
    // Not available or not readable: what is here stays.
  }
}

export const loadChoices = read;

// Undefined clears the choice, so the user is asked again the next time the day does not fit.
export function setFitChoice(isoDate: string, fit: FitChoice | undefined) {
  const { notBeforeMin } = read(isoDate);
  write(isoDate, { ...(fit ? { fit } : {}), ...(notBeforeMin !== undefined ? { notBeforeMin } : {}) });
}

// Only ever moves later. Once a block was told it cannot start before 10:00, a later plan must not
// put it back at 9:30, which is already in the past.
export function raiseNotBefore(isoDate: string, minute: number) {
  if (!isMinute(minute)) return;
  const { fit, notBeforeMin } = read(isoDate);
  write(isoDate, { ...(fit ? { fit } : {}), notBeforeMin: Math.max(minute, notBeforeMin ?? 0) });
}

// A Unix timestamp (seconds) as minutes since local midnight, the unit the plan works in.
export function minuteOfDay(unixSeconds: number): number {
  const d = new Date(unixSeconds * 1000);
  return d.getHours() * 60 + d.getMinutes();
}
