import { invoke } from '@tauri-apps/api/core';
import { onStatusChange } from './reminderTick';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

function showError(message: string) {
  const node = el('ntfy-error');
  if (!node) return;
  node.textContent = message;
  node.hidden = message === '';
}

async function loadTopic() {
  const input = el<HTMLInputElement>('ntfy-topic');
  if (!input) return;
  try {
    input.value = await invoke<string>('get_ntfy_topic');
    showError('');
  } catch (err) {
    showError(typeof err === 'string' ? err : 'Could not load the topic.');
  }
}

// Copying falls back to selecting the text, so Cmd+C still works where the clipboard is blocked.
async function copyTopic() {
  const input = el<HTMLInputElement>('ntfy-topic');
  if (!input) return;
  input.select();
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    // selected above; the user can copy it by hand
  }
}

// The backend validates the name and says what is wrong, so its wording is shown as it is.
async function saveTopic() {
  const field = el<HTMLInputElement>('ntfy-new-topic');
  if (!field || field.value.trim() === '') return;
  try {
    await invoke('set_ntfy_topic', { topic: field.value });
    field.value = '';
    await loadTopic();
  } catch (err) {
    showError(typeof err === 'string' ? err : 'Could not save that topic.');
  }
}

export async function initNotifySettingsUi() {
  el('btn-ntfy-copy')?.addEventListener('click', () => void copyTopic());
  el('btn-ntfy-save')?.addEventListener('click', () => void saveTopic());
  onStatusChange((text) => {
    const status = el('ntfy-status');
    if (status) status.textContent = text;
  });
  await loadTopic();
}
