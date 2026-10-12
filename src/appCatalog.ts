import type { AppEntry } from './appTargets';

// Built-in launchable apps. `url` is the app's URI scheme: the OS routes it to the app if
// installed. Every scheme here must also be allowed in src-tauri/capabilities/default.json
// (opener:allow-open-url), or openUrl will be rejected.
export const APP_CATALOG: AppEntry[] = [
  { label: 'Spotify', url: 'spotify:', icon: '🎵' },
  { label: 'VS Code', url: 'vscode://', icon: '💻' },
  { label: 'Cursor', url: 'cursor://', icon: '🖱️' },
  { label: 'Slack', url: 'slack://open', icon: '💬' },
  { label: 'Discord', url: 'discord://', icon: '🎮' },
  { label: 'Microsoft Teams', url: 'msteams://', icon: '👥' },
  { label: 'Zoom', url: 'zoommtg://', icon: '📹' },
  { label: 'Telegram', url: 'tg://', icon: '✈️' },
  { label: 'WhatsApp', url: 'whatsapp://', icon: '📞' },
  { label: 'Notion', url: 'notion://', icon: '📝' },
  { label: 'Obsidian', url: 'obsidian://', icon: '🔮' },
  { label: 'Evernote', url: 'evernote://', icon: '🐘' },
  { label: 'Todoist', url: 'todoist://', icon: '✅' },
  { label: 'Linear', url: 'linear://', icon: '📐' },
  { label: 'Figma', url: 'figma://', icon: '🎨' },
  { label: 'Postman', url: 'postman://', icon: '📮' },
  { label: 'Steam', url: 'steam://open/main', icon: '🕹️' },
  { label: 'Mail', url: 'mailto:', icon: '✉️' },
  // Student apps
  { label: 'Notability', url: 'notability://', icon: '🖊️' },
  { label: 'GoodNotes', url: 'goodnotes://', icon: '📓' },
  { label: 'OneNote', url: 'onenote:', icon: '🗒️' },
  { label: 'Zotero', url: 'zotero://', icon: '📚' },
  // No dependable app scheme: https links open the app via app links on mobile, else the browser.
  { label: 'Google Classroom', url: 'https://classroom.google.com', icon: '🎓' },
  { label: 'Google Docs', url: 'https://docs.google.com', icon: '📄' },
];
