import { setFitChoice } from './dayState';
import type { FitChoice } from './fit';
import { describeFit } from './fitText';
import { onDayRefreshed, refreshDay, type LoadedDay } from './scheduleUi';

// Tells the user when today does not fit and lets them pick the way out (the words are in
// fitText.ts). The recommended way is already applied while they have not chosen, so the day is
// valid either way; this is where they stay in charge of it.

const TYPE_LABEL: Record<string, string> = { deep: 'Deep work', routine: 'Routine', reset: 'Reset', recharge: 'Recharge' };

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

async function choose(day: LoadedDay, choice: FitChoice | undefined) {
  setFitChoice(day.isoDate, choice);
  await refreshDay();
}

function render(day: LoadedDay) {
  const panel = el('fit-panel');
  const badge = el('btn-fit');
  if (!panel) return;

  const titleOf = (id: string) => {
    const block = day.blocks.find((b) => b.id === id);
    return block?.title.trim() || TYPE_LABEL[block?.blockType ?? ''] || 'A block';
  };
  const description = describeFit(day.dayPlan.fit, titleOf);

  panel.hidden = description === null;
  if (badge) badge.hidden = !description?.asking;
  if (!description) return;

  const headline = document.createElement('p');
  headline.className = 'text-sm font-medium text-slate-100';
  headline.textContent = description.headline;
  panel.replaceChildren(headline);

  if (description.note) {
    const note = document.createElement('p');
    note.className = 'text-xs text-slate-400';
    note.textContent = description.note;
    panel.append(note);
  }

  for (const option of description.options) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.choice = option.choice;
    button.dataset.recommended = String(option.recommended);
    button.className = `cursor-pointer flex flex-col items-start gap-0.5 px-3 py-2 text-left rounded-lg border transition-colors ${
      option.recommended
        ? 'bg-indigo-600 hover:bg-indigo-500 border-indigo-500 text-slate-100'
        : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-200'
    }`;
    const label = document.createElement('span');
    label.className = 'text-sm font-semibold';
    label.textContent = option.recommended ? `${option.label} (recommended)` : option.label;
    const hint = document.createElement('span');
    hint.className = 'text-xs opacity-80';
    hint.textContent = option.hint;
    button.append(label, hint);
    button.addEventListener('click', () => void choose(day, option.choice));
    panel.append(button);
  }

  if (description.canChange) {
    const change = document.createElement('button');
    change.type = 'button';
    change.id = 'btn-fit-change';
    change.textContent = 'Change';
    change.className = 'cursor-pointer self-start px-2.5 py-1 text-xs font-semibold text-slate-300 bg-slate-800 hover:bg-slate-700 rounded-md transition-colors';
    change.addEventListener('click', () => void choose(day, undefined));
    panel.append(change);
  }
}

export function initFitUi() {
  onDayRefreshed(render);
}
