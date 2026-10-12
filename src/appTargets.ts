export interface AppEntry {
  label: string;
  url: string;
  icon?: string;
}

export type ParseResult = { ok: true; entry: AppEntry } | { ok: false; error: string };

// Only http(s) is accepted for pasted websites. Anything else (javascript:, file:, data:)
// is a valid URL but would let a pasted string run code or read local files when handed
// to the OS opener. App schemes (spotify:, vscode://) only come from the built-in catalog.
export function parseWebsite(raw: string): ParseResult {
  const text = raw.trim();
  if (!text) return { ok: false, error: 'Paste a URL first.' };

  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, error: 'Enter the exact page URL, starting with https:// or http://' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Only http:// and https:// websites are allowed.' };
  }
  if (!parsed.hostname) return { ok: false, error: 'That URL has no website address.' };

  return { ok: true, entry: { label: parsed.hostname.replace(/^www\./, ''), url: text } };
}

// Same target twice would open two tabs, so the url is the identity of an entry.
export function addUnique(list: AppEntry[], entry: AppEntry): AppEntry[] {
  return list.some((e) => e.url === entry.url) ? list : [...list, entry];
}

export function filterApps(list: AppEntry[], query: string): AppEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((e) => e.label.toLowerCase().includes(q) || e.url.toLowerCase().includes(q));
}
