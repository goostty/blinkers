// @vitest-environment jsdom
//
// Starts the real app (index.html + main.ts) in a simulated browser with the Tauri backend
// replaced by a stub, and uses it the way a person would. The unit tests cover the logic; this
// covers the wiring they cannot see, such as an error at startup that leaves buttons dead.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import indexHtml from '../../index.html?raw';

type Call = { cmd: string; args: Record<string, unknown> };
type Handler = (args: Record<string, unknown>) => unknown;

const SYNC_OFF = { enabled: false, folder: null, deviceId: 'me', lastSyncedAt: null, remote: null, state: 'off' };
const MORNING = { id: 'morning', label: 'Morning', timeMin: 480, days: [0, 1, 2, 3, 4, 5, 6], flexMin: 0, endsDay: false };

let calls: Call[];
let handlers: Record<string, Handler>;
let errors: unknown[][];
let timers: ReturnType<typeof setInterval>[] = [];
let realPlacementDefault = false; // a test of the real default setting turns this on

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const called = (cmd: string) => calls.filter((c) => c.cmd === cmd);

// Waits for something the app does in the background, instead of guessing how long it takes.
// It counts its waits instead of reading the clock, because a test that pins the clock would
// otherwise never reach the deadline.
async function until(done: () => boolean, ms = 1500) {
  for (let waited = 0; !done() && waited < ms; waited += 10) await settle(10);
}

function type(el: HTMLInputElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function submitBlockForm() {
  $<HTMLFormElement>('form-create-container').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

// Mounts the page and starts the app, as the browser does when it loads the module script.
async function startApp(overrides: Record<string, Handler> = {}) {
  calls = [];
  errors = [];
  handlers = {
    list_cues: () => [MORNING],
    get_profile: () => ({ chronotype: 'neutral' }),
    list_day_blocks: () => [],
    sync_commitments: () => null,
    list_commitments: () => [],
    tick_reminders: () => ({ sent: 0, missed: 0, failed: null }),
    get_ntfy_topic: () => 'blinkers_testtopic',
    set_ntfy_topic: () => null,
    prune_expired_cues: () => 0,
    dismiss_block: () => null,
    update_block: () => null,
    get_next_order_index: () => 0,
    create_container: () => 'new-block-id',
    set_profile: () => null,
    get_sync_status: () => SYNC_OFF,
    run_sync: () => ({ kind: 'off' }),
    set_sync_folder: () => SYNC_OFF,
    get_synced_setting: () => null,
    set_synced_setting: () => null,
    create_cue: () => null,
    update_cue: () => null,
    delete_cue: () => null,
    ...overrides,
  };

  vi.spyOn(console, 'error').mockImplementation((...args) => {
    errors.push(args);
  });

  // Every test starts a fresh copy of the app, and the old copy's once-a-second timer would keep
  // repainting the new page from its own stale data. Remember the timers so they can be stopped.
  const realSetInterval = globalThis.setInterval;
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((...args: Parameters<typeof setInterval>) => {
    const id = realSetInterval(...args);
    timers.push(id);
    return id;
  }) as typeof setInterval);

  Object.assign(window, {
    __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
      invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
        calls.push({ cmd, args });
        const handler = handlers[cmd];
        return handler ? handler(args) : null; // window and plugin calls
      },
      transformCallback: () => 1,
      convertFileSrc: (path: string) => path,
    },
  });

  // Most tests are about what the user does by hand, so placing blocks automatically is off unless
  // a test turns it on; the tests of the automatic placement do.
  if (!realPlacementDefault && localStorage.getItem('blinkers.autoplace') === null) localStorage.setItem('blinkers.autoplace', 'off');

  document.body.innerHTML = new DOMParser().parseFromString(indexHtml, 'text/html').body.innerHTML;
  vi.resetModules();
  await import('../main');
  await settle(60);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  timers.forEach((id) => clearInterval(id));
  timers = [];
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  localStorage.clear();
  realPlacementDefault = false;
});

describe('starting the app', () => {
  it('sets everything up without a single error', async () => {
    await startApp();
    expect(errors).toEqual([]);
  });

  it('plans today on launch', async () => {
    await startApp();
    expect(called('list_day_blocks').length).toBeGreaterThanOrEqual(1); // the block buttons load the day too
    expect(called('sync_commitments')).toHaveLength(1);
  });

  it('fills in the hint under Length', async () => {
    await startApp();
    expect($('duration-hint').textContent).toMatch(/overestimate/i);
  });

  it('keeps the rest of the app working when one startup step fails', async () => {
    // Resizing the window is one of the first startup steps; the cue buttons are set up after it.
    await startApp({ 'plugin:window|set_size': () => Promise.reject('no window') });

    click($('btn-add-cue'));
    expect($('cue-modal').hidden).toBe(false);
    expect(errors.some((e) => String(e[0]).includes('window size'))).toBe(true); // reported, not hidden
  });
});

describe('cues and rhythm', () => {
  it('opens the new-cue form from the Add Cue button', async () => {
    await startApp();
    click($('btn-add-cue'));
    expect($('cue-modal').hidden).toBe(false);
  });

  it('saves the rhythm that was picked and highlights it', async () => {
    await startApp();
    const morning = document.querySelector('[data-chronotype="morning"]')!;
    click(morning);
    await settle();

    expect(called('set_profile')[0].args.profile).toMatchObject({ chronotype: 'morning' });
    expect(morning.getAttribute('aria-pressed')).toBe('true');
  });

  it('sends the end-of-day mark when a cue is saved', async () => {
    await startApp();
    click($('btn-add-cue'));
    type($('cue-label'), 'Bedtime');
    type($('cue-time'), '22:00');
    $<HTMLInputElement>('cue-ends-day').checked = true;
    click($('btn-cue-save'));
    await settle();

    expect(called('create_cue')[0].args.input).toMatchObject({ label: 'Bedtime', timeMin: 1320, endsDay: true });
  });
});

describe('making a block', () => {
  async function fillIn(over: { title?: string; length?: string; urgency?: string; follows?: string } = {}) {
    type($('task-title'), over.title ?? 'Write report');
    type($('block-duration'), over.length ?? '45');
    if (over.urgency !== '') click(document.querySelector(`[data-urgency="${over.urgency ?? 'important'}"]`)!);
    $<HTMLSelectElement>('block-attach').value = over.follows ?? 'cue:morning';
  }

  it('lets the length be typed, with no spinner arrows', async () => {
    await startApp();
    expect($<HTMLInputElement>('block-duration').type).toBe('text');
  });

  it('offers the cues as places a block can follow', async () => {
    await startApp();
    const values = [...$<HTMLSelectElement>('block-attach').options].map((o) => o.value);
    expect(values).toEqual(['', 'cue:morning']);
  });

  it('sends the typed length, the chosen parent and the urgency', async () => {
    await startApp();
    await fillIn();
    submitBlockForm();
    await settle();

    const created = called('create_container')[0];
    expect(created.args).toMatchObject({
      blockType: 'deep',
      urgency: 'important',
      durationMin: 45,
      parent: { kind: 'cue', id: 'morning' },
    });
  });

  it('refuses a length that is not a whole number of minutes, and says why', async () => {
    await startApp();
    for (const bad of ['abc', '', '0', '2.5', '1441']) {
      await fillIn({ length: bad });
      submitBlockForm();
      await settle();
      expect(called('create_container'), bad).toHaveLength(0);
      expect($('duration-error').hidden, bad).toBe(false);
    }
  });

  it('refuses a block that does not say what it follows', async () => {
    await startApp();
    await fillIn({ follows: '' });
    submitBlockForm();
    await settle();

    expect(called('create_container')).toHaveLength(0);
    expect($('attach-error').textContent).toMatch(/follows/i);
  });

  it('refuses a work block with no urgency picked', async () => {
    await startApp();
    await fillIn({ urgency: '' });
    submitBlockForm();
    await settle();

    expect(called('create_container')).toHaveLength(0);
    expect($('urgency-error').hidden).toBe(false);
  });

  it('does not ask a block advised to drop (Q4) what it follows', async () => {
    await startApp();
    await fillIn({ urgency: 'neither', follows: '' });
    expect($('attach-section').hidden).toBe(true);
    submitBlockForm();
    await settle();

    expect(called('create_container')[0].args).toMatchObject({ urgency: 'neither', parent: null });
  });

  it('shows the Follows choice again when the urgency changes back', async () => {
    await startApp();
    click(document.querySelector('[data-urgency="neither"]')!);
    expect($('attach-section').hidden).toBe(true);
    click(document.querySelector('[data-urgency="important"]')!);
    expect($('attach-section').hidden).toBe(false);
  });

  it('makes a rest block say what it follows, and sends no urgency for it', async () => {
    await startApp();
    click($('recharge-block'));
    type($('block-duration'), '30');
    $<HTMLSelectElement>('block-attach').value = 'cue:morning';
    submitBlockForm();
    await settle();

    expect(called('create_container')[0].args).toMatchObject({
      blockType: 'recharge',
      urgency: null,
      durationMin: 30,
      parent: { kind: 'cue', id: 'morning' },
    });
  });

  it('only requires a title while the title field can be seen', async () => {
    await startApp();
    expect($<HTMLInputElement>('task-title').required).toBe(true);
    click($('recharge-block')); // recharge has no title, and a hidden required field blocks the whole form
    expect($<HTMLInputElement>('task-title').required).toBe(false);
    click($('deep-work'));
    expect($<HTMLInputElement>('task-title').required).toBe(true);
  });

  it('asks for about 1.5 times the estimate on work, and not on rest', async () => {
    await startApp();
    expect($('duration-hint').textContent).toMatch(/overestimate/i);
    expect($('duration-hint').textContent).toContain('1.5');
    click($('routine-block'));
    expect($('duration-hint').textContent).toMatch(/overestimate/i);
    expect($('duration-hint').textContent).toContain('1.5');
    click($('reset-block'));
    expect($('duration-hint').textContent).not.toMatch(/overestimate/i);
    click($('recharge-block'));
    expect($('duration-hint').textContent).toMatch(/resting/i);
    expect($('duration-hint').textContent).not.toMatch(/overestimate/i);
  });
});

describe('blocks waiting for a place', () => {
  const carriedOver = {
    id: 'old',
    blockType: 'deep',
    orderIndex: 0,
    title: 'Left over',
    urgency: 'urgent-important',
    createdOn: '2000-01-01',
    durationMin: 60,
    parentKind: null,
    parentId: null,
    isCompleted: false,
    endedAtMin: null,
    committed: false,
  };

  it('lists a carried-over block and attaches it where the user says', async () => {
    await startApp({ list_day_blocks: () => [carriedOver], attach_block: () => null });

    expect($('unattached-section').hidden).toBe(false);
    expect($('unattached-list').textContent).toContain('Left over');

    const select = $('unattached-list').querySelector('select')!;
    select.value = 'cue:morning';
    click($('unattached-list').querySelector('button')!);
    await settle();

    expect(called('attach_block')[0].args).toMatchObject({ blockId: 'old', parent: { kind: 'cue', id: 'morning' } });
  });

  describe('removing a block from the queue', () => {
    let waiting: Array<Record<string, unknown>>;
    const queueRow = () => $('unattached-list').querySelector('li');
    const dropButton = () => [...(queueRow()?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Drop');

    beforeEach(() => {
      waiting = [carriedOver];
    });

    it('offers Drop on every waiting block, next to Attach', async () => {
      await startApp({ list_day_blocks: () => waiting });
      const labels = [...queueRow()!.querySelectorAll('button')].map((b) => b.textContent);
      expect(labels).toEqual(['Attach', 'Drop']);
    });

    it('drops the block, and the queue and the header count empty out', async () => {
      await startApp({
        list_day_blocks: () => waiting,
        dismiss_block: () => {
          waiting = [];
          return null;
        },
      });
      expect($('btn-place').hidden).toBe(false);

      click(dropButton()!);
      await until(() => queueRow() === null);

      expect(called('dismiss_block')[0].args).toMatchObject({ blockId: 'old' });
      expect(called('attach_block')).toHaveLength(0); // dropping is not attaching
      expect($('unattached-section').hidden).toBe(true);
      expect($('btn-place').hidden).toBe(true);
      expect(errors).toEqual([]);
    });

    it('plans the day again after a drop, so what followed it closes up', async () => {
      await startApp({ list_day_blocks: () => waiting, dismiss_block: () => { waiting = []; return null; } });
      const plansBefore = called('sync_commitments').length;
      click(dropButton()!);
      await until(() => queueRow() === null);
      expect(called('sync_commitments').length).toBeGreaterThan(plansBefore);
    });

    it('says why a drop failed, in the row, and keeps the block', async () => {
      await startApp({ list_day_blocks: () => waiting, dismiss_block: () => Promise.reject('That block no longer exists.') });
      click(dropButton()!);
      await until(() => !(queueRow()?.querySelector('p')?.hidden ?? true));

      expect(queueRow()!.textContent).toContain('no longer exists');
      expect(queueRow()).not.toBeNull();
    });

    it('leaves the other waiting blocks alone', async () => {
      waiting = [carriedOver, { ...carriedOver, id: 'older', title: 'Older leftover' }];
      await startApp({
        list_day_blocks: () => waiting,
        dismiss_block: (a) => {
          waiting = waiting.filter((b) => b.id !== a.blockId);
          return null;
        },
      });
      click(dropButton()!);
      await until(() => $('unattached-list').querySelectorAll('li').length === 1);

      expect($('unattached-list').textContent).toContain('Older leftover');
      expect($('unattached-list').textContent).not.toContain('Left over ·');
    });
  });

  it('asks for a choice before attaching', async () => {
    await startApp({ list_day_blocks: () => [carriedOver], attach_block: () => null });
    click($('unattached-list').querySelector('button')!);
    await settle();
    expect(called('attach_block')).toHaveLength(0);
    expect($('unattached-list').textContent).toMatch(/follows/i);
  });

  it('shows nothing when every block has a place', async () => {
    await startApp();
    expect($('unattached-section').hidden).toBe(true);
    expect($('btn-place').hidden).toBe(true);
  });

  it('keeps the waiting blocks in the Today tab, reached from a button that counts them', async () => {
    await startApp({ list_day_blocks: () => [carriedOver] });

    expect($('btn-place').hidden).toBe(false);
    expect($('btn-place').textContent).toContain('1');
    expect($('add-task-drawer').contains($('unattached-section'))).toBe(false); // not inside the task form
    expect($('today-drawer').contains($('unattached-section'))).toBe(true);

    click($('btn-place'));
    await settle(30); // the drawer opens after the window has been resized
    expect($('today-drawer').style.maxHeight).not.toBe('0px');
    expect($('add-task-drawer').style.maxHeight).toBe('0px');
  });

  it('opens the new-task form without the waiting list', async () => {
    await startApp({ list_day_blocks: () => [carriedOver] });
    click($('btn-toggle-drawer'));
    await settle(30);
    expect($('add-task-drawer').style.maxHeight).not.toBe('0px');
    expect($('today-drawer').style.maxHeight).toBe('0px');
  });
});

describe('starting, finishing and lapsing a block', () => {
  const nowUnix = () => Math.floor(Date.now() / 1000);
  const nowMin = () => new Date().getHours() * 60 + new Date().getMinutes();
  const MIN = 60;

  const block = {
    id: 'b1',
    blockType: 'deep',
    orderIndex: 0,
    title: 'Write report',
    urgency: 'important',
    createdOn: '2000-01-01',
    durationMin: 60,
    parentKind: 'cue',
    parentId: 'morning',
    isCompleted: false,
    endedAtMin: null,
    committed: false,
  };

  // One commitment the fake backend keeps and changes the way the real one would.
  let commitment: Record<string, unknown>;
  const make = (status: string, startedAt: number | null) => {
    commitment = { blockId: 'b1', status, startMin: nowMin(), durationMin: 60, startedAt };
  };
  const strip = () => $('focus-strip');
  const button = (action: string) => strip().querySelector<HTMLButtonElement>(`[data-action="${action}"]`);

  const backend = (extra: Record<string, Handler> = {}) => ({
    list_day_blocks: () => [block],
    list_commitments: () => [commitment],
    start_block: () => {
      commitment = { ...commitment, status: 'started', startedAt: nowUnix() };
      return { title: 'Write report', actionTrigger: null, definitionOfDone: null, apps: [{ label: 'Docs', url: 'https://example.com' }] };
    },
    finish_block: () => {
      commitment = { ...commitment, status: 'finished' };
      return null;
    },
    lapse_block: () => {
      commitment = { ...commitment, status: 'lapsed' };
      return null;
    },
    ...extra,
  });

  it('shows nothing when there is no block to act on', async () => {
    await startApp();
    expect(strip().hidden).toBe(true);
  });

  it('offers only Start for a block that has not been started, and names the block', async () => {
    make('planned', null);
    await startApp(backend());
    await until(() => !strip().hidden);

    expect(strip().hidden).toBe(false);
    expect(strip().textContent).toContain('Write report');
    expect(button('start')).not.toBeNull();
    expect(button('finish')).toBeNull();
    expect(errors).toEqual([]);
  });

  it('makes room for the strip while it is showing', async () => {
    make('planned', null);
    await startApp(backend());
    await until(() => !strip().hidden);
    await settle(20);

    // Sizes cross to the backend as JSON, so read them the way the backend would.
    const heights = called('plugin:window|set_size').map((c) => JSON.parse(JSON.stringify(c.args.value)).Logical.height);
    expect(heights[0]).toBe(68); // before the strip is there
    expect(heights[heights.length - 1]).toBeGreaterThan(68);
  });

  it('Start tells the backend, opens the block\'s apps, then offers Finish and Lapse (both waiting)', async () => {
    make('planned', null);
    await startApp(backend());

    click(button('start')!);
    await settle(80);

    expect(called('start_block')[0].args).toMatchObject({ blockId: 'b1' });
    expect(called('plugin:opener|open_url')[0].args).toMatchObject({ url: 'https://example.com' });
    expect(button('start')).toBeNull();
    expect(button('finish')!.disabled).toBe(true); // half the length has not passed
    expect(button('lapse')!.disabled).toBe(true);
    expect(errors).toEqual([]);
  });

  it('enables Finish after half the length and shows the backend\'s refusal in its own words', async () => {
    make('started', nowUnix() - 40 * MIN);
    await startApp(backend({ finish_block: () => Promise.reject('Too early to finish: keep going for 3 more minute(s).') }));

    expect(button('finish')!.disabled).toBe(false);
    expect(button('lapse')!.disabled).toBe(true);

    click(button('finish')!);
    await settle(80);

    expect(strip().textContent).toContain('Too early to finish');
  });

  it('Finish completes the block, plans the day again and clears the strip', async () => {
    make('started', nowUnix() - 40 * MIN);
    await startApp(backend());
    const plansBefore = called('sync_commitments').length;

    click(button('finish')!);
    await settle(80);

    expect(called('finish_block')[0].args).toMatchObject({ blockId: 'b1' });
    expect(called('sync_commitments').length).toBeGreaterThan(plansBefore); // the blocks after it move up
    expect(strip().hidden).toBe(true);
  });

  it('Lapse is only available once the full length has run out, then drops the block', async () => {
    make('started', nowUnix() - 61 * MIN);
    await startApp(backend());
    expect(button('lapse')!.disabled).toBe(false);

    click(button('lapse')!);
    await settle(80);

    expect(called('lapse_block')[0].args).toMatchObject({ blockId: 'b1' });
    expect(strip().hidden).toBe(true);
  });

  it('keeps Finish and Lapse switched off, and says how long to wait, until they are allowed', async () => {
    make('started', nowUnix() - 5 * MIN);
    await startApp(backend());
    await until(() => !strip().hidden);

    // A real browser never delivers a click to a disabled button, so check that it is disabled.
    expect(button('finish')!.disabled).toBe(true);
    expect(button('lapse')!.disabled).toBe(true);
    // half of 60 min with 5 done is 25:00 left, and the page may paint a second later
    expect(button('finish')!.textContent).toMatch(/^Finish · (25:0\d|24:5\d)$/);
    expect(button('lapse')!.textContent).toMatch(/^Lapse · (55:0\d|54:5\d)$/);
  });

  describe('a missed block', () => {
    // The backend as it behaves for a missed block: rescheduling frees it and clears its commitment,
    // dropping removes the block from the day.
    let live: Array<Record<string, unknown>>;
    let blockList: Array<Record<string, unknown>>;
    const missedBackend = (extra: Record<string, Handler> = {}) =>
      backend({
        list_commitments: () => live,
        list_day_blocks: () => blockList,
        reschedule_block: () => {
          live = [];
          blockList = [{ ...block, parentKind: null, parentId: null }];
          return null;
        },
        dismiss_block: () => {
          blockList = [];
          return null;
        },
        ...extra,
      });
    const missed = { blockId: 'b1', status: 'missed', startMin: 600, durationMin: 30, startedAt: null };

    beforeEach(() => {
      live = [missed];
      blockList = [block];
    });

    afterEach(() => localStorage.clear());

    it('is offered Continue, Reschedule and Abandon, with when it was missed, and no Start', async () => {
      await startApp(missedBackend());
      await until(() => !strip().hidden);

      expect(strip().textContent).toContain('Write report');
      expect(strip().textContent).toContain('Missed 10:00 AM');
      expect(button('continue')).not.toBeNull();
      expect(button('drop')!.textContent).toBe('Abandon');
      expect(button('reschedule')).not.toBeNull();
      expect(button('drop')).not.toBeNull();
      expect(button('start')).toBeNull();
      expect(errors).toEqual([]);
    });

    it('Reschedule frees the block, plans the day again, and opens the list where its new place is chosen', async () => {
      await startApp(missedBackend());
      await until(() => !strip().hidden);
      const plansBefore = called('sync_commitments').length;

      click(button('reschedule')!);
      await until(() => strip().hidden);
      await settle(50);

      expect(called('reschedule_block')[0].args).toMatchObject({ blockId: 'b1' });
      expect(called('sync_commitments').length).toBeGreaterThan(plansBefore);
      expect($('unattached-section').hidden).toBe(false);
      expect($('unattached-list').textContent).toContain('Write report');
      expect($('today-drawer').style.maxHeight).not.toBe('0px'); // opened for the user
      expect($('add-task-drawer').style.maxHeight).toBe('0px'); // and not the new-task form
    });

    it('Drop gives the block up and clears the strip', async () => {
      await startApp(missedBackend());
      await until(() => !strip().hidden);

      click(button('drop')!);
      await until(() => strip().hidden);

      expect(called('dismiss_block')[0].args).toMatchObject({ blockId: 'b1' });
      expect(strip().hidden).toBe(true);
    });

    it('Continue starts the block right now, opens its apps, and plans the day again around it', async () => {
      await startApp(
        missedBackend({
          continue_block: () => {
            live = [{ ...missed, status: 'started', startedAt: nowUnix() }];
            return { title: 'Write report', actionTrigger: null, definitionOfDone: null, apps: [{ label: 'Docs', url: 'https://example.com' }] };
          },
        }),
      );
      await until(() => !strip().hidden);
      const plansBefore = called('sync_commitments').length;

      click(button('continue')!);
      await until(() => button('finish') !== null);

      expect(called('continue_block')[0].args).toMatchObject({ blockId: 'b1' });
      expect(typeof called('continue_block')[0].args.nowUnix).toBe('number');
      expect(typeof called('continue_block')[0].args.nowMin).toBe('number');
      expect(called('sync_commitments').length).toBeGreaterThan(plansBefore);
      expect(button('continue')).toBeNull(); // it is a started block now
    });

    it('Abandon notes the time, so nothing is planned before it', async () => {
      await startApp(missedBackend());
      await until(() => !strip().hidden);

      click(button('drop')!);
      await until(() => strip().hidden);

      const stored = JSON.parse(localStorage.getItem('blinkers.day')!);
      expect(Math.abs(stored.notBeforeMin - nowMin())).toBeLessThanOrEqual(1);
    });

    it('Reschedule notes the time too, because it also frees the slot', async () => {
      await startApp(missedBackend());
      await until(() => !strip().hidden);

      click(button('reschedule')!);
      await until(() => strip().hidden);

      expect(JSON.parse(localStorage.getItem('blinkers.day')!).notBeforeMin).toBeGreaterThan(0);
    });

    it('does not note the time when Abandon is refused', async () => {
      await startApp(missedBackend({ dismiss_block: () => Promise.reject('That block no longer exists.') }));
      await until(() => !strip().hidden);

      click(button('drop')!);
      await settle(80);

      expect(localStorage.getItem('blinkers.day')).toBeNull();
    });

    it('shows the backend\'s refusal to Continue and keeps the block', async () => {
      await startApp(missedBackend({ continue_block: () => Promise.reject('Only a missed block can be continued.') }));
      await until(() => !strip().hidden);

      click(button('continue')!);
      await settle(80);

      expect(strip().textContent).toContain('Only a missed block can be continued.');
      expect(button('continue')).not.toBeNull();
    });

    it('shows the backend\'s refusal and keeps the block', async () => {
      await startApp(missedBackend({ reschedule_block: () => Promise.reject('Only a missed block can be rescheduled.') }));
      await until(() => !strip().hidden);

      click(button('reschedule')!);
      await settle(80);

      expect(strip().textContent).toContain('Only a missed block can be rescheduled.');
      expect(button('reschedule')).not.toBeNull();
    });

    it('waits behind a block that is coming up or in progress', async () => {
      const upcoming = { blockId: 'b2', status: 'planned', startMin: new Date().getHours() * 60 + new Date().getMinutes(), durationMin: 60, startedAt: null };
      live = [missed, upcoming];
      blockList = [block, { ...block, id: 'b2', title: 'Read paper' }];
      await startApp(missedBackend());
      await until(() => !strip().hidden);

      expect(strip().textContent).toContain('Read paper');
      expect(button('reschedule')).toBeNull();
    });

    it('does not bring back a block that was dropped', async () => {
      blockList = []; // the block is gone from the day, but its commitment row is still there
      await startApp(missedBackend());
      await settle(100);
      expect(strip().hidden).toBe(true);
    });
  });
});

describe('phone reminders', () => {
  it('checks for due reminders as soon as the app starts, with the local date and minute', async () => {
    await startApp();
    await until(() => called('tick_reminders').length > 0);

    const args = called('tick_reminders')[0].args;
    expect(args.on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(args.nowMin).toBe(new Date().getHours() * 60 + new Date().getMinutes());
    expect(typeof args.nowUnix).toBe('number');
    expect(errors).toEqual([]);
  });

  it('shows the private topic in the settings drawer, ready to copy', async () => {
    await startApp();
    await until(() => $<HTMLInputElement>('ntfy-topic').value !== '');

    click($('settings'));
    expect($<HTMLInputElement>('ntfy-topic').value).toBe('blinkers_testtopic');
    expect($('settings-drawer').style.maxHeight).not.toBe('0px');
  });

  it('says when a reminder went out', async () => {
    await startApp({ tick_reminders: () => ({ sent: 1, missed: 0, failed: null }) });
    await until(() => /Last reminder sent/.test($('ntfy-status').textContent ?? ''));
    expect($('ntfy-status').textContent).toMatch(/^Last reminder sent at \d{1,2}:\d{2} (AM|PM)\.$/);
  });

  it('says so when reminders are not getting through', async () => {
    await startApp({ tick_reminders: () => ({ sent: 0, missed: 0, failed: 'ntfy answered 503 Service Unavailable.' }) });
    await until(() => /not getting through/.test($('ntfy-status').textContent ?? ''));
    expect($('ntfy-status').textContent).toContain('503');
  });

  it('keeps going when the reminder check itself fails', async () => {
    await startApp({ tick_reminders: () => Promise.reject('database is locked') });
    await until(() => /not getting through/.test($('ntfy-status').textContent ?? ''));
    expect($('ntfy-status').textContent).toContain('database is locked');
    expect(errors).toEqual([]);
  });

  it('saves a topic the user types and shows the backend\'s complaint about a bad one', async () => {
    await startApp({ set_ntfy_topic: (a) => (a.topic === 'bad topic' ? Promise.reject('A topic can only use letters, digits, - and _.') : null) });
    type($('ntfy-new-topic'), 'bad topic');
    click($('btn-ntfy-save'));
    await settle(50);
    expect($('ntfy-error').hidden).toBe(false);
    expect($('ntfy-error').textContent).toContain('letters, digits');

    type($('ntfy-new-topic'), 'my_topic');
    click($('btn-ntfy-save'));
    await settle(50);
    expect(called('set_ntfy_topic')[1].args).toMatchObject({ topic: 'my_topic' });
    expect($('ntfy-error').hidden).toBe(true);
  });
});

describe('the suggested place', () => {
  const NOON = { id: 'noon', label: 'Noon', timeMin: 720, days: [0, 1, 2, 3, 4, 5, 6], flexMin: 0, endsDay: false };
  const at = (hour: number) => vi.setSystemTime(new Date(2026, 9, 19, hour, 0)); // a Monday
  const pickUrgency = (value: string) => click(document.querySelector(`[data-urgency="${value}"]`)!);
  const select = () => $<HTMLSelectElement>('block-attach');

  function describeBlock(title: string, length = '45') {
    type($('task-title'), title);
    type($('block-duration'), length);
  }

  afterEach(() => vi.useRealTimers());

  it('pre-selects the best place and says why', async () => {
    at(6);
    await startApp();
    describeBlock('Write report');
    pickUrgency('urgent-important');
    await settle();

    expect(select().value).toBe('cue:morning');
    expect($('attach-suggestion').hidden).toBe(false);
    expect($('attach-suggestion').textContent).toContain('8:00 AM');
  });

  it('waits until the block has been ranked', async () => {
    at(6);
    await startApp();
    describeBlock('Write report');
    await settle();

    expect(select().value).toBe('');
    expect($('attach-suggestion').hidden).toBe(true);
  });

  it('leaves a place the user chose alone when the name or length changes afterwards', async () => {
    at(6);
    await startApp({ list_cues: () => [MORNING, NOON] });
    describeBlock('Write report');
    pickUrgency('urgent-important');
    await settle();
    expect(select().value).toBe('cue:morning');

    select().value = 'cue:noon';
    select().dispatchEvent(new Event('change', { bubbles: true }));
    describeBlock('Write the report');
    await settle();

    expect(select().value).toBe('cue:noon');
  });

  it('says tomorrow, and picks nothing, when the time the name asks for has passed', async () => {
    at(14);
    await startApp();
    click($('routine-block'));
    describeBlock('Morning routine', '30');
    pickUrgency('important');
    await settle();

    expect(select().value).toBe('');
    expect($('attach-suggestion').textContent).toMatch(/tomorrow/i);
  });

  it('has no suggestion for a block advised to drop', async () => {
    at(6);
    await startApp();
    describeBlock('Write report');
    pickUrgency('urgent-important');
    await settle();
    pickUrgency('neither');
    await settle();

    expect($('attach-suggestion').hidden).toBe(true);
  });

  it('pre-selects the place for a block waiting in the queue', async () => {
    at(6);
    const carriedOver = {
      id: 'old', blockType: 'deep', orderIndex: 0, title: 'Left over', urgency: 'urgent-important',
      createdOn: '2000-01-01', durationMin: 60, parentKind: null, parentId: null,
      isCompleted: false, endedAtMin: null, committed: false,
    };
    await startApp({ list_day_blocks: () => [carriedOver] });

    expect($('unattached-list').querySelector('select')!.value).toBe('cue:morning');
  });
});

describe('the day follows the clock and the choices the user made', () => {
  const NOON = { id: 'noon', label: 'Noon', timeMin: 720, days: [0, 1, 2, 3, 4, 5, 6], flexMin: 0, endsDay: false };
  const unix = (hour: number, minute = 0) => Math.floor(new Date(2026, 9, 19, hour, minute).getTime() / 1000); // a Monday
  const mk = (id: string, over: Record<string, unknown> = {}) => ({
    id, blockType: 'deep', orderIndex: 0, title: id, urgency: 'important', createdOn: '2026-10-19',
    durationMin: 60, parentKind: 'cue', parentId: 'morning', isCompleted: false, endedAtMin: null, committed: false,
    ...over,
  });
  const lastPlan = () => {
    const plans = called('sync_commitments');
    return plans[plans.length - 1].args.plan as Array<{ blockId: string; startMin: number; durationMin: number }>;
  };
  const planOf = (id: string) => lastPlan().find((p) => p.blockId === id);

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('lets a block that is still running past its end push the next one later', async () => {
    vi.setSystemTime(new Date(2026, 9, 19, 10, 0));
    const blocks = [mk('write', { committed: true }), mk('email', { parentKind: 'block', parentId: 'write', durationMin: 30 })];
    await startApp({
      list_day_blocks: () => blocks,
      // write began at 08:00 for 60 minutes and it is now 10:00
      list_commitments: () => [{ blockId: 'write', status: 'started', startMin: 480, durationMin: 60, startedAt: unix(8) }],
    });

    // write ends now (10:00); being deep work it earns a 12 minute break before email
    expect(planOf('email')!.startMin).toBe(10 * 60 + 12);
  });

  it('re-plans on the timer only while a started block is past its end', async () => {
    vi.setSystemTime(new Date(2026, 9, 19, 10, 0));
    const running = { blockId: 'write', status: 'started', startMin: 480, durationMin: 60, startedAt: unix(8) };
    let commitments: unknown[] = [running];
    await startApp({ list_day_blocks: () => [mk('write', { committed: true })], list_commitments: () => commitments });
    const { replanIfOverrunning } = await import('../scheduleUi');

    const before = called('sync_commitments').length;
    await replanIfOverrunning();
    expect(called('sync_commitments').length).toBe(before + 1); // overdue, so the day is planned again

    commitments = [{ ...running, startedAt: unix(9, 50) }]; // started ten minutes ago: not overdue
    await (await import('../scheduleUi')).refreshDay();
    const quiet = called('sync_commitments').length;
    await replanIfOverrunning();
    expect(called('sync_commitments').length).toBe(quiet);
  });

  it('shortens everything for now when the day does not fit, and the user has not chosen', async () => {
    vi.setSystemTime(new Date(2026, 9, 19, 6, 0));
    const blocks = [
      mk('a', { urgency: 'urgent', durationMin: 130 }),
      mk('b', { urgency: 'urgent-important', durationMin: 130, parentKind: 'block', parentId: 'a' }),
    ];
    await startApp({ list_cues: () => [MORNING, NOON], list_day_blocks: () => blocks });

    // 08:00 to 12:00 is 240 minutes: 130 + a 20 minute break + 130 only fits 15% shorter
    expect(planOf('a')!.durationMin).toBe(111);
    expect(planOf('b')!.startMin + planOf('b')!.durationMin).toBeLessThanOrEqual(720);
  });

  it('uses the way out the user chose for today', async () => {
    vi.setSystemTime(new Date(2026, 9, 19, 6, 0));
    localStorage.setItem('blinkers.day', JSON.stringify({ date: '2026-10-19', fit: 'drop' }));
    const blocks = [
      mk('a', { urgency: 'urgent', durationMin: 130 }),
      mk('b', { urgency: 'urgent-important', durationMin: 130, parentKind: 'block', parentId: 'a' }),
    ];
    await startApp({ list_cues: () => [MORNING, NOON], list_day_blocks: () => blocks });

    expect(planOf('a')).toBeUndefined(); // the lowest priority one rolls to tomorrow
    expect(planOf('b')).toMatchObject({ startMin: 480, durationMin: 130 });
  });

  it('forgets the choice once the day fits again, so a later problem asks again', async () => {
    vi.setSystemTime(new Date(2026, 9, 19, 6, 0));
    localStorage.setItem('blinkers.day', JSON.stringify({ date: '2026-10-19', fit: 'drop' }));
    await startApp({ list_cues: () => [MORNING, NOON], list_day_blocks: () => [mk('a', { durationMin: 60 })] });

    expect(JSON.parse(localStorage.getItem('blinkers.day')!).fit).toBeUndefined();
  });

  it('does not start a block before the time the user last dealt with a missed block', async () => {
    vi.setSystemTime(new Date(2026, 9, 19, 9, 30));
    localStorage.setItem('blinkers.day', JSON.stringify({ date: '2026-10-19', notBeforeMin: 570 }));
    await startApp({ list_day_blocks: () => [mk('email', { durationMin: 30 })] });

    expect(planOf('email')!.startMin).toBe(570);
  });
});

describe('the app places blocks itself', () => {
  const unplaced = (id: string, over: Record<string, unknown> = {}) => ({
    id, blockType: 'deep', orderIndex: 0, title: id, urgency: 'important', createdOn: '2026-10-19',
    durationMin: 60, parentKind: null, parentId: null, isCompleted: false, endedAtMin: null, committed: false,
    ...over,
  });
  let list: Array<Record<string, unknown>>;
  // A backend that really moves the block when it is attached, as the real one does.
  const backend = (extra: Record<string, Handler> = {}) => ({
    list_day_blocks: () => list,
    attach_block: (a: Record<string, unknown>) => {
      const parent = a.parent as { kind: string; id: string };
      list = list.map((b) => (b.id === a.blockId ? { ...b, parentKind: parent.kind, parentId: parent.id } : b));
      return null;
    },
    ...extra,
  });
  const on = () => localStorage.setItem('blinkers.autoplace', 'on');

  beforeEach(() => {
    vi.setSystemTime(new Date(2026, 9, 19, 6, 0)); // a Monday, with the only cue at 08:00
    list = [unplaced('w', { title: 'Write report' })];
  });
  afterEach(() => vi.useRealTimers());

  it('places a block that has no place, without being asked', async () => {
    on();
    await startApp(backend());
    await until(() => called('attach_block').length > 0);

    expect(called('attach_block')[0].args).toMatchObject({ blockId: 'w', parent: { kind: 'cue', id: 'morning' }, on: '2026-10-19' });
  });

  it('leaves the "needs a place" list empty once everything is placed', async () => {
    on();
    await startApp(backend());
    await until(() => called('attach_block').length > 0);
    await settle(80);

    expect($('unattached-section').hidden).toBe(true);
    expect($('btn-place').hidden).toBe(true);
  });

  it('places the most urgent block first, so it gets the earliest slot', async () => {
    on();
    list = [unplaced('later', { urgency: 'urgent' }), unplaced('first', { urgency: 'urgent-important' })];
    await startApp(backend());
    await until(() => called('attach_block').length >= 2);

    expect(called('attach_block')[0].args).toMatchObject({ blockId: 'first', parent: { kind: 'cue', id: 'morning' } });
    expect(called('attach_block')[1].args).toMatchObject({ blockId: 'later', parent: { kind: 'block', id: 'first' } });
  });

  it('does nothing by itself when the setting is off', async () => {
    await startApp(backend()); // off by default in these tests
    await settle(100);

    expect(called('attach_block')).toHaveLength(0);
    expect($('unattached-section').hidden).toBe(false);
  });

  it('keeps a block waiting, and says so, when there is no room for it today', async () => {
    on();
    vi.setSystemTime(new Date(2026, 9, 19, 14, 0));
    list = [unplaced('w', { title: 'Morning routine', blockType: 'routine' })];
    await startApp(backend());
    await settle(100);

    expect(called('attach_block')).toHaveLength(0);
    expect($('unattached-list').textContent).toMatch(/tomorrow/i);
  });

  it('tries a block once, so a refusal cannot make it loop', async () => {
    on();
    await startApp(backend({ attach_block: () => Promise.reject('That block no longer exists.') }));
    await settle(150);

    expect(called('attach_block')).toHaveLength(1);
    expect($('unattached-list').textContent).toContain('Write report'); // still waiting
  });

  it('lets a block be made with no place', async () => {
    on();
    list = [];
    await startApp(backend());
    type($('task-title'), 'Write report');
    type($('block-duration'), '45');
    click(document.querySelector('[data-urgency="important"]')!);
    await settle();
    $<HTMLSelectElement>('block-attach').value = '';
    submitBlockForm();
    await settle();

    expect(called('create_container')[0].args).toMatchObject({ parent: null, urgency: 'important', durationMin: 45 });
    expect($('attach-error').hidden).toBe(true);
  });

  it('can be switched off in Settings, and is on to begin with', async () => {
    realPlacementDefault = true;
    await startApp(backend({ list_day_blocks: () => [] }));
    const box = $<HTMLInputElement>('auto-place');
    expect(box.checked).toBe(true);

    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    expect(localStorage.getItem('blinkers.autoplace')).toBe('off');
  });
});

describe('the add form when the app places blocks', () => {
  const on = () => localStorage.setItem('blinkers.autoplace', 'on');
  const pickUrgency = (value: string) => click(document.querySelector(`[data-urgency="${value}"]`)!);

  beforeEach(() => vi.setSystemTime(new Date(2026, 9, 19, 6, 0)));
  afterEach(() => vi.useRealTimers());

  it('shows only where the block will go, and no picker', async () => {
    on();
    await startApp();
    type($('task-title'), 'Write report');
    type($('block-duration'), '45');
    pickUrgency('urgent-important');
    await settle();

    expect($('block-attach').hidden).toBe(true);
    expect($('attach-label').textContent).toBe('Where it goes');
    expect($('attach-help').hidden).toBe(true);
    expect($('attach-suggestion').hidden).toBe(false);
    expect($('attach-suggestion').textContent).toContain('8:00 AM');
  });

  it('still shows the picker when the app is not placing blocks', async () => {
    await startApp(); // off by default in these tests
    expect($('block-attach').hidden).toBe(false);
    expect($('attach-label').textContent).toBe('Follows');
  });

  it('switches between the two when the setting changes', async () => {
    on();
    await startApp();
    expect($('block-attach').hidden).toBe(true);

    const box = $<HTMLInputElement>('auto-place');
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect($('block-attach').hidden).toBe(false);
    expect($('attach-label').textContent).toBe('Follows');
  });

  it('leaves the place to the app when the block is made', async () => {
    on();
    await startApp();
    type($('task-title'), 'Write report');
    type($('block-duration'), '45');
    pickUrgency('urgent-important');
    await settle();
    submitBlockForm();
    await settle();

    expect(called('create_container')[0].args).toMatchObject({ parent: null, urgency: 'urgent-important', durationMin: 45 });
  });

  it('says why there is nothing to place against when there are no cues, and offers a typical day', async () => {
    on();
    await startApp({ list_cues: () => [] });

    expect($('no-cues').hidden).toBe(false);
    expect($('no-cues').textContent).toMatch(/cue/i);
  });

  it('adds a typical day of cues with one press, and then the notice goes away', async () => {
    on();
    let cues: unknown[] = [];
    await startApp({
      list_cues: () => cues,
      create_cue: (a) => {
        cues = [...cues, { ...(a.input as object), id: `c${cues.length}`, onDate: null }];
        return cues[cues.length - 1];
      },
    });

    click($('btn-seed-cues'));
    await until(() => $('no-cues').hidden);

    expect(called('create_cue').map((c) => (c.args.input as { label: string }).label)).toEqual(['Wake up', 'Lunch', 'Dinner', 'Bedtime']);
    expect(called('create_cue')[3].args.input).toMatchObject({ timeMin: 1320, endsDay: true });
    expect($('no-cues').hidden).toBe(true);
  });

  it('says what went wrong when a cue cannot be added, and keeps the notice', async () => {
    on();
    await startApp({ list_cues: () => [], create_cue: () => Promise.reject('That cue overlaps another one.') });

    click($('btn-seed-cues'));
    await settle(100);

    expect($('seed-error').textContent).toContain('That cue overlaps another one.');
    expect($('no-cues').hidden).toBe(false);
  });

  it('does not show the notice when there are cues', async () => {
    on();
    await startApp();
    expect($('no-cues').hidden).toBe(true);
  });
});

describe('syncing between devices', () => {
  const FOLDER = '/Users/me/Dropbox/Blinkers';
  const NOW_SEC = () => Math.floor(Date.now() / 1000);
  const other = (over: Record<string, unknown> = {}) => ({
    fingerprint: 'f', writtenAt: NOW_SEC() - 120, deviceId: 'desk', deviceName: 'Desktop', thisDevice: false, recentlyActive: false, ...over,
  });
  const on = (state: string, over: Record<string, unknown> = {}) => ({
    enabled: true, folder: FOLDER, deviceId: 'me', lastSyncedAt: NOW_SEC() - 300, remote: other(), state, ...over,
  });
  let reloaded = 0;
  // Starting the screen over is announced as a cancelable event, which is taken over here.
  const takeOverReload = (e: Event) => {
    e.preventDefault();
    reloaded += 1;
  };
  beforeEach(() => {
    reloaded = 0;
    window.addEventListener('blinkers:reload', takeOverReload);
  });
  afterEach(() => window.removeEventListener('blinkers:reload', takeOverReload));
  const startSynced = (status: unknown, extra: Record<string, Handler> = {}) =>
    startApp({ get_sync_status: () => status, ...extra });

  it('says syncing is off, and offers to choose a folder', async () => {
    await startApp();
    expect($('sync-status').textContent).toMatch(/off/i);
    expect($('btn-sync-folder').hidden).toBe(false);
    expect($('btn-sync-now').hidden).toBe(true);
    expect($('btn-sync-off').hidden).toBe(true);
    expect(called('run_sync')).toHaveLength(0); // nothing to sync with
    expect($('btn-sync').hidden).toBe(true);
    expect(errors).toEqual([]);
  });

  it('starts syncing with the folder the user picks, and does a first sync at once', async () => {
    let status: unknown = SYNC_OFF;
    await startApp({
      'plugin:dialog|open': () => FOLDER,
      set_sync_folder: () => {
        status = on('no_remote', { remote: null, lastSyncedAt: null });
        return status;
      },
      get_sync_status: () => status,
      run_sync: () => ({ kind: 'pushed' }),
    });

    click($('btn-sync-folder'));
    await until(() => called('run_sync').length > 0);
    await settle(50);

    expect(called('set_sync_folder')[0].args).toEqual({ folder: FOLDER });
    expect(called('run_sync')[0].args).toEqual({ allowPull: true });
    expect($('sync-message').textContent).toBe('Saved to the sync folder.');
    expect($('sync-folder').textContent).toBe(FOLDER);
    expect($('btn-sync-now').hidden).toBe(false);
    expect($('btn-sync-off').hidden).toBe(false);
  });

  it('does nothing when the folder picker is cancelled', async () => {
    await startApp({ 'plugin:dialog|open': () => null });
    click($('btn-sync-folder'));
    await settle(80);
    expect(called('set_sync_folder')).toHaveLength(0);
  });

  it('saves nothing and asks nothing when the user has not turned syncing on', async () => {
    await startApp();
    await settle(80);
    expect(called('run_sync')).toHaveLength(0);
  });

  it('syncs when the app opens, and takes newer data from the other device', async () => {
    await startSynced(on('in_sync'), { run_sync: () => ({ kind: 'pulled', remote: other() }) });
    await until(() => reloaded > 0);

    expect(called('run_sync')[0].args).toEqual({ allowPull: true });
    expect(called('get_synced_setting').length).toBeGreaterThan(0); // today's choices come across too
    expect(reloaded).toBe(1); // the screen starts over with the new data
  });

  it('opens quietly when there was nothing to take', async () => {
    await startSynced(on('in_sync'), { run_sync: () => ({ kind: 'inSync' }) });
    await settle(100);
    expect(reloaded).toBe(0);
    expect($('sync-message').hidden).toBe(true);
    expect($('btn-sync').hidden).toBe(true);
  });

  it('shows what happened when a sync is pressed by hand', async () => {
    await startSynced(on('in_sync'), { run_sync: () => ({ kind: 'inSync' }) });
    await settle(60);
    click($('btn-sync-now'));
    await until(() => !$('sync-message').hidden);
    expect($('sync-message').textContent).toBe('Already up to date.');
  });

  it('asks which copy to keep when both changed, and lights the header badge', async () => {
    await startSynced(on('conflict'), { run_sync: () => ({ kind: 'conflict', remote: other() }) });
    await settle(100);

    expect($('sync-conflict').hidden).toBe(false);
    expect($('btn-sync').hidden).toBe(false);
    expect($('sync-status').textContent).toMatch(/both changed/i);
    expect(reloaded).toBe(0); // nothing was replaced
  });

  it('keeps this device\'s data when asked to', async () => {
    await startSynced(on('conflict'), { run_sync: () => ({ kind: 'conflict', remote: other() }), sync_resolve: () => ({ kind: 'pushed' }) });
    await settle(80);
    click($('btn-keep-this'));
    await until(() => called('sync_resolve').length > 0);
    expect(called('sync_resolve')[0].args).toEqual({ keep: 'this' });
    expect(reloaded).toBe(0);
  });

  it('keeps the other device\'s data when asked to, and starts over with it', async () => {
    await startSynced(on('conflict'), { run_sync: () => ({ kind: 'conflict', remote: other() }), sync_resolve: () => ({ kind: 'pulled', remote: other() }) });
    await settle(80);
    click($('btn-keep-other'));
    await until(() => reloaded > 0);
    expect(called('sync_resolve')[0].args).toEqual({ keep: 'other' });
  });

  it('tells the user when the other device runs a different version', async () => {
    await startSynced(on('version_mismatch'), { run_sync: () => ({ kind: 'versionMismatch', remote: other() }) });
    await settle(100);
    expect($('sync-status').textContent).toMatch(/different version/i);
    expect($('btn-sync').hidden).toBe(false);
    expect($('sync-conflict').hidden).toBe(true);
  });

  it('warns when the other device was using the folder a moment ago', async () => {
    await startSynced(on('in_sync', { remote: other({ recentlyActive: true }) }), { run_sync: () => ({ kind: 'inSync' }) });
    await settle(100);
    expect($('sync-warning').hidden).toBe(false);
    expect($('sync-warning').textContent).toMatch(/phone reminders/i);
  });

  it('checks again now and then without replacing what is on screen', async () => {
    await startSynced(on('in_sync'), { run_sync: () => ({ kind: 'inSync' }) });
    await settle(60);
    const { syncTick } = await import('../syncUi');

    await syncTick();

    expect(called('run_sync').at(-1)!.args).toEqual({ allowPull: false });
  });

  it('lights the badge, and does not reload, when the periodic check finds newer data', async () => {
    let status: unknown = on('in_sync');
    let outcome: unknown = { kind: 'inSync' };
    await startSynced(status, { get_sync_status: () => status, run_sync: () => outcome });
    await settle(60);
    expect($('btn-sync').hidden).toBe(true);

    // the other device saves something while this one is open
    status = on('remote_newer');
    outcome = { kind: 'remoteNewer', remote: other() };
    const { syncTick } = await import('../syncUi');
    await syncTick();

    expect($('btn-sync').hidden).toBe(false);
    expect($('sync-status').textContent).toMatch(/Desktop saved newer data/i);
    expect(reloaded).toBe(0); // what is on screen is left alone until the user says so
  });

  it('shows a problem in the section and keeps the app working', async () => {
    await startSynced(on('in_sync'), { run_sync: () => Promise.reject('The sync folder has a file that is not a Blinkers snapshot.') });
    await until(() => !$('sync-error').hidden);

    expect($('sync-error').textContent).toContain('not a Blinkers snapshot');
    click($('btn-add-cue'));
    expect($('cue-modal').hidden).toBe(false); // the rest of the app still works
    expect(errors).toEqual([]);
  });

  it('stops syncing when asked', async () => {
    await startSynced(on('in_sync'), { run_sync: () => ({ kind: 'inSync' }), set_sync_folder: () => SYNC_OFF });
    await settle(60);
    click($('btn-sync-off'));
    await until(() => called('set_sync_folder').length > 0);
    expect(called('set_sync_folder')[0].args).toEqual({ folder: null });
  });

  it('does not stop the app from opening when the folder is slow to answer', async () => {
    await startSynced(on('in_sync'), { run_sync: () => new Promise(() => {}) }); // never answers
    await settle(2300); // the app gives the first sync two seconds and then carries on without it
    click($('btn-add-cue'));
    expect($('cue-modal').hidden).toBe(false);
  });

  it('opens Settings from the badge, and does not close it if it is already open', async () => {
    await startSynced(on('conflict'), { run_sync: () => ({ kind: 'conflict', remote: other() }) });
    await settle(100);
    click($('btn-sync'));
    await settle(50);
    expect($('settings-drawer').style.maxHeight).not.toBe('0px');
    click($('btn-sync'));
    await settle(50);
    expect($('settings-drawer').style.maxHeight).not.toBe('0px');
  });
});

describe('a day that does not fit', () => {
  const NOON = { id: 'noon', label: 'Noon', timeMin: 720, days: [0, 1, 2, 3, 4, 5, 6], flexMin: 0, endsDay: false };
  const mk = (id: string, over: Record<string, unknown> = {}) => ({
    id, blockType: 'deep', orderIndex: 0, title: id, urgency: 'important', createdOn: '2026-10-19',
    durationMin: 60, parentKind: 'cue', parentId: 'morning', isCompleted: false, endedAtMin: null, committed: false,
    ...over,
  });
  // 08:00 to 12:00 is 240 minutes: 130 + a 20 minute break + 130 only fits 15% shorter
  const tooMuch = () => [
    mk('a', { title: 'Email', urgency: 'urgent', durationMin: 130 }),
    mk('b', { title: 'Report', urgency: 'urgent-important', durationMin: 130, parentKind: 'block', parentId: 'a' }),
  ];
  const panel = () => $('fit-panel');
  const choose = (choice: string) => click(panel().querySelector<HTMLButtonElement>(`[data-choice="${choice}"]`)!);
  const lastPlan = () => {
    const plans = called('sync_commitments');
    return plans[plans.length - 1].args.plan as Array<{ blockId: string }>;
  };

  beforeEach(() => vi.setSystemTime(new Date(2026, 9, 19, 6, 0)));
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('asks how to fix it, with both ways out and the recommended one marked', async () => {
    await startApp({ list_cues: () => [MORNING, NOON], list_day_blocks: tooMuch });

    expect(panel().hidden).toBe(false);
    expect(panel().textContent).toMatch(/does not fit/i);
    expect(panel().querySelector('[data-choice="shorten"]')!.textContent).toContain('Shorten everything by 15%');
    expect(panel().querySelector('[data-choice="drop"]')!.textContent).toContain('Email');
    expect(panel().querySelector('[data-choice="shorten"]')!.getAttribute('data-recommended')).toBe('true');
    expect(panel().querySelector('[data-choice="drop"]')!.getAttribute('data-recommended')).toBe('false');
  });

  it('shows a badge in the header while the answer is waiting', async () => {
    await startApp({ list_cues: () => [MORNING, NOON], list_day_blocks: tooMuch });
    expect($('btn-fit').hidden).toBe(false);
  });

  it('moves the lowest priority block to tomorrow when the user picks that', async () => {
    await startApp({ list_cues: () => [MORNING, NOON], list_day_blocks: tooMuch });

    choose('drop');
    await until(() => panel().textContent!.includes('moved to tomorrow'));

    expect(JSON.parse(localStorage.getItem('blinkers.day')!).fit).toBe('drop');
    expect(lastPlan().map((p) => p.blockId)).toEqual(['b']); // Email (Q3) goes, Report (Q1) stays
    expect(panel().textContent).toContain('Email moved to tomorrow so today fits.');
    expect($('btn-fit').hidden).toBe(true); // nothing is waiting any more
  });

  it('lets the user change their mind', async () => {
    await startApp({ list_cues: () => [MORNING, NOON], list_day_blocks: tooMuch });
    choose('drop');
    await until(() => panel().textContent!.includes('moved to tomorrow'));

    click($('btn-fit-change'));
    await until(() => panel().textContent!.includes('does not fit'));

    expect(JSON.parse(localStorage.getItem('blinkers.day')!).fit).toBeUndefined();
    expect(lastPlan().map((p) => p.blockId)).toEqual(['a', 'b']); // shortened again, nothing dropped
  });

  it('says nothing, and hides the badge, when the day fits', async () => {
    await startApp({ list_cues: () => [MORNING, NOON], list_day_blocks: () => [mk('a', { durationMin: 60 })] });
    expect(panel().hidden).toBe(true);
    expect($('btn-fit').hidden).toBe(true);
  });
});

describe('the Today tab and editing a block', () => {
  const mk = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    blockType: 'deep',
    orderIndex: 0,
    title: id,
    urgency: 'important',
    createdOn: '2026-10-20',
    durationMin: 45,
    parentKind: 'cue',
    parentId: 'morning',
    isCompleted: false,
    endedAtMin: null,
    committed: false,
    ...over,
  });

  let blocks: Array<Record<string, unknown>>;
  let details: Record<string, unknown>;
  const row = (id: string) => document.querySelector<HTMLElement>(`#today-list [data-block-id="${id}"]`);
  const rowButton = (id: string, text: string) =>
    [...(row(id)?.querySelectorAll('button') ?? [])].find((b) => b.textContent === text) as HTMLButtonElement | undefined;
  const field = (id: string) => $<HTMLInputElement>(id);

  const backendWith = (extra: Record<string, Handler> = {}) => ({
    list_day_blocks: () => blocks,
    get_block_details: () => details,
    ...extra,
  });

  async function openToday() {
    click($('btn-today'));
    await until(() => row('write') !== null);
    await settle(20);
  }

  async function openEditor(id = 'write') {
    await openToday();
    click(rowButton(id, 'Edit')!);
    await until(() => !$('edit-block-form').hidden);
  }

  beforeEach(() => {
    blocks = [mk('write', { title: 'Write report' }), mk('email', { title: 'Answer email', blockType: 'routine', durationMin: 30, parentKind: 'block', parentId: 'write' })];
    details = { blockType: 'deep', title: 'Write report', actionTrigger: 'Open report.md', definitionOfDone: 'Draft sent', apps: [{ label: 'Docs', url: 'https://example.com' }] };
  });

  describe('the tabs', () => {
    it('stay hidden until a pane is open, then show which one is open', async () => {
      await startApp(backendWith());
      expect($('tab-bar').hidden).toBe(true);

      click($('btn-today'));
      await settle(30);
      expect($('tab-bar').hidden).toBe(false);
      expect(document.querySelector('[data-tab="today"]')!.getAttribute('aria-pressed')).toBe('true');
      expect(document.querySelector('[data-tab="add-task"]')!.getAttribute('aria-pressed')).toBe('false');
    });

    it('switch panes when clicked, and a lit tab does nothing when clicked again', async () => {
      await startApp(backendWith());
      click($('btn-today'));
      await settle(30);

      click(document.querySelector('[data-tab="add-task"]')!);
      await settle(30);
      expect($('add-task-drawer').style.maxHeight).not.toBe('0px');
      expect($('today-drawer').style.maxHeight).toBe('0px');

      click(document.querySelector('[data-tab="add-task"]')!);
      await settle(30);
      expect($('add-task-drawer').style.maxHeight).not.toBe('0px'); // still open
    });

    it('go away when the pane is closed from the header', async () => {
      await startApp(backendWith());
      click($('btn-today'));
      await settle(30);
      click($('btn-today'));
      await settle(30);
      expect($('tab-bar').hidden).toBe(true);
    });
  });

  describe('the Today list', () => {
    it('shows every block in the order it will happen, with its time', async () => {
      await startApp(backendWith());
      await openToday();

      const rows = [...document.querySelectorAll('#today-list li')].map((li) => li.textContent);
      // The cue comes first and says what it leads to. The two work blocks have a 9 minute
      // recharge between them, shown as its own row.
      expect(rows).toHaveLength(4);
      expect(rows[0]).toContain('Morning');
      expect(rows[0]).toContain('Then: Write report');
      expect(rows[1]).toContain('Write report');
      expect(rows[1]).toContain('8:00 AM · 45 min');
      expect(rows[2]).toContain('Recharge');
      expect(rows[2]).toContain('8:45 AM · 9 min');
      expect(rows[3]).toContain('Answer email');
      expect(rows[3]).toContain('8:54 AM · 30 min');
      expect($('today-empty').hidden).toBe(true);
    });

    it('says so when there is nothing planned', async () => {
      blocks = [];
      await startApp(backendWith());
      click($('btn-today'));
      await settle(40);
      expect($('today-empty').hidden).toBe(false);
    });

    it('drops a block and plans the day again', async () => {
      await startApp(backendWith({ dismiss_block: () => { blocks = blocks.filter((b) => b.id !== 'email'); return null; } }));
      await openToday();
      const plansBefore = called('sync_commitments').length;

      click(rowButton('email', 'Drop')!);
      await until(() => row('email') === null);

      expect(called('dismiss_block')[0].args).toMatchObject({ blockId: 'email' });
      expect(called('sync_commitments').length).toBeGreaterThan(plansBefore);
    });

    it('shows why a drop failed and keeps the block', async () => {
      await startApp(backendWith({ dismiss_block: () => Promise.reject('That block no longer exists.') }));
      await openToday();
      click(rowButton('email', 'Drop')!);
      await until(() => !$('today-error').hidden);

      expect($('today-error').textContent).toContain('no longer exists');
      expect(row('email')).not.toBeNull();
    });

    it('offers no Drop for a block that is in progress', async () => {
      const started = { blockId: 'write', status: 'started', startMin: 480, durationMin: 45, startedAt: Math.floor(Date.now() / 1000) };
      await startApp(backendWith({ list_commitments: () => [started] }));
      await openToday();
      expect(rowButton('write', 'Drop')).toBeUndefined();
      expect(rowButton('write', 'Edit')).toBeDefined();
    });
  });

  describe('editing', () => {
    it('opens with the block\'s current details', async () => {
      await startApp(backendWith());
      await openEditor();

      expect(called('get_block_details')[0].args).toMatchObject({ blockId: 'write' });
      expect(field('edit-title').value).toBe('Write report');
      expect(field('edit-trigger').value).toBe('Open report.md');
      expect(field('edit-done').value).toBe('Draft sent');
      expect($('edit-apps').textContent).toContain('Docs');
    });

    it('saves the changed text and plans the day again', async () => {
      await startApp(backendWith());
      await openEditor();
      type(field('edit-title'), '  Write the report  ');
      type(field('edit-trigger'), '');
      const plansBefore = called('sync_commitments').length;

      $<HTMLFormElement>('edit-block-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await until(() => $('edit-block-form').hidden);

      expect(called('update_block')[0].args).toMatchObject({
        blockId: 'write',
        edit: { title: 'Write the report', actionTrigger: null, definitionOfDone: 'Draft sent', apps: [{ label: 'Docs', url: 'https://example.com' }] },
      });
      expect(called('sync_commitments').length).toBeGreaterThan(plansBefore);
      expect(errors).toEqual([]);
    });

    it('refuses an empty title without asking the backend', async () => {
      await startApp(backendWith());
      await openEditor();
      type(field('edit-title'), '   ');
      $<HTMLFormElement>('edit-block-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await settle(40);

      expect(called('update_block')).toHaveLength(0);
      expect($('edit-error').textContent).toMatch(/title/i);
      expect($('edit-block-form').hidden).toBe(false);
    });

    it('shows the backend\'s refusal and stays open so nothing typed is lost', async () => {
      await startApp(backendWith({ update_block: () => Promise.reject('That block is already finished or dropped.') }));
      await openEditor();
      type(field('edit-title'), 'Changed');
      $<HTMLFormElement>('edit-block-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await until(() => !$('edit-error').hidden);

      expect($('edit-error').textContent).toContain('already finished');
      expect($('edit-block-form').hidden).toBe(false);
      expect(field('edit-title').value).toBe('Changed');
    });

    it('cancel closes the form and sends nothing', async () => {
      await startApp(backendWith());
      await openEditor();
      click($('btn-edit-cancel'));
      expect($('edit-block-form').hidden).toBe(true);
      expect(called('update_block')).toHaveLength(0);
    });

    it('adds an app from the list, adds a website, and removes one', async () => {
      await startApp(backendWith());
      await openEditor();

      const pick = $<HTMLSelectElement>('edit-app-pick');
      pick.value = String([...pick.options].findIndex((o) => o.textContent === 'Spotify') - 1); // options[0] is the placeholder
      click($('btn-edit-app-add'));
      type(field('edit-app-url'), 'https://www.example.org/page');
      click($('btn-edit-url-add'));
      click($('edit-apps').querySelector('button[title="Remove Docs"]')!);

      const labels = [...$('edit-apps').children].map((c) => c.textContent);
      expect(labels.join('|')).toContain('Spotify');
      expect(labels.join('|')).toContain('example.org');
      expect(labels.join('|')).not.toContain('Docs');

      $<HTMLFormElement>('edit-block-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await until(() => called('update_block').length > 0);
      expect((called('update_block')[0].args.edit as { apps: unknown[] }).apps).toEqual([
        { label: 'Spotify', url: 'spotify:', icon: '🎵' },
        { label: 'example.org', url: 'https://www.example.org/page' },
      ]);
    });

    it('rejects a website address that is not http or https', async () => {
      await startApp(backendWith());
      await openEditor();
      type(field('edit-app-url'), 'file:///etc/passwd');
      click($('btn-edit-url-add'));
      expect($('edit-error').hidden).toBe(false);
      expect($('edit-apps').textContent).not.toContain('passwd');
    });

    it('does not offer apps for a block that cannot open any', async () => {
      details = { blockType: 'reset', title: 'Stretch', actionTrigger: null, definitionOfDone: null, apps: [] };
      blocks = [mk('write', { title: 'Stretch', blockType: 'reset', urgency: null })];
      await startApp(backendWith());
      await openEditor();
      expect($('edit-apps-section').hidden).toBe(true);
    });

    it('is not offered for a recharge block', async () => {
      blocks = [mk('write', { title: '', blockType: 'recharge', urgency: null })];
      await startApp(backendWith());
      await openToday();
      expect(rowButton('write', 'Edit')).toBeUndefined();
      expect(rowButton('write', 'Drop')).toBeDefined();
    });
  });
});

describe('a cue for just today', () => {
  const repeat = (mode: string) => document.querySelector<HTMLElement>(`[data-repeat="${mode}"]`)!;
  const todayIso = () => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const dayChips = () => document.querySelectorAll('#cue-days button').length;

  async function openNewCue(overrides: Record<string, Handler> = {}) {
    await startApp(overrides);
    click($('btn-add-cue'));
  }

  function fill(label: string, time: string) {
    type($('cue-label'), label);
    type($('cue-time'), time);
  }

  async function save() {
    click($('btn-cue-save'));
    await settle(50);
  }

  it('asks whether the cue repeats every week or is just for today, and starts on every week', async () => {
    await openNewCue();
    expect(repeat('weekly').getAttribute('aria-pressed')).toBe('true');
    expect(repeat('once').getAttribute('aria-pressed')).toBe('false');
    expect($('cue-days-section').hidden).toBe(false);
    expect($('cue-once-note').hidden).toBe(true);
  });

  it('hides the weekdays when it is just for today, since the date decides, and says so', async () => {
    await openNewCue();
    click(repeat('once'));
    expect($('cue-days-section').hidden).toBe(true);
    expect($('cue-once-note').hidden).toBe(false);
    expect(repeat('once').getAttribute('aria-pressed')).toBe('true');

    click(repeat('weekly'));
    expect($('cue-days-section').hidden).toBe(false);
    expect(dayChips()).toBe(7);
  });

  it('saves a cue for today with today\'s date and no weekdays needed', async () => {
    await openNewCue();
    fill('Midday reset', '23:59');
    click(repeat('once'));
    await save();

    expect(called('create_cue')[0].args.input).toMatchObject({ label: 'Midday reset', timeMin: 1439, onDate: todayIso() });
    expect($('cue-modal').hidden).toBe(true);
  });

  it('works even when every weekday has been switched off', async () => {
    await openNewCue();
    fill('Midday reset', '23:59');
    document.querySelectorAll<HTMLElement>('#cue-days button[aria-pressed="true"]').forEach((b) => click(b));
    click(repeat('once'));
    await save();
    expect(called('create_cue')).toHaveLength(1);
  });

  it('refuses a time that has already passed today, because it would be missed at once', async () => {
    await openNewCue();
    fill('Too late', '00:00');
    click(repeat('once'));
    // 00:00 has passed unless this test happens to run in the first minute of the day.
    if (new Date().getHours() === 0 && new Date().getMinutes() === 0) return;
    await save();

    expect(called('create_cue')).toHaveLength(0);
    expect($('cue-error').textContent).toMatch(/already passed/i);
    expect($('cue-modal').hidden).toBe(false);
  });

  it('still lets a weekly cue be at any time of day', async () => {
    await openNewCue();
    fill('Early', '00:00');
    await save();
    expect(called('create_cue')[0].args.input).not.toHaveProperty('onDate');
  });

  it('sends no date for an ordinary cue', async () => {
    await openNewCue();
    fill('Evening', '23:30');
    await save();
    expect(called('create_cue')[0].args.input).toMatchObject({ label: 'Evening', days: [0, 1, 2, 3, 4, 5, 6] });
    expect(called('create_cue')[0].args.input).not.toHaveProperty('onDate');
  });

  it('shows a cue for today as "Today only" in the list', async () => {
    const once = { id: 'once', label: 'Midday reset', timeMin: 23 * 60 + 59, days: [new Date().getDay()], flexMin: 0, endsDay: false, onDate: todayIso() };
    await startApp({ list_cues: () => [once] });
    await settle(30);
    const row = [...document.querySelectorAll('#curr-cue-list li')].find((li) => li.textContent?.includes('Midday reset'))!;
    expect(row.textContent).toContain('Today only');
    expect(row.textContent).not.toContain('Every day');
  });

  it('opens an existing cue for today already set to just today, and keeps its own date when saved', async () => {
    const once = { id: 'once', label: 'Midday reset', timeMin: 23 * 60 + 59, days: [new Date().getDay()], flexMin: 0, endsDay: false, onDate: todayIso() };
    await startApp({ list_cues: () => [once] });
    await settle(30);
    click(document.querySelector('button[title="Edit Midday reset"]')!);

    expect(repeat('once').getAttribute('aria-pressed')).toBe('true');
    expect($('cue-days-section').hidden).toBe(true);

    type($('cue-label'), 'Renamed reset');
    await save();
    expect(called('update_cue')[0].args).toMatchObject({ id: 'once', input: { label: 'Renamed reset', onDate: todayIso() } });
  });

  it('can switch a cue for today back to every week', async () => {
    const once = { id: 'once', label: 'Midday reset', timeMin: 23 * 60 + 59, days: [new Date().getDay()], flexMin: 0, endsDay: false, onDate: todayIso() };
    await startApp({ list_cues: () => [once] });
    await settle(30);
    click(document.querySelector('button[title="Edit Midday reset"]')!);
    click(repeat('weekly'));
    await save();
    expect(called('update_cue')[0].args.input).not.toHaveProperty('onDate');
  });

  it('clears out cues from days gone by when the app starts', async () => {
    await startApp();
    await until(() => called('prune_expired_cues').length > 0);
    expect(called('prune_expired_cues')[0].args.today).toBe(todayIso());
  });
});
