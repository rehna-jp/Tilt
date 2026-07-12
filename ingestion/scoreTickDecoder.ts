/**
 * Tilt — Score tick decoder
 *
 * ✅ VERIFIED against TxODDS's official soccer-feed documentation
 * (documentation/scores/soccer-feed.mdx in their tx-on-chain repo) AND
 * cross-checked against a real live tick captured during Norway vs England,
 * 2026-07-11. No longer a guess.
 *
 * Real tick shape (confirmed live):
 *   {
 *     FixtureId: number,
 *     GameState: string,       // e.g. "scheduled" — seems to lag the real
 *                               // match phase; Clock.Running is more reliable
 *     Participant1Id, Participant2Id, Participant1IsHome: ...
 *     Action: string,          // e.g. "attack_possession", "shot", "goal"
 *     Ts: number,               // unix ms
 *     Clock: { Running: boolean, Seconds: number },
 *     Stats: { [key: string]: number }   // <-- the actual stat data
 *   }
 *
 * Stats object uses TxODDS's official encoding: (period * 1000) + base_key
 *   Base keys (full game totals, what we use):
 *     1 = P1 Goals        2 = P2 Goals
 *     3 = P1 Yellow Cards  4 = P2 Yellow Cards
 *     5 = P1 Red Cards     6 = P2 Red Cards
 *     7 = P1 Corners       8 = P2 Corners
 *   Period-specific keys (1000=H1, 2000=H2, 3000=ET1, 4000=ET2, 5000=PE)
 *   exist too, e.g. 1001 = P1 H1 Goals — we don't need these since we track
 *   full-match running totals (base keys 1-8), which update continuously.
 *
 * Heartbeats look like: { Ts: 1783807976 } — no other fields. Skipped.
 */

import { StatSnapshot, StatTotals } from "./game/statTypes";

export interface RawScoreTick {
  FixtureId?: number;
  Ts?: number;
  Stats?: Record<string, number>;
  [key: string]: unknown;
}

const STAT_KEY = {
  P1_GOALS: "1",
  P2_GOALS: "2",
  P1_YELLOW: "3",
  P2_YELLOW: "4",
  P1_RED: "5",
  P2_RED: "6",
  P1_CORNERS: "7",
  P2_CORNERS: "8",
} as const;

/**
 * Decodes a raw score tick into a StatSnapshot with COMBINED totals (both
 * teams summed) — matches how StatRoundEngine and the frontend treat each
 * category as one shared "match total" line, not per-team.
 *
 * Returns null for heartbeats or ticks with no Stats object.
 */
export function decodeScoreTick(tick: RawScoreTick): StatSnapshot | null {
  if (tick.FixtureId === undefined || tick.Ts === undefined || !tick.Stats) {
    return null; // heartbeat or malformed
  }

  const s = tick.Stats;

  const totals: StatTotals = {
    goals: num(s[STAT_KEY.P1_GOALS]) + num(s[STAT_KEY.P2_GOALS]),
    yellowCards: num(s[STAT_KEY.P1_YELLOW]) + num(s[STAT_KEY.P2_YELLOW]),
    redCards: num(s[STAT_KEY.P1_RED]) + num(s[STAT_KEY.P2_RED]),
    corners: num(s[STAT_KEY.P1_CORNERS]) + num(s[STAT_KEY.P2_CORNERS]),
  };

  return {
    fixtureId: tick.FixtureId,
    ts: tick.Ts,
    totals,
  };
}

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}