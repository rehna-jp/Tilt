/**
 * Tilt — Stat types
 *
 * These types represent DECODED match state, independent of TxLINE's raw
 * wire format. This separation means the round engine and its tests can be
 * built and verified now, and only the decoder (scoreTickDecoder.ts) needs
 * to change once we see a real captured tick.
 */

export type StatCategory = "goals" | "yellowCards" | "redCards" | "corners";

export const STAT_CATEGORIES: StatCategory[] = ["goals", "yellowCards", "redCards", "corners"];

/** Combined match totals (both teams summed) for each tracked stat. */
export interface StatTotals {
  goals: number;
  yellowCards: number;
  redCards: number;
  corners: number;
}

export interface StatSnapshot {
  fixtureId: number;
  ts: number;
  totals: StatTotals;
}

export function emptyTotals(): StatTotals {
  return { goals: 0, yellowCards: 0, redCards: 0, corners: 0 };
}