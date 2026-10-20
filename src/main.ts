import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { load } from '@tauri-apps/plugin-store';
import { addUnique, filterApps, parseWebsite, type AppEntry } from './appTargets';
import { APP_CATALOG } from './appCatalog';
import { initBlockActionsUi } from './blockActionsUi';
import { initCueUi } from './cueUi';
import { initNotifySettingsUi } from './notifySettingsUi';
import { initReminderTick } from './reminderTick';
import { initTodayUi } from './todayUi';
import { refreshDay, showSuggestedSlot, todayKey } from './scheduleUi';
import { resolveAttach, resolveDuration, type ParentChoice } from './attach';
import type { Urgency } from './scheduler';
import { needsUrgency, resolveUrgency } from './urgency';

export interface TaskItem {
  title: string;
  actionTrigger?: string;
  definitionOfDone?: string;
}

type Drawer = 'today' | 'add-task' | 'add-cue' | 'settings' | null;
type BlockType = 'deep' | 'routine' | 'reset' | 'recharge';

// No top-level await: it delays this module past DOMContentLoaded, so the
// init listener below would never fire. Load the store lazily instead.
const storePromise = load('apps.json');
const appWindow = getCurrentWindow();
let activeDrawer: Drawer = null;
let currentBlockType: BlockType = 'deep';
let currentUrgency: Urgency | null = null;
let selectedApps: AppEntry[] = [];
const BLOCK_LABELS: Record<BlockType, string> = {
  deep: 'Deep work',
  routine: 'Routine',
  reset: 'Reset',
  recharge: 'Recharge',
};

// DOM Elements
const anchorBtn = document.getElementById('create-anchor');
const toggleDrawerBtn = document.getElementById('btn-toggle-drawer');
const createForm = document.getElementById('form-create-container') as HTMLFormElement | null;

const deepWorkBlock = document.getElementById('deep-work');
const routineBlock = document.getElementById('routine-block');
const resetBlock = document.getElementById('reset-block');
const rechargeBlock = document.getElementById('recharge-block');

const COMPACT_HEIGHT = 68;
const EXPANDED_HEIGHT = 720;
// The strip with the Start / Finish / Lapse buttons sits under the header while a block is up.
const STRIP_HEIGHT = 40;
let stripVisible = false;

const windowSize = (height: number) => new LogicalSize(540, height + (stripVisible ? STRIP_HEIGHT : 0));
const compactSize = () => windowSize(COMPACT_HEIGHT);
const expandedSize = () => windowSize(EXPANDED_HEIGHT);

// A block sent back for rescheduling waits in the Today tab's "needs a place" list; open it.
function showPlaceNeeded() {
  if (activeDrawer !== 'today') void toggleDrawer('today');
}

// The tab bar only shows while a pane is open, and the open pane's tab is the lit one.
function syncTabs() {
  const bar = document.getElementById('tab-bar');
  if (bar) bar.hidden = activeDrawer === null;
  document.querySelectorAll<HTMLElement>('[data-tab]').forEach((tab) => {
    const active = tab.dataset.tab === activeDrawer;
    tab.classList.toggle('bg-indigo-600', active);
    tab.classList.toggle('text-slate-100', active);
    tab.classList.toggle('text-slate-400', !active);
    tab.classList.toggle('hover:text-slate-200', !active);
    tab.setAttribute('aria-pressed', String(active));
  });
}

// The window grows to fit the strip when it appears and shrinks back when it goes.
function setStripVisible(visible: boolean) {
  stripVisible = visible;
  void appWindow.setSize(activeDrawer === null ? compactSize() : expandedSize());
}

// Deep work almost always runs over, so the form asks for a buffer (nothing is added for you).
// Rest only exists when you set it: an empty cue is free time, not rest.
const LENGTH_HINT: Record<BlockType, string> = {
  deep: 'Overestimate: deep work almost always takes longer than planned, so add a buffer.',
  routine: 'How long this usually takes.',
  reset: 'How long the reset lasts.',
  recharge: 'How long you are resting. Rest only counts when you set it here; an empty cue is just free time.',
};

// Each step runs on its own, so one that fails cannot switch off the rest of the app (a form bug
// once left the cue buttons dead because they were set up after it).
async function init() {
  const steps: Array<[string, () => void | Promise<unknown>]> = [
    ['block selector', initBlockSelector],
    ['urgency picker', initUrgencyPicker],
    ['form layout', () => updateFormLayout(currentBlockType)],
    ['window size', () => appWindow.setSize(compactSize())],
    ['cues', initCueUi],
    ['today list', initTodayUi],
    // Plans today on launch, so the day's commitments are right even if no block is made.
    ['day plan', refreshDay],
    // After the plan is saved, so it reads the commitments that plan just wrote.
    ['block actions', () => initBlockActionsUi(setStripVisible, showPlaceNeeded)],
    ['notification settings', initNotifySettingsUi],
    // Last, so the first tick sees the plan that was just saved.
    ['reminders', initReminderTick],
  ];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (err) {
      console.error(`Could not set up ${name}:`, err);
    }
  }
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

function getIcon(app: AppEntry) {
  if (app.url.startsWith('http')) {
    const domain = new URL(app.url).hostname;
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
  }
  return app.icon || '/icons/generic.png';
}

async function loadPresets(): Promise<AppEntry[]> {
  const store = await storePromise;
  return (await store.get<AppEntry[]>('presets')) ?? [];
}

// Websites the user has pasted before are kept so they can be re-picked from the App list.
async function savePreset(entry: AppEntry) {
  try {
    const store = await storePromise;
    const presets = await loadPresets();
    await store.set('presets', addUnique(presets, entry));
    await store.save();
  } catch (err) {
    console.error('Could not save preset:', err);
  }
}

function makeIcon(app: AppEntry): HTMLElement {
  if (app.url.startsWith('http')) {
    const img = document.createElement('img');
    img.src = getIcon(app);
    img.className = 'w-5 h-5 rounded shrink-0';
    // Favicon service needs the network; fall back to a globe when offline.
    img.onerror = () => img.replaceWith(emojiIcon('🌐'));
    return img;
  }
  return emojiIcon(app.icon || '📱');
}

function emojiIcon(emoji: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'w-5 text-center shrink-0';
  span.textContent = emoji;
  return span;
}

function renderSelected() {
  const container = document.getElementById('app-selected');
  if (!container) return;
  container.replaceChildren();

  selectedApps.forEach((app) => {
    const chip = document.createElement('span');
    chip.className =
      'flex items-center gap-2 pl-2.5 pr-1.5 py-1.5 text-sm text-slate-100 bg-slate-800 border border-slate-700 rounded-lg';

    const label = document.createElement('span');
    label.className = 'max-w-[180px] truncate';
    label.textContent = app.label;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.title = `Remove ${app.label}`;
    remove.className =
      'cursor-pointer w-5 h-5 leading-none text-slate-400 hover:text-slate-100 hover:bg-slate-700 rounded';
    remove.textContent = '✕';
    remove.addEventListener('click', () => {
      selectedApps = selectedApps.filter((a) => a.url !== app.url);
      renderSelected();
    });

    chip.append(makeIcon(app), label, remove);
    container.append(chip);
  });
}

function showAppError(message: string) {
  const el = document.getElementById('app-error');
  if (!el) return;
  el.textContent = message;
  el.hidden = !message;
}

function selectApp(entry: AppEntry) {
  selectedApps = addUnique(selectedApps, entry);
  renderSelected();
  closePicker();
}

async function renderAppList() {
  const list = document.getElementById('app-list');
  const empty = document.getElementById('app-list-empty');
  const filter = document.getElementById('app-filter') as HTMLInputElement | null;
  if (!list || !empty || !filter) return;

  const presets = await loadPresets();
  const matches = filterApps([...presets, ...APP_CATALOG], filter.value);

  list.replaceChildren();
  matches.forEach((app) => {
    const item = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
      'cursor-pointer w-full flex items-center gap-3 px-3.5 py-3 text-left bg-slate-900 hover:bg-slate-800 border border-slate-800 hover:border-indigo-500/50 rounded-lg transition-colors';

    const text = document.createElement('span');
    text.className = 'flex flex-col min-w-0';
    const name = document.createElement('span');
    name.className = 'text-sm font-medium text-slate-100 truncate';
    name.textContent = app.label;
    const sub = document.createElement('span');
    sub.className = 'text-xs text-slate-500 truncate';
    sub.textContent = app.url;
    text.append(name, sub);

    btn.append(makeIcon(app), text);
    btn.addEventListener('click', () => selectApp(app));
    item.append(btn);
    list.append(item);
  });
  empty.hidden = matches.length > 0;
}

function setPickerMode(mode: 'website' | 'app') {
  const modes = [
    { id: 'website', tab: 'app-mode-website', pane: 'app-pane-website' },
    { id: 'app', tab: 'app-mode-app', pane: 'app-pane-app' },
  ];
  modes.forEach(({ id, tab, pane }) => {
    const active = id === mode;
    const tabEl = document.getElementById(tab);
    const paneEl = document.getElementById(pane);
    if (paneEl) paneEl.hidden = !active;
    if (tabEl) {
      tabEl.classList.toggle('bg-indigo-600', active);
      tabEl.classList.toggle('text-slate-100', active);
      tabEl.classList.toggle('text-slate-400', !active);
      tabEl.classList.toggle('hover:text-slate-200', !active);
    }
  });
  showAppError('');
  if (mode === 'app') {
    renderAppList();
    (document.getElementById('app-filter') as HTMLInputElement | null)?.focus();
  } else {
    (document.getElementById('app-url') as HTMLInputElement | null)?.focus();
  }
}

function openPicker() {
  const picker = document.getElementById('app-picker');
  if (!picker) return;
  (document.getElementById('app-url') as HTMLInputElement).value = '';
  (document.getElementById('app-filter') as HTMLInputElement).value = '';
  picker.hidden = false;
  setPickerMode('website');
}

function closePicker() {
  const picker = document.getElementById('app-picker');
  if (picker) picker.hidden = true;
  showAppError('');
}

async function addWebsiteFromInput() {
  const input = document.getElementById('app-url') as HTMLInputElement | null;
  if (!input) return;
  const result = parseWebsite(input.value);
  if (!result.ok) {
    showAppError(result.error);
    return;
  }
  await savePreset(result.entry);
  selectApp(result.entry);
}

// One broken target (app not installed, scope denied) must not stop the others from opening.
async function openSelectedApps(entries: AppEntry[]) {
  for (const app of entries) {
    try {
      await openUrl(app.url);
    } catch (err) {
      console.error(`Could not open ${app.label}:`, err);
    }
  }
}

async function handleSubmit(
  title: string,
  actionTrigger: string,
  definitionOfDone: string,
  urgency: Urgency | null,
  durationMin: number,
  parent: ParentChoice | null,
) {
  try {
    const orderIndex = await invoke<number>("get_next_order_index");

    const primaryTask: TaskItem = {
      title,
      actionTrigger: actionTrigger || undefined,
      definitionOfDone: definitionOfDone || undefined,
    };

    const blockId = await invoke<string>("create_container", {
      task: primaryTask,
      orderIndex: orderIndex,
      blockType: currentBlockType,
      urgency,
      // Saved with the block so they can be opened when it starts; rest blocks open nothing.
      apps: needsUrgency(currentBlockType) ? selectedApps : [],
      durationMin,
      parent,
      createdOn: todayKey(),
    });

    console.log("Container deployed successfully!");
    await showSuggestedSlot(blockId, title || BLOCK_LABELS[currentBlockType]);

    if (currentBlockType === 'deep' || currentBlockType === 'routine') {
      await openSelectedApps(selectedApps);
    }
  } catch (errorMessage) {
    console.error("Command Failed: ", errorMessage);
  }
}

async function toggleDrawer(target: Drawer) {
  const isClosing = activeDrawer === target;

  if (isClosing) {
    activeDrawer = null;
    syncTabs();
    closeAllUIDrawers();

    setTimeout(async () => {
      if (activeDrawer === null) {
        await appWindow.setSize(compactSize());
      }
    }, 300);
  } else {
    const wasFullyClosed = activeDrawer === null;
    activeDrawer = target;
    syncTabs();

    if (wasFullyClosed) {
      await appWindow.setSize(expandedSize());
    }

    openSpecificDrawerUI(target);
    // Cues may have changed since the drawer was last open, so the "follows" choices are rebuilt.
    if (target === 'add-task' || target === 'today') void refreshDay();
  }
}

function closeAllUIDrawers() {
  const drawers = document.querySelectorAll('.drawer-content');
  drawers.forEach(d => {
    const drawerEl = d as HTMLElement;
    drawerEl.style.maxHeight = '0px';
    drawerEl.style.overflowY = '';
    drawerEl.classList.remove('border-t', 'border-slate-800/60');
    drawerEl.classList.add('border-t-border-slate-800/0');
  });

  document.querySelectorAll('.drawer-toggle-icon').forEach(i => {
    i.classList.remove('rotate-45');
  });
}

function openSpecificDrawerUI(target: Drawer) {
  closeAllUIDrawers();
  if (!target) return;

  const drawerElement = document.getElementById(`${target}-drawer`);
  const iconElement = document.getElementById(`${target}-icon`);

  if (drawerElement) {
    // As tall as the window allows below the header, strip and tabs; longer panes scroll.
    drawerElement.style.maxHeight = 'calc(100vh - 170px)';
    // The task form is taller than the drawer, so let it scroll instead of cutting it off.
    drawerElement.style.overflowY = 'auto';
    drawerElement.classList.remove('border-t-border-slate-800/0');
    drawerElement.classList.add('border-t', 'border-slate-800/60');
  }

  if (iconElement) {
    iconElement.classList.add('rotate-45');
  }
}

function updateFormLayout(type: BlockType) {
  const tasksSection = document.getElementById('tasks-section');
  const gridSection = document.getElementById('grid-section');
  const urgencySection = document.getElementById('urgency-section');

  if (!tasksSection || !gridSection || !urgencySection) return;

  // Use the `hidden` property, not the Tailwind class: `grid` and `hidden`
  // are both display utilities and the grid one wins, so the class never hid anything.
  tasksSection.hidden = false;
  gridSection.hidden = false;
  urgencySection.hidden = !needsUrgency(type);
  showUrgencyError('');
  showFieldError('duration-error', '');
  showFieldError('attach-error', '');

  switch (type) {
    case 'deep':
      break;
    case 'routine':
      break;
    case 'reset':
      gridSection.hidden = true;
      break;
    case 'recharge':
      tasksSection.hidden = true;
      gridSection.hidden = true;
      break;
  }

  // A hidden field that is still `required` makes the browser refuse to submit the whole form
  // (recharge has no title), so the title is only required while it can be seen.
  const titleInput = document.getElementById('task-title') as HTMLInputElement | null;
  if (titleInput) titleInput.required = !tasksSection.hidden;

  const hint = document.getElementById('duration-hint');
  if (hint) hint.textContent = LENGTH_HINT[type];
  updateAttachVisibility();
}

// A block advised to drop (Q4) is not part of the day, so there is nothing for it to follow.
function updateAttachVisibility() {
  const attachSection = document.getElementById('attach-section');
  if (attachSection) attachSection.hidden = needsUrgency(currentBlockType) && currentUrgency === 'neither';
}

function showFieldError(id: string, message: string) {
  const node = document.getElementById(id);
  if (!node) return;
  node.textContent = message;
  node.hidden = message === '';
}

function showUrgencyError(message: string) {
  const el = document.getElementById('urgency-error');
  if (!el) return;
  el.textContent = message;
  el.hidden = message === '';
}

function renderUrgency() {
  document.querySelectorAll<HTMLElement>('[data-urgency]').forEach((btn) => {
    const active = btn.dataset.urgency === currentUrgency;
    btn.classList.toggle('bg-indigo-600', active);
    btn.classList.toggle('text-slate-100', active);
    btn.classList.toggle('text-slate-400', !active);
    btn.classList.toggle('hover:text-slate-200', !active);
    btn.setAttribute('aria-pressed', String(active));
  });
}

// There is deliberately no default: picking is the point, so a task is never ranked by accident.
function initUrgencyPicker() {
  document.querySelectorAll<HTMLElement>('[data-urgency]').forEach((btn) => {
    btn.addEventListener('click', () => {
      currentUrgency = btn.dataset.urgency as Urgency;
      renderUrgency();
      showUrgencyError('');
      updateAttachVisibility();
    });
  });
  renderUrgency();
}

function initBlockSelector() {
  const overlay = document.getElementById('tab-overlay');
  const blockOrder: BlockType[] = ['deep', 'routine', 'reset', 'recharge'];
  const buttons = [deepWorkBlock, routineBlock, resetBlock, rechargeBlock];

  buttons.forEach((button, index) => {
    if (!button) return;

    button.addEventListener('click', () => {
      const selectedType = blockOrder[index];
      currentBlockType = selectedType;

      if (overlay) {
        overlay.className = "absolute top-1 bottom-1 left-1 w-[calc(25%-4px)] bg-indigo-600 rounded-md shadow-md transition-transform duration-300 ease-in-out transform z-0";

        if (index === 1) overlay.classList.add('translate-x-[100%]');
        else if (index === 2) overlay.classList.add('translate-x-[200%]');
        else if (index === 3) overlay.classList.add('translate-x-[300%]');
        else overlay.classList.add('translate-x-0');
      }

      buttons.forEach((btn) => {
        if (btn) {
          if (btn === button) {
            btn.classList.add('text-slate-100');
            btn.classList.remove('text-slate-400', 'hover:text-slate-200');
          } else {
            btn.classList.remove('text-slate-100');
            btn.classList.add('text-slate-400', 'hover:text-slate-200');
          }
        }
      });

      updateFormLayout(selectedType);
    });
  });
}

document.getElementById('btn-open-app-picker')?.addEventListener('click', openPicker);
document.getElementById('btn-picker-close')?.addEventListener('click', closePicker);
document.getElementById('btn-website-cancel')?.addEventListener('click', closePicker);
document.getElementById('btn-app-cancel')?.addEventListener('click', closePicker);
document.getElementById('btn-website-add')?.addEventListener('click', addWebsiteFromInput);
document.getElementById('app-mode-website')?.addEventListener('click', () => setPickerMode('website'));
document.getElementById('app-mode-app')?.addEventListener('click', () => setPickerMode('app'));
document.getElementById('app-filter')?.addEventListener('input', renderAppList);
document.getElementById('app-url')?.addEventListener('keydown', (e) => {
  // Let Enter confirm the pasted URL, same as clicking Add.
  if (e.key === 'Enter') {
    e.preventDefault();
    addWebsiteFromInput();
  }
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePicker();
});

if (toggleDrawerBtn) toggleDrawerBtn.addEventListener('click', () => toggleDrawer('add-task'));
if (anchorBtn) anchorBtn.addEventListener('click', () => toggleDrawer('add-cue'));
document.getElementById('settings')?.addEventListener('click', () => toggleDrawer('settings'));
document.getElementById('btn-today')?.addEventListener('click', () => toggleDrawer('today'));
document.getElementById('btn-place')?.addEventListener('click', showPlaceNeeded);
// A tab opens its pane; clicking the lit one does nothing (the header icons are what close it).
document.querySelectorAll<HTMLElement>('[data-tab]').forEach((tab) => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab as Drawer;
    if (target !== activeDrawer) void toggleDrawer(target);
  });
});

if (createForm) {
  createForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const titleInput = document.getElementById('task-title') as HTMLInputElement | null;
    const actionInput = document.getElementById('action-trigger') as HTMLInputElement | null;
    const dodInput = document.getElementById('definition-of-done') as HTMLInputElement | null;

    const title = titleInput?.value.trim() || '';
    const actionTrigger = actionInput?.value.trim() || '';
    const definitionOfDone = dodInput?.value.trim() || '';

    // An unclassified work block stops here with the form left as typed, so nothing is lost.
    const urgency = resolveUrgency(currentBlockType, currentUrgency);
    if (!urgency.ok) {
      showUrgencyError(urgency.error);
      return;
    }

    showFieldError('duration-error', '');
    showFieldError('attach-error', '');
    const duration = resolveDuration((document.getElementById('block-duration') as HTMLInputElement | null)?.value ?? '');
    if (!duration.ok) {
      showFieldError('duration-error', duration.error);
      return;
    }
    const parent = resolveAttach(urgency.value, (document.getElementById('block-attach') as HTMLSelectElement | null)?.value ?? '');
    if (!parent.ok) {
      showFieldError('attach-error', parent.error);
      return;
    }

    if (title || currentBlockType === 'recharge') {
      await handleSubmit(title, actionTrigger, definitionOfDone, urgency.value, duration.value, parent.value);
    }

    createForm.reset();
    currentUrgency = null;
    renderUrgency();
    updateAttachVisibility();
    selectedApps = [];
    renderSelected();
    toggleDrawer(activeDrawer);
  });
}
