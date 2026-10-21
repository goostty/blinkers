import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open } from '@tauri-apps/plugin-dialog';
import { hydrateDayState } from './dayState';
import { todayKey } from './scheduleUi';
import { activeWarning, needsAttention, outcomeText, statusText, type Outcome, type SyncStatus } from './syncText';

// The "Sync between devices" part of Settings, and the syncing that happens by itself: when the app
// opens (taking newer data from the other device), now and then while it runs (saving, and noticing
// when the other device has saved something), and when the window closes. The rules for what to
// do are in sync.rs; this only asks it to, and shows what came back.
//
// Taking data from the other device replaces everything on screen, so it only happens when the app
// opens or the user asks. While they are working, a newer copy is reported, never loaded.

const CHECK_EVERY_MS = 5 * 60 * 1000;
// A folder that is slow or unplugged must not stop the app from opening, so the first sync is given
// a moment and then the app carries on without it.
const STARTUP_WAIT_MS = 2000;
const CLOSE_WAIT_MS = 3000;

const OFF: SyncStatus = { enabled: false, folder: null, deviceId: '', lastSyncedAt: null, remote: null, state: 'off' };

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const nowSec = () => Math.floor(Date.now() / 1000);
const errorText = (err: unknown) => (typeof err === 'string' ? err : 'Syncing did not work.');

let current: SyncStatus = OFF;
let busy = false;

// Starting the screen over is announced first as a cancelable event, so anything that needs to can
// take over (a test, in a browser that cannot reload); if nobody does, the page reloads.
function reloadApp() {
  if (window.dispatchEvent(new CustomEvent('blinkers:reload', { cancelable: true }))) window.location.reload();
}

function setText(id: string, text: string | null) {
  const node = el(id);
  if (!node) return;
  node.textContent = text ?? '';
  node.hidden = !text;
}

function render(status: SyncStatus) {
  current = status;
  const now = nowSec();
  const text = el('sync-status');
  if (text) text.textContent = statusText(status, now);
  setText('sync-folder', status.folder);
  setText('sync-warning', activeWarning(status.remote, now));

  const folderButton = el('btn-sync-folder');
  if (folderButton) folderButton.textContent = status.enabled ? 'Change folder…' : 'Choose folder…';
  for (const id of ['btn-sync-now', 'btn-sync-off']) {
    const button = el(id);
    if (button) button.hidden = !status.enabled;
  }
  const conflict = el('sync-conflict');
  if (conflict) conflict.hidden = status.state !== 'conflict';
  const badge = el('btn-sync');
  if (badge) badge.hidden = !needsAttention(status.state);
}

async function refreshStatus() {
  try {
    render((await invoke<SyncStatus | null>('get_sync_status')) ?? OFF);
  } catch (err) {
    setText('sync-error', errorText(err));
  }
}

// What a finished sync means for the screen. Loading the other device's data replaces everything
// on it (cues, blocks, the phone topic), so the screen starts over from the database, after
// today's choices have come across too.
async function handle(outcome: Outcome, announce: boolean) {
  setText('sync-error', null);
  setText('sync-message', announce || outcome.kind === 'pulled' ? outcomeText(outcome) : null);
  if (outcome.kind === 'pulled') {
    await hydrateDayState(todayKey());
    reloadApp();
  }
}

// `allowPull` is false for the checks made while the user is working. `announce` shows the result,
// which the user wants after pressing a button but not after the app does it by itself.
async function runSync(allowPull: boolean, announce: boolean) {
  if (busy) return;
  busy = true;
  try {
    await handle(await invoke<Outcome>('run_sync', { allowPull }), announce);
  } catch (err) {
    setText('sync-error', errorText(err));
  } finally {
    busy = false;
    await refreshStatus();
  }
}

export function syncTick() {
  return current.enabled ? runSync(false, false) : Promise.resolve();
}

async function chooseFolder() {
  const picked = await open({ directory: true, multiple: false, title: 'Choose a folder your devices share' });
  if (typeof picked !== 'string') return; // cancelled
  setText('sync-error', null);
  try {
    render(await invoke<SyncStatus>('set_sync_folder', { folder: picked }));
  } catch (err) {
    setText('sync-error', errorText(err));
    return;
  }
  await runSync(true, true);
}

async function stopSyncing() {
  try {
    render(await invoke<SyncStatus>('set_sync_folder', { folder: null }));
    setText('sync-message', null);
    setText('sync-error', null);
  } catch (err) {
    setText('sync-error', errorText(err));
  }
}

async function resolve(keep: 'this' | 'other') {
  if (busy) return;
  busy = true;
  try {
    await handle(await invoke<Outcome>('sync_resolve', { keep }), true);
  } catch (err) {
    setText('sync-error', errorText(err));
  } finally {
    busy = false;
    await refreshStatus();
  }
}

export async function initSyncUi() {
  el('btn-sync-folder')?.addEventListener('click', () => void chooseFolder());
  el('btn-sync-now')?.addEventListener('click', () => void runSync(true, true));
  el('btn-sync-off')?.addEventListener('click', () => void stopSyncing());
  el('btn-keep-this')?.addEventListener('click', () => void resolve('this'));
  el('btn-keep-other')?.addEventListener('click', () => void resolve('other'));
  await refreshStatus();
  if (current.enabled) await Promise.race([runSync(true, false), wait(STARTUP_WAIT_MS)]);

  setInterval(() => void syncTick(), CHECK_EVERY_MS);

  // A last save as the window closes, so the other device finds this one's latest work. It is given
  // a few seconds at most: closing must never hang on a folder that does not answer.
  try {
    await getCurrentWindow().onCloseRequested(async () => {
      if (!current.enabled) return;
      await Promise.race([invoke('run_sync', { allowPull: false }).catch(() => {}), wait(CLOSE_WAIT_MS)]);
    });
  } catch {
    // Not available here (a plain browser): the periodic save still happens.
  }
}
