import { describe, expect, it } from 'vitest';
import { activeWarning, ago, needsAttention, outcomeText, statusText, type RemoteInfo, type SyncStatus } from '../syncText';

const NOW = 1_800_000_000;

const remote = (over: Partial<RemoteInfo> = {}): RemoteInfo => ({
  fingerprint: 'f',
  writtenAt: NOW - 120,
  deviceId: 'other',
  deviceName: 'Desktop',
  thisDevice: false,
  recentlyActive: false,
  ...over,
});

const status = (over: Partial<SyncStatus> = {}): SyncStatus => ({
  enabled: true,
  folder: '/Users/me/Dropbox/Blinkers',
  deviceId: 'me',
  lastSyncedAt: NOW - 300,
  remote: remote(),
  state: 'in_sync',
  ...over,
});

describe('ago', () => {
  it('speaks in the largest sensible unit', () => {
    expect(ago(NOW - 10, NOW)).toBe('just now');
    expect(ago(NOW - 60, NOW)).toBe('1 minute ago');
    expect(ago(NOW - 5 * 60, NOW)).toBe('5 minutes ago');
    expect(ago(NOW - 3600, NOW)).toBe('1 hour ago');
    expect(ago(NOW - 5 * 3600, NOW)).toBe('5 hours ago');
    expect(ago(NOW - 86400, NOW)).toBe('1 day ago');
    expect(ago(NOW - 3 * 86400, NOW)).toBe('3 days ago');
  });

  it('does not say anything odd when a clock is a little ahead', () => {
    expect(ago(NOW + 30, NOW)).toBe('just now');
  });
});

describe('statusText', () => {
  it('says syncing is off, and what to do', () => {
    expect(statusText(status({ enabled: false, state: 'off', folder: null, remote: null }), NOW)).toMatch(/off.*folder/i);
  });

  it('says when nothing is saved in the folder yet', () => {
    expect(statusText(status({ state: 'no_remote', remote: null }), NOW)).toMatch(/nothing saved/i);
  });

  it('says when everything is up to date and when it last was', () => {
    expect(statusText(status(), NOW)).toBe('Up to date. Last synced 5 minutes ago.');
    expect(statusText(status({ lastSyncedAt: null }), NOW)).toBe('Up to date.');
  });

  it('says when this device has changes not yet saved', () => {
    expect(statusText(status({ state: 'local_changes' }), NOW)).toMatch(/not been saved/i);
  });

  it('names the other device when it has newer data, and says how to get it', () => {
    const text = statusText(status({ state: 'remote_newer' }), NOW);
    expect(text).toContain('Desktop');
    expect(text).toMatch(/2 minutes ago/);
    expect(text).toMatch(/sync now/i);
  });

  it('says both devices changed in a conflict', () => {
    expect(statusText(status({ state: 'conflict' }), NOW)).toMatch(/Desktop.*both changed|both changed.*Desktop/i);
  });

  it('asks for both devices to be updated when versions differ', () => {
    expect(statusText(status({ state: 'version_mismatch' }), NOW)).toMatch(/different version.*update/i);
  });
});

describe('outcomeText', () => {
  it('says what a sync just did', () => {
    expect(outcomeText({ kind: 'pushed' })).toBe('Saved to the sync folder.');
    expect(outcomeText({ kind: 'pulled', remote: remote() })).toBe('Loaded the latest data from Desktop.');
    expect(outcomeText({ kind: 'inSync' })).toBe('Already up to date.');
    expect(outcomeText({ kind: 'nothing' })).toMatch(/nothing to save/i);
    expect(outcomeText({ kind: 'off' })).toMatch(/off/i);
  });

  it('explains the outcomes that need the user', () => {
    expect(outcomeText({ kind: 'remoteNewer', remote: remote() })).toMatch(/Desktop.*newer/i);
    expect(outcomeText({ kind: 'conflict', remote: remote() })).toMatch(/both changed/i);
    expect(outcomeText({ kind: 'versionMismatch', remote: remote() })).toMatch(/different version/i);
  });
});

describe('activeWarning', () => {
  it('warns that another device used the folder a moment ago, and why it matters', () => {
    const text = activeWarning(remote({ recentlyActive: true }), NOW)!;
    expect(text).toContain('Desktop');
    expect(text).toMatch(/phone reminders/i);
  });

  it('says nothing about a device that has not been active, or about this one', () => {
    expect(activeWarning(remote({ recentlyActive: false }), NOW)).toBeNull();
    expect(activeWarning(remote({ recentlyActive: true, thisDevice: true }), NOW)).toBeNull();
    expect(activeWarning(null, NOW)).toBeNull();
  });
});

describe('needsAttention', () => {
  it('is true only for states the user has to do something about', () => {
    for (const state of ['conflict', 'remote_newer', 'version_mismatch']) expect(needsAttention(state)).toBe(true);
    for (const state of ['off', 'no_remote', 'in_sync', 'local_changes']) expect(needsAttention(state)).toBe(false);
  });
});
