import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';

export interface TaskItem {
  title: string;
  actionTrigger?: string;
  definitionOfDone?: string;
}

type Drawer = 'add-task' | 'add-cue' | null;
type BlockType = 'deep' | 'routine' | 'reset' | 'recharge';

const appWindow = getCurrentWindow();
let activeDrawer: Drawer = null;
let currentBlockType: BlockType = 'deep';

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

const COMPACT_SIZE = new LogicalSize(460, 68);
const EXPANDED_SIZE = new LogicalSize(460, 420);

const playSVG = `<svg class="w-3.5 h-3.5 text-amber-400" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`;
const pauseSVG = `<svg class="w-3.5 h-3.5 text-slate-400 hover:text-slate-100" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;

window.addEventListener('DOMContentLoaded', async () => {
	await appWindow.setSize(COMPACT_SIZE);
	initBlockSelector();
});

async function handleSubmit(title: string, actionTrigger: string, definitionOfDone: string) {
	try {
		const orderIndex = await invoke<number>("get_next_order_index");
		
		const primaryTask: TaskItem = {
			title,
			actionTrigger: actionTrigger || undefined,
			definitionOfDone: definitionOfDone || undefined,
		};

		await invoke<void>("create_container", {
			task: primaryTask,
			orderIndex: orderIndex,
		});

		console.log("Container deployed successfully!");
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
		drawerElement.style.maxHeight = '320px';
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

	tasksSection.classList.remove('hidden');
	gridSection.classList.remove('hidden');
	durationSection.classList.add('hidden');

	switch (type) {
		case 'deep':
			break;
		case 'routine':
			break;
		case 'reset':
			gridSection.classList.add('hidden');
			break;
		case 'recharge':
			tasksSection.classList.add('hidden');
			gridSection.classList.add('hidden');
			durationSection.classList.remove('hidden');
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
		toggleDrawer(activeDrawer);
	});
}
