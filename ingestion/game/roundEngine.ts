/**
 * Tilt — Round Engine
 *
 * Pure game logic, no framework dependencies. Consumes raw TxLINE odds ticks
 * (verified shape from a live devnet run, 2026-07) and manages the
 * "will the line go up or down" round loop for a single fixture + market.
 *
 * Real tick shape (confirmed live):
 *   {
 *     FixtureId: number,
 *     MessageId: string,
 *     Ts: number,              // unix ms
 *     Bookmaker: string,
 *     BookmakerId: number,
 *     SuperOddsType: string,   // e.g. "1X2_PARTICIPANT_RESULT"
 *     GameState: string | null,
 *     InRunning: boolean,
 *     MarketParameters: string | null,  // e.g. "line=1.5"
 *     MarketPeriod: string | null,
 *     PriceNames: string[],    // e.g. ["part1","draw","part2"]
 *     Prices: number[],        // decimal odds * 1000, aligned with PriceNames
 *     Pct: string[]            // implied probability strings, can be "NA"
 *   }
 *
 * Heartbeats look like: { Ts: 1783134981 } — no other fields. Must be skipped.
 */

export interface OddsTick {
  FixtureId?: number;
  MessageId?: string;
  Ts: number;
  Bookmaker?: string;
  BookmakerId?: number;
  SuperOddsType?: string;
  GameState?: string | null;
  InRunning?: boolean;
  MarketParameters?: string | null;
  MarketPeriod?: string | null;
  PriceNames?: string[];
  Prices?: number[];
  Pct?: string[];
}

export type RoundDirection = "up" | "down" | "flat";
export type PlayerCall = "up" | "down";

export interface RoundResult {
  roundId: number;
  fixtureId: number;
  priceName: string;
  startLine: number; // decimal odds
  endLine: number;
  startedAt: number;
  resolvedAt: number;
  direction: RoundDirection;
}

export interface RoundEngineConfig {
  fixtureId: number;
  /** Which market to track, e.g. "1X2_PARTICIPANT_RESULT" */
  superOddsType: string;
  /** Which outcome within that market to track, e.g. "part1" */
  priceName: string;
  /** How long each round stays open before forcing resolution against the latest seen line, in ms */
  roundDurationMs: number;
  /** Minimum odds movement (decimal) to count as up/down rather than flat */
  flatThreshold?: number;
}

type Listener<T> = (payload: T) => void;

export class RoundEngine {
  private config: Required<RoundEngineConfig>;
  private currentLine: number | null = null;
  private roundStartLine: number | null = null;
  private roundStartedAt: number | null = null;
  private roundTimer: ReturnType<typeof setTimeout> | null = null;
  private roundCounter = 0;
  private calls = new Map<string, PlayerCall>(); // userId -> call, for the currently open round

  private onRoundStartListeners: Listener<{ roundId: number; startLine: number; startedAt: number }>[] = [];
  private onRoundResolveListeners: Listener<RoundResult & { winners: string[]; losers: string[] }>[] = [];
  private onTickListeners: Listener<{ line: number; ts: number }>[] = [];

  constructor(config: RoundEngineConfig) {
    this.config = { flatThreshold: 0.01, ...config };
  }

  /** Feed a raw tick from the SSE stream. Returns true if it updated the tracked line. */
  ingest(tick: OddsTick): boolean {
    // Skip heartbeats and anything missing the fields we need
    if (
      tick.FixtureId === undefined ||
      tick.SuperOddsType === undefined ||
      !tick.PriceNames ||
      !tick.Prices
    ) {
      return false;
    }

    if (tick.FixtureId !== this.config.fixtureId) return false;
    if (tick.SuperOddsType !== this.config.superOddsType) return false;

    const idx = tick.PriceNames.indexOf(this.config.priceName);
    if (idx === -1) return false;

    const rawPrice = tick.Prices[idx];
    if (rawPrice === undefined || rawPrice <= 0) return false;

    const decimalOdds = rawPrice / 1000;
    this.currentLine = decimalOdds;

    for (const listener of this.onTickListeners) {
      listener({ line: decimalOdds, ts: tick.Ts });
    }

    // If no round is open yet, start one now that we have a real line
    if (this.roundStartLine === null) {
      this.startRound();
    }

    return true;
  }

  private startRound() {
    if (this.currentLine === null) return;
    this.roundCounter++;
    this.roundStartLine = this.currentLine;
    this.roundStartedAt = Date.now();
    this.calls.clear();

    for (const listener of this.onRoundStartListeners) {
      listener({
        roundId: this.roundCounter,
        startLine: this.roundStartLine,
        startedAt: this.roundStartedAt,
      });
    }

    if (this.roundTimer) clearTimeout(this.roundTimer);
    this.roundTimer = setTimeout(() => this.resolveRound(), this.config.roundDurationMs);
  }

  /** Register a player's up/down call for the currently open round. */
  submitCall(userId: string, call: PlayerCall) {
    if (this.roundStartLine === null) return false;
    this.calls.set(userId, call);
    return true;
  }

  private resolveRound() {
    if (this.roundStartLine === null || this.currentLine === null || this.roundStartedAt === null) {
      return;
    }

    const startLine = this.roundStartLine;
    const endLine = this.currentLine;
    const delta = endLine - startLine;

    let direction: RoundDirection;
    if (Math.abs(delta) < this.config.flatThreshold) {
      direction = "flat";
    } else {
      direction = delta > 0 ? "up" : "down";
    }

    const winners: string[] = [];
    const losers: string[] = [];
    for (const [userId, call] of this.calls.entries()) {
      if (direction !== "flat" && call === direction) {
        winners.push(userId);
      } else {
        losers.push(userId);
      }
    }

    const result: RoundResult = {
      roundId: this.roundCounter,
      fixtureId: this.config.fixtureId,
      priceName: this.config.priceName,
      startLine,
      endLine,
      startedAt: this.roundStartedAt,
      resolvedAt: Date.now(),
      direction,
    };

    for (const listener of this.onRoundResolveListeners) {
      listener({ ...result, winners, losers });
    }

    // Immediately open the next round using the same line as the new baseline
    this.startRound();
  }

  onRoundStart(fn: Listener<{ roundId: number; startLine: number; startedAt: number }>) {
    this.onRoundStartListeners.push(fn);
  }

  onRoundResolve(fn: Listener<RoundResult & { winners: string[]; losers: string[] }>) {
    this.onRoundResolveListeners.push(fn);
  }

  onTick(fn: Listener<{ line: number; ts: number }>) {
    this.onTickListeners.push(fn);
  }

  getCurrentLine() {
    return this.currentLine;
  }

  getOpenRound() {
    if (this.roundStartLine === null || this.roundStartedAt === null) return null;
    return {
      roundId: this.roundCounter,
      startLine: this.roundStartLine,
      startedAt: this.roundStartedAt,
      callsSoFar: this.calls.size,
    };
  }

  stop() {
    if (this.roundTimer) clearTimeout(this.roundTimer);
  }
}