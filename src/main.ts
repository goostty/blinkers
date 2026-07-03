import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';


interface BaseBlock {
  id: string;
  title: string;
  type: 'deep' | 'routine' | 'reset' | 'recharge';
}

interface DeepWorkBlock extends BaseBlock {
  type: 'deep';
  setupTasks: string[];
  objectiveTasks: string[];
  breakTasks: string[];
  isStaticAnchor: boolean;
  startTime?: string; // e.g., "16:00" if locked
}

interface RoutineBlock extends BaseBlock {
  type: 'routine';
  setupTasks: string[];
  objectiveTasks: string[];
}

interface ResetBlock extends BaseBlock {
  type: 'reset';
  objectiveTasks: string[];
  targetDurationMins: number;
}

interface RechargeBlock extends BaseBlock {
  type: 'recharge';
  targetDurationMins: number;
  maxDurationCapMins: number;
}

// 1. Initialize the Native Tauri Window instance
const appWindow = getCurrentWindow();

// 2. Fetch DOM Layout Elements
const pauseBtn = document.getElementById('btn-pause');
const anchorBtn = document.getElementById('create-anchor');
const toggleDrawerBtn = document.getElementById('btn-toggle-drawer');
const drawer = document.getElementById('creation-drawer');
const drawerIcon = document.getElementById('icon-drawer');
const createForm = document.getElementById('form-create-container');
const stateBadge = document.getElementById('current-state-badge');
const taskList = document.getElementById('tasks');
const addTaskButton = document.getElementById('add-task');
const setupList = document.getElementById('setup');
const addSetupButton = document.getElementById('add-setup');
const breakList = document.getElementById('breaks');
const addBreakButton = document.getElementById('add-break');

// 2.1 Types of Blocks
const deepWorkBlock = document.getElementById('deep-work');
const routineBlock = document.getElementById('routine-block');
const resetBlock = document.getElementById('reset-block');
const rechargeBlock = document.getElementById('recharge-block');

// 2.2 Define types for our blocks
type Block = DeepWorkBlock | RoutineBlock | ResetBlock | RechargeBlock;
type BlockType = 'deep' | 'routine' | 'reset' | 'recharge';
const blockOrder: BlockType[] = ['deep', 'routine', 'reset', 'recharge'];
let currentBlockType: BlockType = 'deep';
let dailyTimeLine: Block[] = [];

let activeBlock = await invoke<DeepWorkBlock>("fetch_container");
dailyTimeLine.push(activeBlock);


// 3. Application State Flags
let isCurrentlyPaused = false;
let isDrawerOpen = false;

// 4. Exact Pixel Dimensions for the Operating System Window Frame
// (Width, Height) matching our Tailwind sizing layouts
const COMPACT_SIZE = new LogicalSize(460, 68);
const EXPANDED_SIZE = new LogicalSize(460, 500);

// 5. Clean, Multi-OS SVG Path Definitions
const playSVG = `<svg class="w-3.5 h-3.5 text-amber-400" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`;
const pauseSVG = `<svg class="w-3.5 h-3.5 text-slate-400 hover:text-slate-100" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;

// 6. Variables
let task_number = 0;
let setup_number = 0;
let break_number = 0;

// Force the OS window to match our tight, compact HUD bar styling when the page loads
window.addEventListener('DOMContentLoaded', () => {
	appWindow.setSize(COMPACT_SIZE);
});

async function handleSubmit(setup_list: string[], work_list: string[], break_list: string[]) {
	try {
		let index = await invoke<number>("get_next_order_index");
		await invoke<void>("create_container", { setup: setup_list, tasks: work_list, breaks: break_list, order_index: index });
	} catch (errorMessage) {
		console.error("Command Failed: ", errorMessage);
	}
}

/**
 * Handles the "Music Player" Play/Pause Style Toggle Behavior
 */
function handlePlaybackToggle() {
	isCurrentlyPaused = !isCurrentlyPaused;

	if (isCurrentlyPaused) {
		// STATE: App is Frozen
		if (pauseBtn) {
			pauseBtn.innerHTML = playSVG;
			pauseBtn.title = "Resume Task";
		}
		if (stateBadge) {
			stateBadge.innerText = 'PAUSED';
			stateBadge.className = 'text-[9px] font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20 px-1.5 py-0.5 rounded-full uppercase';
		}

		console.log("IPC: Sending Pause Command down to Go Engine...");
		// TODO: Connect Tauri IPC Bridge
		// invoke("pause_timer");

	} else {
		// STATE: App is Running
		if (pauseBtn) {
			pauseBtn.innerHTML = pauseSVG;
			pauseBtn.title = "Pause Task";
		}
		if (stateBadge) {
			stateBadge.innerText = 'SETUP'; // Dynamic depending on the active container state
			stateBadge.className = 'text-[9px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-1.5 py-0.5 rounded-full uppercase';
		}

		// Handle Action

		console.log("IPC: Sending Resume Command down to Go Engine...");
		// TODO: Connect Tauri IPC Bridge
		// invoke("resume_timer");
	}
}

/**
 * Handles the Slidable Drawer Container Animation & OS Window Resizing
 */
function toggleDrawer() {
	isDrawerOpen = !isDrawerOpen;

	if (isDrawerOpen) {
		// Expand Sequence: Grow OS window FIRST, then animate UI elements down
		appWindow.setSize(EXPANDED_SIZE).then(() => {
			if (drawer) {
				drawer.style.maxHeight = '300px';
				drawer.classList.remove('border-t-border-slate-800/0');
				drawer.classList.add('border-t', 'border-slate-800/60');
			}
			// Rotate the plus icon (+) 45 degrees to turn it into a close cross (x)
			if (drawerIcon) {
				drawerIcon.classList.add('rotate-45');
			}
		});
	} else {
		// Collapse Sequence: Animate UI elements up, then shrink the OS window box
		if (drawer) {
			drawer.style.maxHeight = '0px';
			drawer.classList.remove('border-t', 'border-slate-800/60');
		}
		if (drawerIcon) {
			drawerIcon.classList.remove('rotate-45');
		}

		// Delay shrinking the native frame until the 300ms CSS height slide animation clears
		setTimeout(() => {
			if (!isDrawerOpen) {
				appWindow.setSize(COMPACT_SIZE);
			}
		}, 300);
	}
}

function updateFormLayout(type: BlockType) {
  const tasksSection = document.getElementById('tasks-section');
  const gridSection = document.getElementById('grid-section');
  const setupSection = document.getElementById('setup-section');
  const breakSection = document.getElementById('break-section');
  const durationSection = document.getElementById('duration-section');

  if (!tasksSection || !gridSection || !setupSection || !breakSection || !durationSection) return;

  // Reset visibilities to baseline default
  tasksSection.classList.remove('hidden');
  gridSection.classList.remove('hidden');
  setupSection.classList.remove('hidden');
  breakSection.classList.remove('hidden');
  durationSection.classList.add('hidden');

  switch (type) {
    case 'deep':
      // Deep Work uses absolutely everything
      break;

    case 'routine':
      // Setup + Tasks only. No break. Change grid style to span full width.
      breakSection.classList.add('hidden');
      setupSection.className = "flex flex-col gap-2 col-span-2"; // span full width
      break;

    case 'reset':
      // Only Tasks. No setup, no breaks.
      gridSection.classList.add('hidden');
      break;

    case 'recharge':
      // No tasks, no phases. Only show max-time configuration.
      tasksSection.classList.add('hidden');
      gridSection.classList.add('hidden');
      durationSection.classList.remove('hidden');
      break;
  }
}

function initBlockSelector() {
	console.log("initBlockSelector function fired!");
  const overlay = document.getElementById('tab-overlay');

	const buttons = [deepWorkBlock, routineBlock, resetBlock, rechargeBlock];
  
  buttons.forEach((button, index) => {
    if (!button) return;

    button.addEventListener('click', () => {
			const selectedType = blockOrder[index];
      currentBlockType = selectedType;
      
      // Handle the sliding overlay animation
      if (overlay) {
        overlay.className = "absolute top-1 bottom-1 left-1 w-[calc(25%-4px)] bg-indigo-600 rounded-md shadow-md transition-transform duration-300 ease-in-out transform z-0";
        
        if (index === 1) overlay.classList.add('translate-x-[100%]');
        else if (index === 2) overlay.classList.add('translate-x-[200%]');
        else if (index === 3) overlay.classList.add('translate-x-[300%]');
        else overlay.classList.add('translate-x-0');
      }

      // Handle active/inactive text color toggling
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

      // Dynamically re-structure the form layouts
      updateFormLayout(selectedType);
    });
  });
}

function addTask() {
	const newInput = document.createElement('input');
	newInput.type = 'text';
	newInput.name = 'objective-tasks';
	task_number++;
	let n_str = String(task_number);
	newInput.placeholder = n_str + '.';
	newInput.className = "w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-indigo-500 placeholder:text-slate-500"
	if (taskList) taskList.appendChild(newInput);
}


function addSetup() {
	const newInput = document.createElement('input');
	newInput.type = 'text';
	newInput.name = 'setup-tasks';
	setup_number++;
	let n_str = String(setup_number);
	if (setup_number == 1) {
		newInput.placeholder = n_str + '.' + '(Anchor)';
		newInput.required = true;
	} else {
		newInput.placeholder = n_str + '.';
	}
	newInput.className = "w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-indigo-500 placeholder:text-slate-500"
	if (setupList) setupList.appendChild(newInput);
}


function addBreak() {
	const newInput = document.createElement('input');
	newInput.type = 'text';
	newInput.name = 'break-tasks';
	break_number++;
	let n_str = String(break_number);
	if (break_number == 1) {
		newInput.placeholder = n_str + '.' + '(Transition)';
	} else {
		newInput.placeholder = n_str + '.';	
	}
	newInput.className = "w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-indigo-500 placeholder:text-slate-500";
	if (breakList) breakList.appendChild(newInput);
}

function addAnchor() {
	return;	
}

// Attach Event Listeners to Buttons
if (pauseBtn) pauseBtn.addEventListener('click', handlePlaybackToggle);
if (toggleDrawerBtn) toggleDrawerBtn.addEventListener('click', toggleDrawer);
if (addTaskButton) addTaskButton.addEventListener('click', addTask);
if (addSetupButton) addSetupButton.addEventListener('click', addSetup);
if (addBreakButton) addBreakButton.addEventListener('click', addBreak);
if (anchorBtn) anchorBtn.addEventListener('click', addAnchor);


// Intercept form submissions to extract data structures and deploy them to Go
if (createForm) {
	createForm.addEventListener('submit', (e) => {
		e.preventDefault(); // Stop standard browser page-reloads

		const formElement = e.currentTarget as HTMLFormElement;
		const formData = new FormData(formElement);
		const task_list = formData.getAll('objective-tasks') as string[];
		const setup_list = formData.getAll('setup-tasks') as string[];
		const break_list = formData.getAll('break-tasks') as string[];

		// Call Rust Function to store lists
		handleSubmit(setup_list, task_list, break_list);


		console.log("Form Submitted!!");

		// Reset and collapse the form drawer back up cleanly after submission
		formElement.reset();

		if (taskList) {
			const extraTasks = taskList.querySelectorAll('input[name="objective-tasks"]');
			extraTasks.forEach((input) => { input.remove(); });
		}

		if (setupList) {
			const extraSetups = setupList.querySelectorAll('input[name="setup-tasks"]');
			extraSetups.forEach((input) => { input.remove(); });
		}

		if (breakList) {
			const extraBreaks = breakList.querySelectorAll('input[name="break-tasks"]');
			extraBreaks.forEach((input) => { input.remove(); });
		}

		task_number = 0;
		setup_number = 0;
		break_number = 0;
		toggleDrawer();
	});
}

// At the very bottom of your script file:
initBlockSelector();
