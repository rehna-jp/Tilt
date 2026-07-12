/**
 * Tilt — Stat Round Engine
 *
 * Goals/cards/corners Hi-Lo, with three differentiating mechanics:
 *   1. Multi-stat choice — each player picks WHICH stat (goals/cards/
 *      corners) to call each round, not a fixed stat for everyone.
 *   2. Streak multiplier — longer streaks multiply points earned.
 *   3. Crowd consensus — after resolution, shows what % of players called
 *      each direction per category.
 *
 * Operates on decoded StatSnapshot objects (see statTypes.ts), not raw
 * ticks — this keeps it testable independent of the unverified wire format
 * (see scoreTickDecoder.ts for that boundary).
 */

import { StatCategory, StatSnapshot, StatTotals } from "./statTypes";

export type HiLoCall = "higher" | "lower";
export type HiLoResult = "higher" | "lower" | "flat";

interface PlayerCallRecord {
  userId: string;
  category: StatCategory;
  call: HiLoCall;
}

export interface RoundStartPayload {
  roundId: number;
  startTotals: StatTotals;
  startedAt: number;
}

export interface CategoryOutcome {
  category: StatCategory;
  startValue: number;
  endValue: number;
  result: HiLoResult;
  /** % of players who called "higher" for this category, 0-100. Only
   *  meaningful if callsForCategory > 0. */
  higherPct: number;
  callsForCategory: number;
}

export interface PlayerRoundOutcome {
  userId: string;
  category: StatCategory;
  call: HiLoCall;
  won: boolean;
  streakAfter: number;
  pointsEarned: number;
  multiplier: number;
}

export interface RoundResolvePayload {
  roundId: number;
  fixtureId: number;
  startedAt: number;
  resolvedAt: number;
  categoryOutcomes: CategoryOutcome[];
  playerOutcomes: PlayerRoundOutcome[];
}

export interface StatRoundEngineConfig {
  fixtureId: number;
  roundDurationMs: number;
  /** Base points for a correct call before streak multiplier is applied. */
  basePoints?: number;
}

type Listener<T> = (payload: T) => void;

/**
 * Streak multiplier ladder. Kept as a simple lookup rather than a formula
 * so it's easy to tune for game feel without touching resolution logic.
 */
function multiplierForStreak(streak: number): number {
  if (streak >= 10) return 3;
  if (streak >= 5) return 2;
  if (streak >= 2) return 1.5;
  return 1;
}

export class StatRoundEngine {
  private config: Required<StatRoundEngineConfig>;
  private currentTotals: StatTotals | null = null;
  private roundStartTotals: StatTotals | null = null;
  private roundStartedAt: number | null = null;
  private roundTimer: ReturnType<typeof setTimeout> | null = null;
  private roundCounter = 0;
  private calls = new Map<string, PlayerCallRecord>(); // userId -> their call this round

  // Persistent per-player state across rounds (streak, cumulative points)
  private playerStreaks = new Map<string, number>();
  private playerPoints = new Map<string, number>();

  private onRoundStartListeners: Listener<RoundStartPayload>[] = [];
  private onRoundResolveListeners: Listener<RoundResolvePayload>[] = [];
  private onSnapshotListeners: Listener<StatSnapshot>[] = [];

  constructor(config: StatRoundEngineConfig) {
    this.config = { basePoints: 10, ...config };
  }

  /** Feed a decoded snapshot. Returns true if it was used (matched fixture). */
  ingest(snapshot: StatSnapshot): boolean {
    if (snapshot.fixtureId !== this.config.fixtureId) return false;

    this.currentTotals = snapshot.totals;
    for (const listener of this.onSnapshotListeners) listener(snapshot);

    if (this.roundStartTotals === null) {
      this.startRound();
    }

    return true;
  }

  private startRound() {
    if (this.currentTotals === null) return;
    this.roundCounter++;
    this.roundStartTotals = { ...this.currentTotals };
    this.roundStartedAt = Date.now();
    this.calls.clear();

    for (const listener of this.onRoundStartListeners) {
      listener({
        roundId: this.roundCounter,
        startTotals: this.roundStartTotals,
        startedAt: this.roundStartedAt,
      });
    }

    if (this.roundTimer) clearTimeout(this.roundTimer);
    this.roundTimer = setTimeout(() => this.resolveRound(), this.config.roundDurationMs);
  }

  /** Player picks a stat category AND a direction for the current round. */
  submitCall(userId: string, category: StatCategory, call: HiLoCall): boolean {
    if (this.roundStartTotals === null) return false;
    this.calls.set(userId, { userId, category, call });
    return true;
  }

  getPlayerStreak(userId: string): number {
    return this.playerStreaks.get(userId) ?? 0;
  }

  getPlayerPoints(userId: string): number {
    return this.playerPoints.get(userId) ?? 0;
  }

  private resolveRound() {
    if (this.roundStartTotals === null || this.currentTotals === null || this.roundStartedAt === null) {
      return;
    }

    const startTotals = this.roundStartTotals;
    const endTotals = this.currentTotals;

    // Compute per-category result + crowd consensus, using only categories
    // that at least one player actually called this round.
    const categoriesInPlay = new Set<StatCategory>(Array.from(this.calls.values()).map((c) => c.category));
    const categoryOutcomes: CategoryOutcome[] = [];

    for (const category of categoriesInPlay) {
      const startValue = startTotals[category];
      const endValue = endTotals[category];
      const result: HiLoResult = endValue > startValue ? "higher" : endValue < startValue ? "lower" : "flat";

      const callsForCategory = Array.from(this.calls.values()).filter((c) => c.category === category);
      const higherCalls = callsForCategory.filter((c) => c.call === "higher").length;
      const higherPct = callsForCategory.length > 0 ? Math.round((higherCalls / callsForCategory.length) * 100) : 0;

      categoryOutcomes.push({
        category,
        startValue,
        endValue,
        result,
        higherPct,
        callsForCategory: callsForCategory.length,
      });
    }

    const outcomeByCategory = new Map(categoryOutcomes.map((o) => [o.category, o]));

    const playerOutcomes: PlayerRoundOutcome[] = [];
    for (const record of this.calls.values()) {
      const outcome = outcomeByCategory.get(record.category)!;
      // A "flat" result (stat didn't change) counts as a loss for everyone
      // who called it — no clear winner, streak resets. This mirrors the
      // odds-based engine's flat-round behavior for consistency.
      const won = outcome.result !== "flat" && record.call === outcome.result;

      const streakBefore = this.getPlayerStreak(record.userId);
      const streakAfter = won ? streakBefore + 1 : 0;
      const multiplier = won ? multiplierForStreak(streakAfter) : 1;
      const pointsEarned = won ? Math.round(this.config.basePoints * multiplier) : 0;

      this.playerStreaks.set(record.userId, streakAfter);
      this.playerPoints.set(record.userId, this.getPlayerPoints(record.userId) + pointsEarned);

      playerOutcomes.push({
        userId: record.userId,
        category: record.category,
        call: record.call,
        won,
        streakAfter,
        pointsEarned,
        multiplier,
      });
    }

    const payload: RoundResolvePayload = {
      roundId: this.roundCounter,
      fixtureId: this.config.fixtureId,
      startedAt: this.roundStartedAt,
      resolvedAt: Date.now(),
      categoryOutcomes,
      playerOutcomes,
    };

    for (const listener of this.onRoundResolveListeners) listener(payload);

    // Immediately open the next round from the current totals.
    this.startRound();
  }

  onRoundStart(fn: Listener<RoundStartPayload>) {
    this.onRoundStartListeners.push(fn);
  }
  onRoundResolve(fn: Listener<RoundResolvePayload>) {
    this.onRoundResolveListeners.push(fn);
  }
  onSnapshot(fn: Listener<StatSnapshot>) {
    this.onSnapshotListeners.push(fn);
  }

  getCurrentTotals() {
    return this.currentTotals;
  }

  getOpenRound() {
    if (this.roundStartTotals === null || this.roundStartedAt === null) return null;
    return {
      roundId: this.roundCounter,
      startTotals: this.roundStartTotals,
      startedAt: this.roundStartedAt,
      callsSoFar: this.calls.size,
    };
  }

  stop() {
    if (this.roundTimer) clearTimeout(this.roundTimer);
  }
}