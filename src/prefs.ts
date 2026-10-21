// The one setting that is about how the app behaves, not about a day: whether it places blocks
// itself. It is on by default; turning it off goes back to suggesting a place and letting the user
// confirm. Storage can be missing or throw, and the app must work without it, so "on" is the
// fallback.

const KEY = 'blinkers.autoplace';

export function autoPlaceEnabled(): boolean {
  try {
    return window.localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setAutoPlace(on: boolean) {
  try {
    window.localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // No storage: the choice lasts until the app restarts, which is better than failing.
  }
}
