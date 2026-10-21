# Syncing between devices

Status: built. Assumes **one device in use at a time**, with no real-time updates.

## Intent

The user has Blinkers on more than one computer and wants the same blocks, cues and reminders
everywhere, without running a server or making an account. They already use a tool that keeps a
folder the same across devices (iCloud Drive, Dropbox, Google Drive, Syncthing), so Blinkers uses
that folder as the meeting point.

## How it works

- The live database (`blinkers.db`) stays local. A **snapshot** of it, one file called
  `blinkers-sync.db`, is kept in the chosen folder. The snapshot is the whole database plus a small
  `sync_meta` table: a fingerprint of the data, a hash of the table layout, the time it was written
  and which device wrote it.
- It is written to a temporary name and renamed into place, so a sync tool never uploads a half
  written file. The description travels inside the file, so data and description cannot arrive
  separately.
- Three fingerprints settle what to do: this device now, the folder's snapshot, and what both
  agreed on at the last sync.

  | Situation | Action |
  |---|---|
  | folder = this device | nothing |
  | only the folder changed | take it (pull) |
  | only this device changed | save it (push) |
  | both changed | **ask the user** which to keep; never merge |
  | first sync on a device with no data | take the folder's |
  | first sync where both have different data | ask the user |
  | no snapshot yet and nothing to save | write nothing |

- **Pulling** copies the snapshot's rows into the database in one transaction (all or nothing),
  after a backup of the database is saved in `backups/` inside the app's data folder. The newest ten
  are kept. In a conflict, whichever copy loses is backed up first.
- **When it runs:** when the app opens (it may pull), every five minutes while it runs (it may push,
  and it only reports newer data, never loading it, so the screen is not replaced while the user
  works), when the user presses Sync now, and when the window closes (a final push, given three
  seconds at most). The first sync at startup is given two seconds; a slow or unplugged folder never
  stops the app from opening.
- After a pull the screen starts over from the database (a page reload), because cues, blocks, the
  phone reminder topic and today's choices have all been replaced.

## What each device keeps to itself

`sync-state.json` in the app's data folder (not in the database): the device id, the chosen folder,
the fingerprint of the last sync. The folder differs per computer, and loading a snapshot replaces
the database, so anything kept inside it would be overwritten by the other device's copy.

The "Place blocks for me" switch is also per device (browser storage).

## What travels

Everything in the database: blocks, cues, reminders and their state (so a reminder already sent is
not sent again), the energy profile, the phone reminder topic, and **today's choices** (how a day that
does not fit was fixed, and the "not before" time). Those two used to live only in browser storage;
they are now also written to the database so that switching computers mid-day does not ask the same
question again. The working copy stays in browser storage because planning reads it instantly; on
startup the database's copy for today wins.

## Safety rules

- Nothing is ever merged silently. A conflict is the user's decision.
- If the two devices have different table layouts (different app versions), nothing is pushed or
  pulled and the user is told to update both. Copying across would drop or invent fields.
- A file in the sync folder that is not a Blinkers snapshot is reported and left untouched.
- The screen may read and write only the `day_state` setting, not the rest of the settings table,
  which includes the phone reminder topic.
- Choosing a folder checks that it exists and can be written to, and starts that folder's history
  afresh.

## Phone reminders and two devices

Reminders are sent by whichever computer has Blinkers open, so two open at once would each send
them. While the app runs it touches the snapshot every few minutes; if another device wrote to the
folder in the last ten minutes the Settings screen warns that it may still be open.

## Not done, on purpose

- No live merging or real-time updates; a conflict is resolved by choosing a whole copy.
- No sync of the "apps to open" favourites (`apps.json`, kept by the store plugin) or the window size.
- No end-to-end encryption. The snapshot is as readable as the database file; anyone who can read the
  sync folder can read the user's blocks and the phone reminder topic.
- Not tested against real iCloud or Dropbox, or with two computers: the logic is tested with two
  separate databases and app-data folders sharing a folder.
