// The words for the sync section of Settings, kept apart from the page so they can be tested.

// What the backend reports (see sync.rs).
export interface RemoteInfo {
  fingerprint: string;
  writtenAt: number; // unix seconds
  deviceId: string;
  deviceName: string;
  thisDevice: boolean;
  recentlyActive: boolean;
}

export type SyncState = 'off' | 'no_remote' | 'in_sync' | 'local_changes' | 'remote_newer' | 'conflict' | 'version_mismatch';

export interface SyncStatus {
  enabled: boolean;
  folder: string | null;
  deviceId: string;
  lastSyncedAt: number | null;
  remote: RemoteInfo | null;
  state: SyncState;
}

export type Outcome =
  | { kind: 'off' | 'nothing' | 'inSync' | 'pushed' }
  | { kind: 'pulled' | 'remoteNewer' | 'conflict' | 'versionMismatch'; remote: RemoteInfo };

// "5 minutes ago", in the largest unit that fits. A clock a little ahead is just "just now".
export function ago(unixSec: number, nowSec: number): string {
  const sec = nowSec - unixSec;
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'} ago`;
  if (sec < 60) return 'just now';
  if (sec < 3600) return unit(Math.floor(sec / 60), 'minute');
  if (sec < 86400) return unit(Math.floor(sec / 3600), 'hour');
  return unit(Math.floor(sec / 86400), 'day');
}

const otherName = (remote: RemoteInfo | null) => remote?.deviceName || 'the other device';

const NEWER = (r: RemoteInfo | null, now?: number) =>
  `${otherName(r)} saved newer data${r && now !== undefined ? ` ${ago(r.writtenAt, now)}` : ''}. Press Sync now to load it.`;
const CONFLICT = (r: RemoteInfo | null) => `This device and ${otherName(r)} both changed since they last agreed. Choose which to keep.`;
const MISMATCH = (r: RemoteInfo | null) =>
  `${otherName(r)} runs a different version of Blinkers. Update the app on both devices, then sync.`;

export function statusText(status: SyncStatus, nowSec: number): string {
  switch (status.state) {
    case 'off':
      return 'Syncing is off. Choose a folder that your other devices can also see.';
    case 'no_remote':
      return 'Nothing saved in the folder yet.';
    case 'in_sync':
      return status.lastSyncedAt ? `Up to date. Last synced ${ago(status.lastSyncedAt, nowSec)}.` : 'Up to date.';
    case 'local_changes':
      return 'This device has changes that have not been saved to the folder yet.';
    case 'remote_newer':
      return NEWER(status.remote, nowSec);
    case 'conflict':
      return CONFLICT(status.remote);
    case 'version_mismatch':
      return MISMATCH(status.remote);
  }
}

export function outcomeText(outcome: Outcome): string {
  switch (outcome.kind) {
    case 'off':
      return 'Syncing is off.';
    case 'nothing':
      return 'Nothing to save yet.';
    case 'inSync':
      return 'Already up to date.';
    case 'pushed':
      return 'Saved to the sync folder.';
    case 'pulled':
      return `Loaded the latest data from ${otherName(outcome.remote)}.`;
    case 'remoteNewer':
      return NEWER(outcome.remote);
    case 'conflict':
      return CONFLICT(outcome.remote);
    case 'versionMismatch':
      return MISMATCH(outcome.remote);
  }
}

// Phone reminders are sent by whichever computer has the app open, so two open at once would each
// send them. Another device that used the folder a moment ago may still be open.
export function activeWarning(remote: RemoteInfo | null, nowSec: number): string | null {
  if (!remote || remote.thisDevice || !remote.recentlyActive) return null;
  return `${otherName(remote)} used the sync folder ${ago(remote.writtenAt, nowSec)}. If Blinkers is still open there, both devices will send phone reminders. Close it there first.`;
}

// Whether the badge in the header should ask for attention.
export function needsAttention(state: string): boolean {
  return state === 'conflict' || state === 'remote_newer' || state === 'version_mismatch';
}
