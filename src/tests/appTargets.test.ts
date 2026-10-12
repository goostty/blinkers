import { describe, expect, it } from 'vitest';
import { addUnique, filterApps, parseWebsite, type AppEntry } from '../appTargets';

describe('parseWebsite', () => {
  it('accepts an exact https URL and keeps path and query untouched', () => {
    const r = parseWebsite('https://github.com/org/repo/pull/12?tab=files#diff');
    expect(r).toEqual({
      ok: true,
      entry: { label: 'github.com', url: 'https://github.com/org/repo/pull/12?tab=files#diff' },
    });
  });

  it('accepts http and strips a leading www. from the label', () => {
    const r = parseWebsite('http://www.example.com/a');
    expect(r.ok && r.entry.label).toBe('example.com');
  });

  it('trims surrounding whitespace', () => {
    const r = parseWebsite('   https://notion.so/page  ');
    expect(r.ok && r.entry.url).toBe('https://notion.so/page');
  });

  it('rejects empty input', () => {
    expect(parseWebsite('   ').ok).toBe(false);
  });

  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'ftp://x.com/a', 'data:text/html,hi'])(
    'rejects unsafe or unsupported scheme %s',
    (raw) => {
      expect(parseWebsite(raw).ok).toBe(false);
    },
  );

  it('rejects a bare domain with no scheme, asking for the exact URL', () => {
    const r = parseWebsite('github.com/org/repo');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/https?:\/\//);
  });

  it('rejects a malformed URL', () => {
    expect(parseWebsite('https://').ok).toBe(false);
  });
});

describe('addUnique', () => {
  const a: AppEntry = { label: 'A', url: 'https://a.com' };

  it('appends a new entry without mutating the input', () => {
    const list = [a];
    const out = addUnique(list, { label: 'B', url: 'https://b.com' });
    expect(out).toHaveLength(2);
    expect(list).toHaveLength(1);
  });

  it('ignores an entry whose url is already present', () => {
    expect(addUnique([a], { label: 'Other', url: 'https://a.com' })).toEqual([a]);
  });
});

describe('filterApps', () => {
  const list: AppEntry[] = [
    { label: 'Spotify', url: 'spotify:' },
    { label: 'Slack', url: 'slack://' },
    { label: 'GitHub', url: 'https://github.com' },
  ];

  it('returns everything for an empty or blank query', () => {
    expect(filterApps(list, '  ')).toEqual(list);
  });

  it('matches label case-insensitively', () => {
    expect(filterApps(list, 'SLA').map((e) => e.label)).toEqual(['Slack']);
  });

  it('matches against the url too', () => {
    expect(filterApps(list, 'github.com').map((e) => e.label)).toEqual(['GitHub']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterApps(list, 'zzz')).toEqual([]);
  });
});
