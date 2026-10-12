import { invoke } from '@tauri-apps/api/core';
import { cueSpan, formatClock, formatDays, parseClock, parseCue, toClockValue, type Cue, type Weekday } from './cues';
import { describeEnergy, windowEnergy, type Chronotype, type UserProfile } from './energy';

const ENERGY_STYLE = {
  High: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  Medium: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  Low: 'text-slate-400 bg-slate-500/10 border-slate-500/20',
} as const;

const PEN_SVG = `<svg class="w-4 h-4 mx-auto" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>`;

const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const PRESETS: Record<string, Weekday[]> = {
  weekdays: [1, 2, 3, 4, 5],
  weekends: [0, 6],
  all: [0, 1, 2, 3, 4, 5, 6],
};

let cues: Cue[] = [];
let profile: UserProfile = { chronotype: 'neutral' };
// Set while the form is editing an existing cue; null means it is creating a new one.
let editingId: string | null = null;
const selectedDays = new Set<Weekday>();

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

function showError(id: string, message: string) {
  const node = el(id);
  if (!node) return;
  node.textContent = message;
  node.hidden = !message;
}

export async function refreshCues() {
  try {
    cues = await invoke<Cue[]>('list_cues');
    showError('cue-list-error', '');
  } catch (err) {
    console.error('Could not load cues:', err);
    showError('cue-list-error', 'Could not load your cues.');
  }
  renderCueList();
}

function renderChronotype() {
  document.querySelectorAll<HTMLElement>('[data-chronotype]').forEach((btn) => {
    const active = btn.dataset.chronotype === profile.chronotype;
    btn.classList.toggle('bg-indigo-600', active);
    btn.classList.toggle('text-slate-100', active);
    btn.classList.toggle('text-slate-400', !active);
    btn.classList.toggle('hover:text-slate-200', !active);
    btn.setAttribute('aria-pressed', String(active));
  });
}

async function loadProfile() {
  try {
    profile = await invoke<UserProfile>('get_profile');
  } catch (err) {
    console.error('Could not load profile:', err);
  }
  renderChronotype();
}

async function setChronotype(chronotype: Chronotype) {
  const previous = profile;
  profile = { ...profile, chronotype };
  renderChronotype();
  renderCueList();
  try {
    await invoke<void>('set_profile', { profile });
  } catch (err) {
    // Roll the screen back so it never shows a rhythm that was not actually saved.
    console.error('Could not save profile:', err);
    profile = previous;
    renderChronotype();
    renderCueList();
    showError('cue-list-error', 'Could not save your rhythm.');
  }
}

function renderCueList() {
  const list = el('curr-cue-list');
  const empty = el('cue-empty');
  if (!list || !empty) return;

  list.replaceChildren();
  cues.forEach((cue) => {
    const item = document.createElement('li');
    item.className =
      'flex items-center justify-between gap-3 px-4 py-3 bg-slate-900 border border-slate-800 rounded-lg';

    const text = document.createElement('div');
    text.className = 'flex flex-col min-w-0';

    const name = document.createElement('span');
    name.className = 'text-sm font-medium text-slate-100 truncate';
    name.textContent = cue.label;

    const flex = cue.flexMin > 0 ? ` · ± ${cue.flexMin} min` : '';
    const detail = document.createElement('span');
    detail.className = 'text-xs text-slate-400';
    detail.textContent = `${formatClock(cue.timeMin)} · ${formatDays(cue.days as Weekday[])}${flex}`;

    text.append(name, detail);

    const span = cueSpan(cue);
    const energy = windowEnergy(profile, span.startMin, span.durationMin);
    const level = describeEnergy(energy);
    const pill = document.createElement('span');
    pill.className = `shrink-0 px-2 py-0.5 text-[11px] font-semibold rounded-full border ${ENERGY_STYLE[level]}`;
    pill.title = `Average energy ${energy.toFixed(1)} / 5 for a ${profile.chronotype} chronotype`;
    pill.textContent = `⚡ ${level}`;

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.title = `Edit ${cue.label}`;
    edit.className =
      'cursor-pointer shrink-0 w-7 h-7 text-slate-500 hover:text-indigo-400 hover:bg-slate-800 rounded transition-colors';
    edit.innerHTML = PEN_SVG; // constant markup, no user data
    edit.addEventListener('click', () => openCueModal(cue));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.title = `Delete ${cue.label}`;
    remove.className =
      'cursor-pointer shrink-0 w-7 h-7 text-slate-500 hover:text-rose-400 hover:bg-slate-800 rounded transition-colors';
    remove.textContent = '✕';
    remove.addEventListener('click', () => deleteCue(cue.id));

    // Pill and buttons share one right-aligned group so the icons line up row to row even
    // though the pills differ in width.
    const actions = document.createElement('div');
    actions.className = 'flex items-center gap-2 shrink-0';
    actions.append(pill, edit, remove);

    item.append(text, actions);
    list.append(item);
  });

  empty.hidden = cues.length > 0;
}

async function deleteCue(id: string) {
  try {
    await invoke<void>('delete_cue', { id });
  } catch (err) {
    console.error('Could not delete cue:', err);
    showError('cue-list-error', 'Could not delete that cue.');
    return;
  }
  await refreshCues();
}

function renderDays() {
  const container = el('cue-days');
  if (!container) return;
  container.replaceChildren();

  DAY_LETTERS.forEach((letter, index) => {
    const day = index as Weekday;
    const active = selectedDays.has(day);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(active));
    btn.title = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][index];
    btn.className = `cursor-pointer py-2.5 text-sm font-semibold rounded-lg transition-colors ${
      active ? 'bg-indigo-600 text-slate-100' : 'bg-slate-900 border border-slate-700 text-slate-400 hover:text-slate-200'
    }`;
    btn.textContent = letter;
    btn.addEventListener('click', () => {
      if (selectedDays.has(day)) selectedDays.delete(day);
      else selectedDays.add(day);
      renderDays();
    });
    container.append(btn);
  });
}

// The flex dropdown only offers a few round values. A cue saved earlier (or migrated from the
// old format) can carry any value up to 120, so add a matching option instead of silently
// showing the wrong one.
function setFlexValue(flexMin: number) {
  const select = el<HTMLSelectElement>('cue-flex');
  if (!select) return;
  select.querySelector('[data-extra]')?.remove();
  if (![...select.options].some((o) => Number(o.value) === flexMin)) {
    const extra = document.createElement('option');
    extra.value = String(flexMin);
    extra.textContent = `± ${flexMin} min`;
    extra.dataset.extra = 'true';
    select.append(extra);
  }
  select.value = String(flexMin);
}

// Pass a cue to edit it in place; omit it to create a new one.
function openCueModal(cue?: Cue) {
  const modal = el('cue-modal');
  if (!modal) return;
  editingId = cue?.id ?? null;

  const title = el('cue-modal-title');
  if (title) title.textContent = cue ? 'Edit Cue' : 'New Cue';
  const save = el('btn-cue-save');
  if (save) save.textContent = cue ? 'Save Changes' : 'Save Cue';

  el<HTMLInputElement>('cue-label')!.value = cue?.label ?? '';
  el<HTMLInputElement>('cue-time')!.value = cue ? toClockValue(cue.timeMin) : '';
  setFlexValue(cue?.flexMin ?? 0);
  selectedDays.clear();
  (cue ? (cue.days as Weekday[]) : PRESETS.all).forEach((d) => selectedDays.add(d));
  renderDays();
  showError('cue-error', '');
  modal.hidden = false;
  el<HTMLInputElement>('cue-label')?.focus();
}

function closeCueModal() {
  const modal = el('cue-modal');
  if (modal) modal.hidden = true;
  editingId = null;
  showError('cue-error', '');
}

async function saveCue() {
  const timeMin = parseClock(el<HTMLInputElement>('cue-time')?.value ?? '');
  if (timeMin === null) {
    showError('cue-error', 'Pick a time.');
    return;
  }

  const parsed = parseCue(
    {
      label: el<HTMLInputElement>('cue-label')?.value ?? '',
      timeMin,
      days: [...selectedDays],
      flexMin: Number(el<HTMLSelectElement>('cue-flex')?.value ?? 0),
    },
    // A cue being edited must not count as clashing with its own old self.
    cues.filter((c) => c.id !== editingId),
  );
  if (!parsed.ok) {
    showError('cue-error', parsed.error);
    return;
  }

  try {
    if (editingId) await invoke<Cue>('update_cue', { id: editingId, input: parsed.value });
    else await invoke<Cue>('create_cue', { input: parsed.value });
  } catch (err) {
    // The Rust side validates too; its message is already user-readable.
    showError('cue-error', typeof err === 'string' ? err : 'Could not save the cue.');
    return;
  }

  closeCueModal();
  await refreshCues();
}

export async function initCueUi() {
  el('btn-add-cue')?.addEventListener('click', () => openCueModal());
  el('btn-cue-close')?.addEventListener('click', closeCueModal);
  el('btn-cue-cancel')?.addEventListener('click', closeCueModal);
  el('btn-cue-save')?.addEventListener('click', saveCue);

  document.querySelectorAll<HTMLElement>('[data-chronotype]').forEach((btn) => {
    btn.addEventListener('click', () => setChronotype(btn.dataset.chronotype as Chronotype));
  });

  document.querySelectorAll<HTMLElement>('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedDays.clear();
      PRESETS[btn.dataset.preset ?? 'all'].forEach((d) => selectedDays.add(d));
      renderDays();
    });
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCueModal();
  });

  await loadProfile();
  await refreshCues();
}
