import { invoke } from '@tauri-apps/api/core';
import { resolveDuration } from './attach';
import { refreshCues } from './cueUi';
import { autoPlaceEnabled } from './prefs';
import { onDayRefreshed, refreshDay, suggestForNewBlock, todayHasCues } from './scheduleUi';
import { STARTER_CUES } from './starterCues';
import type { BlockType, Urgency } from './scheduler';
import { needsUrgency } from './urgency';

// The "where does it go" part of the new-block form. When the app places blocks it only says where
// this one will go, and why. When the user has turned that off it fills in the "Follows" choice with
// the suggested place instead; they can always pick something else, and once they have, the
// suggestion stops touching the field, because a pick they made on purpose must not be undone by
// editing the title afterwards.

export function initSuggestUi(read: () => { blockType: BlockType; urgency: Urgency | null }) {
  const select = document.getElementById('block-attach') as HTMLSelectElement | null;
  const hint = document.getElementById('attach-suggestion');
  const title = document.getElementById('task-title') as HTMLInputElement | null;
  const length = document.getElementById('block-duration') as HTMLInputElement | null;
  let picked = false;
  const label = document.getElementById('attach-label');
  const help = document.getElementById('attach-help');
  const noCues = document.getElementById('no-cues');
  const seedError = document.getElementById('seed-error');

  // When the app places blocks, there is nothing to choose: the form only says where the block
  // will go. The picker is back when the user turns that off. Without cues there is no place to go
  // at all, so the form says so and offers a typical day to start from.
  function renderMode() {
    const auto = autoPlaceEnabled();
    if (select) select.hidden = auto;
    if (help) help.hidden = auto;
    if (label) label.textContent = auto ? 'Where it goes' : 'Follows';
    if (noCues) noCues.hidden = todayHasCues();
  }

  async function addStarterCues() {
    if (seedError) {
      seedError.textContent = '';
      seedError.hidden = true;
    }
    try {
      for (const cue of STARTER_CUES) await invoke('create_cue', { input: cue });
    } catch (err) {
      if (seedError) {
        seedError.textContent = typeof err === 'string' ? err : 'Could not add the cues.';
        seedError.hidden = false;
      }
    }
    await refreshCues(); // the list in Settings
    await refreshDay(); // and the plan, which now has something to schedule around
  }

  const show = (text: string) => {
    if (!hint) return;
    hint.textContent = text;
    hint.hidden = text === '';
  };

  function refresh() {
    renderMode();
    if (!select) return;
    const { blockType, urgency } = read();
    const minutes = resolveDuration(length?.value ?? '');

    // A work block is only ranked once it has been classified, and a block advised to drop (Q4)
    // is not placed at all, so there is nothing to suggest until both are known.
    const ready = minutes.ok && urgency !== 'neither' && (!needsUrgency(blockType) || urgency !== null);
    const suggestion = ready
      ? suggestForNewBlock({ blockType, urgency, durationMin: minutes.value, title: title?.value ?? '' })
      : null;

    const value = suggestion?.kind === 'slot' ? `${suggestion.parent.kind}:${suggestion.parent.id}` : '';
    if (!picked) select.value = [...select.options].some((o) => o.value === value) ? value : '';

    if (!suggestion) show('');
    else show(suggestion.kind === 'slot' ? `${autoPlaceEnabled() ? 'Will go' : 'Suggested'}: ${suggestion.reason}` : suggestion.reason);
  }

  select?.addEventListener('change', () => {
    picked = true;
  });
  title?.addEventListener('input', refresh);
  length?.addEventListener('input', refresh);
  document.getElementById('btn-seed-cues')?.addEventListener('click', () => void addStarterCues());
  onDayRefreshed(refresh);
  renderMode();

  return {
    refresh,
    // After the form is cleared the next block starts from a clean slate.
    reset() {
      picked = false;
      show('');
    },
  };
}
