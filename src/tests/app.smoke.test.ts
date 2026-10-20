// @vitest-environment jsdom
//
// Starts the real app (index.html + main.ts) in a simulated browser with the Tauri backend
// replaced by a stub, and uses it the way a person would. The unit tests cover the logic; this
// covers the wiring they cannot see, such as an error at startup that leaves buttons dead.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import indexHtml from '../../index.html?raw';

type Call = { cmd: string; args: Record<string, unknown> };
type Handler = (args: Record<string, unknown>) => unknown;

const MORNING = { id: 'morning', label: 'Morning', timeMin: 480, days: [0, 1, 2, 3, 4, 5, 6], flexMin: 0, endsDay: false };

let calls: Call[];
let handlers: Record<string, Handler>;
let errors: unknown[][];
let timers: ReturnType<typeof setInterval>[] = [];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const called = (cmd: string) => calls.filter((c) => c.cmd === cmd);

// Waits for something the app does in the background, instead of guessing how long it takes.
async function until(done: () => boolean, ms = 1500) {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await settle(10);
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
    dismiss_block: () => null,
    update_block: () => null,
    get_next_order_index: () => 0,
    create_container: () => 'new-block-id',
    set_profile: () => null,
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

  it('suggests a buffer for deep work only', async () => {
    await startApp();
    expect($('duration-hint').textContent).toMatch(/overestimate/i);
    click($('routine-block'));
    expect($('duration-hint').textContent).not.toMatch(/overestimate/i);
    click($('recharge-block'));
    expect($('duration-hint').textContent).toMatch(/resting/i);
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

    it('is offered Reschedule and Drop, with when it was missed, and no Start', async () => {
      await startApp(missedBackend());
      await until(() => !strip().hidden);

      expect(strip().textContent).toContain('Write report');
      expect(strip().textContent).toContain('Missed 10:00 AM');
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
      expect(rows).toHaveLength(2);
      expect(rows[0]).toContain('Write report');
      expect(rows[0]).toContain('8:00 AM · 45 min');
      expect(rows[1]).toContain('Answer email');
      expect(rows[1]).toContain('8:45 AM · 30 min');
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
