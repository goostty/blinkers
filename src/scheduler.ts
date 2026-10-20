import type { Weekday } from './cues';

// The vocabulary the planner shares. Where blocks go is no longer decided by a search over cues:
// the user attaches each block to what it follows, and timeline.ts, caps.ts and dayPlan.ts apply
// the day's rules to those choices.

export type BlockType = 'deep' | 'routine' | 'reset' | 'recharge';

// Eisenhower quadrants. Only deep and routine blocks carry one; reset and recharge are rest.
//   urgent-important = Q1, important = Q2, urgent = Q3, neither = Q4
export type Urgency = 'urgent-important' | 'important' | 'urgent' | 'neither';

// "Today" is the user's local calendar day, not UTC: a 11 PM block in a UTC+10 timezone still
// belongs to that local date. Weekday uses Sunday = 0 like the cues do.
export function describeMoment(now: Date): { isoDate: string; weekday: Weekday; nowMin: number } {
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    isoDate: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    weekday: now.getDay() as Weekday,
    nowMin: now.getHours() * 60 + now.getMinutes(),
  };
}
