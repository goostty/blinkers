# Dynamic day: re-planning from now when a block is missed

Status: built (see "As built" at the end). The sections above are the design as agreed; where the
build differs, the last section says so.

## Intent

The day is a linked list: a cue (a fixed time) is the head, and blocks follow one another until
the next cue. Real days do not go to plan. The user wants the app to adapt without making them
re-plan by hand: when a block is missed, they make one choice, and the rest of the day moves
around it. The app should feel like a sensible person re-planning the afternoon, not like a
timetable that breaks the first time it is late.

This builds on work that already exists: the suggested-place scheduler (`suggest.ts`),
recharge breaks (`breaks.ts`, placed by `timeline.ts`) and the name reader (`nameReader.ts`).

## Principle: times are projections

Block lengths are estimates, so the schedule has no fixed times. The plan is **always derived from
what has actually happened**, and it is re-derived whenever a fact changes:

- a finished block ends when the user finished it (already true: `endedAtMin`);
- a started block began when the user pressed Start, and while it is still running its end is
  `max(planned end, now)`, so running over pushes everything behind it later;
- an unstarted block begins when the one before it ends (plus a break), never earlier than the
  moment the user last decided something about a missed block;
- cues never move.

Because of this, the next reminder is naturally held while a block overruns: its start keeps
moving with the clock until the user finishes. Facts that trigger a re-plan: Start, Finish, Lapse,
a Continue or Abandon decision, a new block, and (only while a started block is past its end) the
reminder tick.

## What happens today (verified in the code)

- A block whose start passes without the user pressing Start becomes `missed`. A missed block
  offers **Reschedule** and **Drop** (`blockActions.ts`).
- **Reschedule** (`reschedule_block_in`, `containers.rs`) takes the block out of its slot and
  closes the chain up around it, then leaves the block in "Needs a place". **Drop** removes the
  block and also closes the chain up.
- A missed commitment cannot be started: "its time is over" (`start_block_in`).
- `sync_commitments` rewrites only `planned` rows. Once a reminder has gone out (`nagging`), or the
  block is `started`, `finished`, `lapsed` or `missed`, its row is frozen so the phone and the app
  do not disagree (`commitments.rs`).
- `timeline.ts` states that "starting late or running over never pushes the next block back".
  A block that finishes early pulls the rest forward (`endedAtMin`).
- When a chain runs past its next cue, `planDay` marks the blocks that no longer fit as
  `overflow` and they roll to tomorrow. **Which ones roll is decided by position in the chain**
  (the tail goes), not by priority.

## Behaviour to build

1. **Re-plan from now.** Nothing may be scheduled in the past. After the user decides what to do
   with a missed block, every block that has not started is planned from the current time
   forward, not from its old time.
2. **Continue.** The missed block is kept and **starts immediately**, as if the user had pressed
   Start at that moment. It gets its full entered length, in its place at the head of what is left
   of its chain. Everything behind it moves later by that length.
3. **Abandon.** The missed block is dropped (today's Drop). The blocks behind it close up and are
   re-planned from now, so they never get a start time in the past.
4. **When the day does not fit, the user chooses, with a recommended default.** If, after moving,
   the blocks in a chain no longer fit before the next cue, the app shows what each way out would
   do and highlights one:
   - **Shorten everything** (blocks and breaks together) by the smallest amount that makes it fit.
     It is only offered when the amount is within the padding the user was told to add (the form
     asks for about 1.5x, so blocks may shrink to two thirds of their entered length, and breaks to
     their minimum).
   - **Drop tasks**: roll blocks to tomorrow, lowest priority first, until the rest fit.

   The recommended option is shorten when it is possible, and drop otherwise. Until the user
   chooses, the recommended option is applied provisionally so the day is valid and reminders
   work. The order blocks are dropped in is:
   1. recharge breaks go first (they already do: a break is dropped before it can push a block
      past a cue);
   2. rest blocks the user made themselves;
   3. Q3 (urgent, not important);
   4. Q2 (important, not urgent);
   5. Q1 (urgent and important) last, and only if nothing else can make room.

   Within the same quadrant the most recently created rolls first, so older work is kept
   (the same order `caps.ts` already uses). A block the user has started or finished is never
   rolled.
5. **Say what moved.** A rolled block is never silently lost. It keeps showing in the Today list
   as rolling to tomorrow, with a reason that names what made room for what (for example
   "Moved to tomorrow to fit Write report after the missed block"). After Continue or Abandon, the
   missed section shows a short list of what moved.
6. **Tomorrow.** Rolled blocks come back as "Needs a place" the next day, where the suggested
   place is pre-selected. This is the existing carry-over behaviour and does not change.

## Goals

- One decision per missed block (Continue or Abandon) and the day stays valid.
- Never schedule in the past; never push a block past a cue.
- Deterministic and explainable: the same day and the same choice always give the same plan,
  and every move comes with a reason.
- Works fully offline, in the pure planning code, with tests.

## Non-goals

- No drifting for blocks nobody is working on: an unstarted block never slides just because the
  clock advances (it becomes `nagging`, then `missed`, and waits for the user's decision). The only
  thing that follows the clock is a **running block that is past its end**.
- No silent shrinking. Blocks are only shortened when the user chose to (or accepted the
  recommendation), and never below two thirds of the length they entered.
- No moving a block into a different cue's chain to use free time there. Rolling is within the
  chain that overflows. (Cross-chain moves belong to the fully automatic scheduler, later.)
- No AI or embedding model.
- No change to how reminders are worded or sent.

## Anti-goals (a failure even if the tests pass)

- A block disappears from the day without the user being told.
- A started or finished block is moved.
- The app asks the user to re-plan by hand after every disruption.
- A re-plan puts a block earlier than the user's phone was told it would start, without the phone
  being brought in line.

## Constraints

- Cues are fixed commitments and never move.
- A node in the list has one follower (`containers.rs`), so every insert or removal must re-link
  its neighbours in one transaction, as the existing code does.
- Frozen commitments (`nagging`, `started`, `finished`, `lapsed`, `missed`) are not rewritten by
  `sync_commitments`. The design must either leave them alone or define how they change.
- Planning is pure (`planDay`, `buildTimeline`): no clock, no database. The current time is passed in.

## Decisions already made by the user

- Continue and Abandon are the two choices, and both move the rest of the day.
- When the day does not fit the user is asked, with a recommended default: shorten everything
  (blocks and breaks) if that is enough, otherwise drop tasks, lowest priority first.
- The form tells the user to enter about 1.5x what they think a task takes. The app does not
  multiply lengths itself.
- Continue starts the block immediately (no second press of Start).
- A running block that passes its end re-plans the day: it keeps occupying time until the user
  finishes it, and the blocks behind it slide later (overrun option b).
- The first block after a cue (the manual anchor) is not specially protected: it rolls like any
  other block when the day is too tight.

## Left to the builder (with my recommendation)

These are my calls. The user can overrule them.

- **How "from now" is remembered.** After Continue or Abandon, a later ordinary re-plan (for
  example adding a block an hour later) must not snap blocks back to their old times. I recommend a
  single per-day "replanned at" minute stored when the user decides, used as the earliest time an
  unstarted block may begin. It needs one new nullable column and no per-block migration. A
  per-block "not before" is more precise but heavier.
- **How Continue works.** The `missed` commitment is replaced by a `started` one with the start time
  set to now, and the block is put back at the head of its chain. The timeline then uses the real
  start time of a started block (a new optional `startedAtMin` on `TimelineBlock`) instead of the
  slot it was planned for, so the blocks behind it fall in place.
- **Re-planning while a block overruns.** The reminder tick (about every 15 seconds) should ask for
  a re-plan only when a started block is past its end, so a quiet day costs nothing. The re-plan
  rewrites `planned` rows through the existing `sync_commitments`; frozen rows stay as they are.
- **Rolling algorithm.** For each cue's chain, while some block does not fit, roll the lowest-priority
  unprotected block in that chain, close the chain up, and recompute. Repeat until everything fits
  or only protected blocks are left. Blocks left over that still do not fit stay marked as
  overflowing, as today.
- **Where the notice lives.** A new placement kind (for example `bumped`) in `dayPlan.ts`, so the
  Today list and the missed section read it the same way as `capped` and `overflow`.
- **Rest blocks rank lowest** because they sit at the end of the day and are the first to be
  affected anyway. My call.

## Open questions for the user

None. The design is ready for review.

## Parked

- Nothing. The question of whether a cue's first block repeats with the cue no longer applies, now
  that the app places every block itself.

## Suggested build order (for the plan, not yet approved)

1. `timeline.ts`: use the real start of a started block (`startedAtMin`), end a running block at
   `max(planned end, now)`, and accept a "not before" minute for unstarted blocks. The current time
   becomes an input, so the function stays pure.
2. Priority rolling for overflow in `dayPlan.ts`, with the new placement kind and reason text.
3. The stored "replanned at" value and the Continue / Abandon actions (Rust and TypeScript).
4. The missed section and Today list: the choice, and the list of what moved.

## As built

- `timeline.ts` takes the current time, a "not before" minute, a shortening scale and a keep-breaks
  switch, and uses the real start of a started block. A block finished late now pushes the blocks
  behind it (the old test saying it must not was changed on purpose).
- `fit.ts` (new) works out both ways out of an overfull day. Shortening is limited to 33% (two thirds
  of the entered length) and keeps the breaks, shortened with everything else. Dropping only
  considers blocks that help, which fixed a case where an impossible block and a fine one of the
  same priority were both dropped.
- `dayPlan.ts` applies the user's choice, or the recommendation until they choose, and reports a
  `fit` summary. Dropped blocks reuse the `overflow` status, with a reason that says whether the
  block itself did not fit or was lowest priority when time ran out. The slot suggester switches
  fixing off so a suggestion never reshapes the day.
- `dayState.ts` (new) keeps the choice and the "not before" minute for today only, in the browser's
  storage. No database column was needed (the draft suggested one; storage was enough because both
  values only matter for the current day).
- Continue is a new backend command, `continue_block`: it turns a missed commitment into a started
  one at the current moment. Abandon (the existing Drop) and Reschedule both record the "not before"
  minute after the backend has agreed.
- A running block that is past its end re-plans the day every 30 seconds, and only then.
- The Today tab shows the choice panel (and a "Too full" badge in the header), and lists shortened
  lengths as shortened. The length hint asks for about 1.5x for deep and routine blocks.

### Placement is automatic, including the first block after a cue

The earlier idea that the first block after every cue is made by hand (the "anchor" rule) was
dropped. The user wants the whole day placed by the app and to be told what is coming, so:

- The "Follows" choice is optional. A block can be made with no place (the backend accepts it) and
  the app places it. Waiting blocks, rescheduled blocks and ones carried over from yesterday are
  all placed by `autoPlace.ts`, most urgent first, one at a time, planning again after each.
- A block is never put ahead of one that is more urgent (in `suggest.ts`), even where its own
  ranking would like that place. Without this, placing blocks one at a time let a small Q3 job
  push a Q1 block later.
- Settings has "Place blocks for me", on by default. Off goes back to suggesting a place and asking
  the user to confirm it.
- The Today list shows each cue with the block that follows it ("Then: Write report", with the time
  if it is not at the cue), so the user knows what each transition leads to. Recharge breaks are
  shown as before.
- A block that has no room today waits and is placed the next day, since the backend lists unfinished
  work again then. A rest block (reset or recharge) made with no room today does not carry over.

### Not done, on purpose

- Blocks are not moved between different cues' chains to use free time; that is for a later pass.
- There is no separate advance notice before a cue. The phone reminder already names the cue and the
  block, and the Today list shows the transition in advance.
