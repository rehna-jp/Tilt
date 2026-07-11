"use client";

import { useEffect, useRef, useState } from "react";

// Mirrors ingestion/game/statTypes.ts and statRoundEngine.ts exactly —
// keep these in sync if the backend shapes change.
export type StatCategory = "goals" | "yellowCards" | "redCards" | "corners";
export type HiLoCall = "higher" | "lower";
export type HiLoResult = "higher" | "lower" | "flat";

export interface StatTotals {
  goals: number;
  yellowCards: number;
  redCards: number;
  corners: number;
}

export interface OpenRound {
  roundId: number;
  startTotals: StatTotals;
  startedAt: number;
  callsSoFar: number;
}

export interface CategoryOutcome {
  category: StatCategory;
  startValue: number;
  endValue: number;
  result: HiLoResult;
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

export type ConnectionStatus = "connecting" | "open" | "closed";

const STAT_SERVER_URL = process.env.NEXT_PUBLIC_STAT_SERVER_URL || "http://localhost:8788";

export function useStatGameSocket(userId: string | null) {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [currentTotals, setCurrentTotals] = useState<StatTotals | null>(null);
  const [openRound, setOpenRound] = useState<OpenRound | null>(null);
  const [lastResolved, setLastResolved] = useState<RoundResolvePayload | null>(null);
  const [history, setHistory] = useState<RoundResolvePayload[]>([]);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const source = new EventSource(`${STAT_SERVER_URL}/events`);
    sourceRef.current = source;

    source.onopen = () => setStatus("open");
    source.onerror = () => setStatus("closed");

    source.addEventListener("state", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        if (data.currentTotals) setCurrentTotals(data.currentTotals);
        if (data.openRound) setOpenRound(data.openRound);
      } catch {
        // ignore malformed payload
      }
    });

    source.addEventListener("snapshot", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        if (data.totals) setCurrentTotals(data.totals);
      } catch {
        // ignore malformed payload
      }
    });

    source.addEventListener("round_start", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        setOpenRound({
          roundId: data.roundId,
          startTotals: data.startTotals,
          startedAt: data.startedAt,
          callsSoFar: 0,
        });
      } catch {
        // ignore malformed payload
      }
    });

    source.addEventListener("round_resolve", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as RoundResolvePayload;
        setLastResolved(data);
        setHistory((prev) => [data, ...prev].slice(0, 20));
      } catch {
        // ignore malformed payload
      }
    });

    return () => source.close();
  }, []);

  async function submitCall(category: StatCategory, call: HiLoCall) {
    if (!userId) return false;
    const res = await fetch(`${STAT_SERVER_URL}/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, category, call }),
    });
    const data = await res.json();
    return Boolean(data.accepted);
  }

  // Convenience: this player's own outcome from the last resolved round, if any.
  const myLastOutcome =
    lastResolved && userId ? lastResolved.playerOutcomes.find((o) => o.userId === userId) ?? null : null;

  return { status, currentTotals, openRound, lastResolved, myLastOutcome, history, submitCall };
}