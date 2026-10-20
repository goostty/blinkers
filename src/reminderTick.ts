import { invoke } from '@tauri-apps/api/core';
import { formatClock } from './cues';
import { describeMoment } from './scheduler';
import { todayKey } from './scheduleUi';

// What tick_reminders hands back (TickReport in notifier.rs).
interface TickReport {
  sent: number;
  missed: number;
  failed: string | null;
}

// Reminders are decided on the Rust side from the stored state, so how often this asks only
// decides how late one can be. Every 15 seconds keeps that well under a minute.
const TICK_EVERY_MS = 15_000;

let lastSentAt: number | null = null;
let failure: string | null = null;
let running = false;
const listeners: Array<(text: string) => void> = [];

// One line for the settings drawer. A problem comes first because it is the thing to act on: a
// reminder that never reaches the phone looks exactly like a quiet day.
export function describeStatus(lastSent: number | null, problem: string | null): string {
  if (problem) return `Reminders are not getting through: ${problem}. It will keep trying.`;
  if (lastSent === null) return 'No reminders sent yet.';
  const when = new Date(lastSent * 1000);
  return `Last reminder sent at ${formatClock(when.getHours() * 60 + when.getMinutes())}.`;
}

export function onStatusChange(listener: (text: string) => void) {
  listeners.push(listener);
  listener(describeStatus(lastSentAt, failure));
}

// Skips a tick when the last one is still running, so a slow network cannot make two overlap and
// send the same reminder twice.
async function tick() {
  if (running) return;
  running = true;
  const nowUnix = Math.floor(Date.now() / 1000);
  try {
    const report = await invoke<TickReport>('tick_reminders', {
      on: todayKey(),
      nowMin: describeMoment(new Date()).nowMin,
      nowUnix,
    });
    if (report.sent > 0) lastSentAt = nowUnix;
    failure = report.failed;
  } catch (err) {
    failure = typeof err === 'string' ? err : 'the reminder check failed';
  } finally {
    running = false;
  }
  const text = describeStatus(lastSentAt, failure);
  listeners.forEach((l) => l(text));
}

export async function initReminderTick() {
  await tick();
  setInterval(() => void tick(), TICK_EVERY_MS);
}
