import { canFinish } from './finish';

export type BlockActionKind = 'start' | 'finish' | 'lapse' | 'reschedule' | 'drop';

// `waitSec` is how long until a disabled button turns on; 0 when it is already enabled.
export interface BlockAction {
  action: BlockActionKind;
  enabled: boolean;
  waitSec: number;
}

export interface BlockActions {
  actions: BlockAction[];
  // How a block that is over ended, so the UI can label it instead of showing buttons.
  settled: 'finished' | 'lapsed' | 'missed' | null;
}

// The buttons mirror what the Rust commands will accept (commitments.rs), so the UI never offers
// one the backend would refuse: Start before it begins, Finish after half the entered length,
// and Lapse only once the whole length has run out since Start. Lapse waits for the full length
// on purpose: it is for a block whose time ran out, not a way to quit early, so giving up costs
// more than finishing. A missed block gets Reschedule and Drop. A status this code does not know
// shows nothing rather than guessing.
export function blockActions(
  c: { status: string; startedAt: number | null; durationMin: number },
  nowSec: number,
): BlockActions {
  switch (c.status) {
    case 'planned':
    case 'nagging':
      return { actions: [{ action: 'start', enabled: true, waitSec: 0 }], settled: null };

    case 'started': {
      const finish = canFinish(c.startedAt, nowSec, c.durationMin);
      const lapseWait =
        c.startedAt === null
          ? Infinity
          : Math.max(0, c.durationMin * 60 - Math.max(0, nowSec - c.startedAt));
      return {
        actions: [
          { action: 'finish', enabled: finish.ok, waitSec: finish.waitSec },
          { action: 'lapse', enabled: lapseWait === 0, waitSec: lapseWait },
        ],
        settled: null,
      };
    }

    // A missed block can still be saved: put it somewhere new or give it up. Neither waits, because
    // the time that mattered has already gone.
    case 'missed':
      return {
        actions: [
          { action: 'reschedule', enabled: true, waitSec: 0 },
          { action: 'drop', enabled: true, waitSec: 0 },
        ],
        settled: 'missed',
      };

    case 'finished':
    case 'lapsed':
      return { actions: [], settled: c.status };

    default:
      return { actions: [], settled: null };
  }
}
