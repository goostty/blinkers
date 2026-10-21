import type { FitSummary } from './dayPlan';
import type { FitChoice } from './fit';

// The words for the "today does not fit" panel, kept apart from the page so they can be tested.
// The panel never hides that the app changed the day: while the user has not chosen, the
// recommended way out is already applied, and the panel says so.

export interface FitOption {
  choice: FitChoice;
  label: string;
  hint: string;
  recommended: boolean;
}

export interface FitPanel {
  asking: boolean; // the user still has to choose
  headline: string;
  note?: string;
  options: FitOption[];
  canChange: boolean; // they chose, and may choose again
}

// "Email", "Email and Laundry", "Email, Laundry and 3 more": a long list stays one short line.
export function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

export function describeFit(fit: FitSummary, titleOf: (blockId: string) => string): FitPanel | null {
  if (fit.applied === null) return null;
  const dropped = listNames(fit.dropped.map(titleOf));

  if (!fit.needsDecision) {
    return {
      asking: false,
      headline:
        fit.applied === 'shorten'
          ? `Everything is ${fit.shortenPercent}% shorter so today fits.`
          : `${dropped} moved to tomorrow so today fits.`,
      options: [],
      canChange: true,
    };
  }

  const options: FitOption[] = [];
  if (fit.shortenPercent !== null) {
    options.push({
      choice: 'shorten',
      label: `Shorten everything by ${fit.shortenPercent}%`,
      hint: 'Blocks and breaks get a little shorter. Nothing moves.',
      recommended: fit.recommended === 'shorten',
    });
  }
  if (fit.dropped.length > 0) {
    options.push({
      choice: 'drop',
      label: `Move to tomorrow: ${dropped}`,
      hint: 'The lowest priority work goes first.',
      recommended: fit.recommended === 'drop',
    });
  }

  return {
    asking: true,
    headline: options.length > 0 ? 'Today does not fit before your next cue.' : 'Today does not fit, and nothing more can be moved.',
    note:
      options.length > 0
        ? fit.applied === 'shorten'
          ? 'Until you choose, everything is shortened.'
          : 'Until you choose, the lowest priority blocks are moved to tomorrow.'
        : undefined,
    options,
    canChange: false,
  };
}
