import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { load } from '@tauri-apps/plugin-store';
import { addUnique, filterApps, parseWebsite, type AppEntry } from './appTargets';
import { APP_CATALOG } from './appCatalog';
import { initCueUi } from './cueUi';
import { showSuggestedSlot, todayKey } from './scheduleUi';

export interface TaskItem {
  title: string;
  actionTrigger?: string;
  definitionOfDone?: string;
}

type Drawer = 'add-task' | 'add-cue' | null;
type BlockType = 'deep' | 'routine' | 'reset' | 'recharge';

// No top-level await: it delays this module past DOMContentLoaded, so the
// init listener below would never fire. Load the store lazily instead.
const storePromise = load('apps.json');
const appWindow = getCurrentWindow();
let activeDrawer: Drawer = null;
let currentBlockType: BlockType = 'deep';
let selectedApps: AppEntry[] = [];
const BLOCK_LABELS: Record<BlockType, string> = {
  deep: 'Deep work',
  routine: 'Routine',
  reset: 'Reset',
  recharge: 'Recharge',
};

// DOM Elements
const pauseBtn = document.getElementById('btn-pause');
const anchorBtn = document.getElementById('create-anchor');
const toggleDrawerBtn = document.getElementById('btn-toggle-drawer');
const createForm = document.getElementById('form-create-container') as HTMLFormElement | null;
const stateBadge = document.getElementById('current-state-badge');

const deepWorkBlock = document.getElementById('deep-work');
const routineBlock = document.getElementById('routine-block');
const resetBlock = document.getElementById('reset-block');
const rechargeBlock = document.getElementById('recharge-block');

let isCurrentlyPaused = false;

const COMPACT_SIZE = new LogicalSize(540, 68);
const EXPANDED_SIZE = new LogicalSize(540, 720);

const playSVG = `<svg class="w-3.5 h-3.5 text-amber-400" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`;
const pauseSVG = `<svg class="w-3.5 h-3.5 text-slate-400 hover:text-slate-100" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;

async function init() {
  initBlockSelector();
  updateFormLayout(currentBlockType);
  await appWindow.setSize(COMPACT_SIZE);
  await initCueUi();
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

async function handleSubmit(title: string, actionTrigger: string, definitionOfDone: string) {
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

function handlePlaybackToggle() {
  isCurrentlyPaused = !isCurrentlyPaused;

  if (isCurrentlyPaused) {
    if (pauseBtn) {
      pauseBtn.innerHTML = playSVG;
      pauseBtn.title = "Resume Task";
    }
    if (stateBadge) {
      stateBadge.innerText = 'PAUSED';
      stateBadge.className = 'text-[9px] font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20 px-1.5 py-0.5 rounded-full uppercase';
    }
  } else {
    if (pauseBtn) {
      pauseBtn.innerHTML = pauseSVG;
      pauseBtn.title = "Pause Task";
    }
    if (stateBadge) {
      stateBadge.innerText = 'ACTIVE';
      stateBadge.className = 'text-[9px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-1.5 py-0.5 rounded-full uppercase';
    }
  }
}

async function toggleDrawer(target: Drawer) {
  const isClosing = activeDrawer === target;

  if (isClosing) {
    activeDrawer = null;
    closeAllUIDrawers();

    setTimeout(async () => {
      if (activeDrawer === null) {
        await appWindow.setSize(COMPACT_SIZE);
      }
    }, 300);
  } else {
    const wasFullyClosed = activeDrawer === null;
    activeDrawer = target;

    if (wasFullyClosed) {
      await appWindow.setSize(EXPANDED_SIZE);
    }

    openSpecificDrawerUI(target);
  }
}

function closeAllUIDrawers() {
  const drawers = document.querySelectorAll('.drawer-content');
  drawers.forEach(d => {
    const drawerEl = d as HTMLElement;
    drawerEl.style.maxHeight = '0px';
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
    drawerElement.style.maxHeight = '640px';
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
  const durationSection = document.getElementById('duration-section');

  if (!tasksSection || !gridSection || !durationSection) return;

  // Use the `hidden` property, not the Tailwind class: `grid` and `hidden`
  // are both display utilities and the grid one wins, so the class never hid anything.
  tasksSection.hidden = false;
  gridSection.hidden = false;
  durationSection.hidden = true;

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
      durationSection.hidden = false;
      break;
  }
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

if (pauseBtn) pauseBtn.addEventListener('click', handlePlaybackToggle);
if (toggleDrawerBtn) toggleDrawerBtn.addEventListener('click', () => toggleDrawer('add-task'));
if (anchorBtn) anchorBtn.addEventListener('click', () => toggleDrawer('add-cue'));

if (createForm) {
  createForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const titleInput = document.getElementById('task-title') as HTMLInputElement | null;
    const actionInput = document.getElementById('action-trigger') as HTMLInputElement | null;
    const dodInput = document.getElementById('definition-of-done') as HTMLInputElement | null;

    const title = titleInput?.value.trim() || '';
    const actionTrigger = actionInput?.value.trim() || '';
    const definitionOfDone = dodInput?.value.trim() || '';

    if (title || currentBlockType === 'recharge') {
      await handleSubmit(title, actionTrigger, definitionOfDone);
    }

    createForm.reset();
    selectedApps = [];
    renderSelected();
    toggleDrawer(activeDrawer);
  });
}
