import { invoke } from '@tauri-apps/api/core';
import { APP_CATALOG } from './appCatalog';
import { addUnique, parseWebsite, type AppEntry } from './appTargets';
import { onDayRefreshed, refreshDay, type LoadedDay } from './scheduleUi';
import { buildTodayRows, type TodayCommitment, type TodayRow, type Tone } from './todayRows';

// What the edit form shows and sends back (EditableBlock / BlockEdit in containers.rs).
interface EditableBlock {
  blockType: string;
  title: string;
  actionTrigger: string | null;
  definitionOfDone: string | null;
  apps: AppEntry[];
}

const TONE_CLASS: Record<Tone, string> = {
  live: 'text-emerald-400',
  waiting: 'text-amber-400',
  done: 'text-slate-500',
  warn: 'text-rose-400',
  muted: 'text-slate-400',
};

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
const input = (id: string) => el<HTMLInputElement>(id);

let editingId: string | null = null;
let editApps: AppEntry[] = [];

function message(id: string, text: string) {
  const node = el(id);
  if (!node) return;
  node.textContent = text;
  node.hidden = text === '';
}

const errorText = (err: unknown, fallback: string) => (typeof err === 'string' ? err : fallback);

function makeButton(text: string, style: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = text;
  btn.className = `cursor-pointer px-2.5 py-1 text-xs font-semibold rounded-md transition-colors ${style}`;
  btn.addEventListener('click', onClick);
  return btn;
}

async function dropBlock(blockId: string) {
  message('today-error', '');
  try {
    await invoke('dismiss_block', { blockId });
    if (editingId === blockId) closeEditor();
    await refreshDay();
  } catch (err) {
    message('today-error', errorText(err, 'Could not drop that block.'));
  }
}

function renderRow(row: TodayRow): HTMLElement {
  const item = document.createElement('li');
  item.dataset.blockId = row.blockId;
  item.className = 'flex items-center gap-3 p-3 bg-slate-900 border border-slate-800 rounded-lg';

  const text = document.createElement('div');
  text.className = 'flex flex-col min-w-0 flex-1';
  const title = document.createElement('span');
  title.className = 'text-sm font-medium text-slate-100 truncate';
  title.textContent = row.title;
  const meta = document.createElement('span');
  meta.className = 'text-xs text-slate-500 truncate';
  const status = document.createElement('span');
  status.className = TONE_CLASS[row.tone];
  status.textContent = row.statusText;
  meta.append(`${row.timeText} · `, status);
  text.append(title, meta);

  const buttons = document.createElement('div');
  buttons.className = 'flex gap-1.5 shrink-0';
  if (row.canEdit) {
    buttons.append(makeButton('Edit', 'bg-slate-800 hover:bg-slate-700 text-slate-200', () => void openEditor(row.blockId)));
  }
  if (row.canDrop) {
    buttons.append(makeButton('Drop', 'bg-slate-800 hover:bg-rose-600 text-slate-300 hover:text-slate-100', () => void dropBlock(row.blockId)));
  }

  item.append(text, buttons);
  return item;
}

// Redrawn whenever the day is planned again, which is after anything that could change it.
async function render(day: LoadedDay) {
  const list = el('today-list');
  if (!list) return;

  let commitments: TodayCommitment[] = [];
  try {
    commitments = await invoke<TodayCommitment[]>('list_commitments', { on: day.isoDate });
  } catch (err) {
    console.error('Could not load the commitments for the Today list:', err);
  }

  const rows = buildTodayRows(day.blocks, day.dayPlan.placements, commitments ?? []);
  list.replaceChildren(...rows.map(renderRow));
  const empty = el('today-empty');
  if (empty) empty.hidden = rows.length > 0;
}

// ---- the edit form ----------------------------------------------------------------------

function renderEditApps() {
  const holder = el('edit-apps');
  if (!holder) return;
  holder.replaceChildren(
    ...editApps.map((app) => {
      const chip = document.createElement('span');
      chip.className = 'flex items-center gap-2 pl-2.5 pr-1.5 py-1.5 text-sm text-slate-100 bg-slate-800 border border-slate-700 rounded-lg';
      const name = document.createElement('span');
      name.className = 'max-w-[180px] truncate';
      name.textContent = app.label;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.title = `Remove ${app.label}`;
      remove.className = 'cursor-pointer w-5 h-5 leading-none text-slate-400 hover:text-slate-100 hover:bg-slate-700 rounded';
      remove.textContent = '✕';
      remove.addEventListener('click', () => {
        editApps = editApps.filter((a) => a.url !== app.url);
        renderEditApps();
      });
      chip.append(name, remove);
      return chip;
    }),
  );
}

function fillAppChoices() {
  const select = el<HTMLSelectElement>('edit-app-pick');
  if (!select || select.options.length > 0) return;
  const first = document.createElement('option');
  first.value = '';
  first.textContent = 'Choose an app…';
  select.append(first);
  APP_CATALOG.forEach((app, i) => {
    const option = document.createElement('option');
    option.value = String(i);
    option.textContent = app.label;
    select.append(option);
  });
}

function closeEditor() {
  editingId = null;
  const form = el('edit-block-form');
  if (form) form.hidden = true;
  message('edit-error', '');
}

async function openEditor(blockId: string) {
  message('today-error', '');
  let block: EditableBlock;
  try {
    block = await invoke<EditableBlock>('get_block_details', { blockId });
  } catch (err) {
    message('today-error', errorText(err, 'Could not open that block.'));
    return;
  }

  editingId = blockId;
  editApps = block.apps;
  const form = el('edit-block-form');
  if (!form) return;

  const label = { deep: 'Deep work', routine: 'Routine', reset: 'Reset' }[block.blockType] ?? 'Block';
  const heading = el('edit-heading');
  if (heading) heading.textContent = `Edit ${label.toLowerCase()}`;
  input('edit-title')!.value = block.title;
  input('edit-trigger')!.value = block.actionTrigger ?? '';
  input('edit-done')!.value = block.definitionOfDone ?? '';

  // Only deep and routine blocks open apps, so the section is not offered for the others.
  const appsSection = el('edit-apps-section');
  if (appsSection) appsSection.hidden = block.blockType !== 'deep' && block.blockType !== 'routine';
  fillAppChoices();
  renderEditApps();

  message('edit-error', '');
  form.hidden = false;
  form.scrollIntoView?.({ block: 'nearest' });
  input('edit-title')!.focus();
}

function addChosenApp() {
  const pick = el<HTMLSelectElement>('edit-app-pick');
  const chosen = pick && pick.value !== '' ? APP_CATALOG[Number(pick.value)] : undefined;
  if (!chosen || !pick) return;
  editApps = addUnique(editApps, chosen);
  pick.value = '';
  renderEditApps();
}

function addTypedSite() {
  const field = input('edit-app-url');
  if (!field) return;
  const result = parseWebsite(field.value);
  if (!result.ok) {
    message('edit-error', result.error);
    return;
  }
  editApps = addUnique(editApps, result.entry);
  field.value = '';
  message('edit-error', '');
  renderEditApps();
}

// The title is checked here for a quick answer; the backend checks it again, and the rest of its
// rules (no apps on rest blocks, finished blocks are history) are shown as it words them.
async function saveEdit(event: Event) {
  event.preventDefault();
  if (editingId === null) return;
  const title = input('edit-title')!.value.trim();
  if (title === '') {
    message('edit-error', 'Give the block a title.');
    return;
  }
  const appsShown = !el('edit-apps-section')?.hidden;
  try {
    await invoke('update_block', {
      blockId: editingId,
      edit: {
        title,
        actionTrigger: input('edit-trigger')!.value.trim() || null,
        definitionOfDone: input('edit-done')!.value.trim() || null,
        apps: appsShown ? editApps : [],
      },
    });
  } catch (err) {
    message('edit-error', errorText(err, 'Could not save that.'));
    return;
  }
  closeEditor();
  await refreshDay();
}

export function initTodayUi() {
  onDayRefreshed((day) => void render(day));
  el('edit-block-form')?.addEventListener('submit', (e) => void saveEdit(e));
  el('btn-edit-cancel')?.addEventListener('click', closeEditor);
  el('btn-edit-app-add')?.addEventListener('click', addChosenApp);
  el('btn-edit-url-add')?.addEventListener('click', addTypedSite);
  input('edit-app-url')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addTypedSite();
    }
  });
}
