"use client";

import { useEffect, useRef, useState } from "react";

export type RoundDirection = "up" | "down" | "flat";

export interface OpenRound {
  roundId: number;
  startLine: number;
  startedAt: number;
  callsSoFar: number;
}

export interface ResolvedRound {
  roundId: number;
  fixtureId: number;
  priceName: string;
  startLine: number;
  endLine: number;
  startedAt: number;
  resolvedAt: number;
  direction: RoundDirection;
  winners: string[];
  losers: string[];
}

export type ConnectionStatus = "connecting" | "open" | "closed";

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:8787";

export function useGameSocket() {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [currentLine, setCurrentLine] = useState<number | null>(null);
  const [openRound, setOpenRound] = useState<OpenRound | null>(null);
  const [history, setHistory] = useState<ResolvedRound[]>([]);
  const [lastResolved, setLastResolved] = useState<ResolvedRound | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const source = new EventSource(`${SERVER_URL}/events`);
    sourceRef.current = source;

    source.onopen = () => setStatus("open");
    source.onerror = () => setStatus("closed");

    source.addEventListener("state", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        if (data.currentLine !== undefined) setCurrentLine(data.currentLine);
        if (data.openRound) setOpenRound(data.openRound);
      } catch {
        // ignore malformed payload
      }
    });

    source.addEventListener("tick", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        if (typeof data.line === "number") setCurrentLine(data.line);
      } catch {
        // ignore malformed payload
      }
    });

    source.addEventListener("round_start", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        setOpenRound({
          roundId: data.roundId,
          startLine: data.startLine,
          startedAt: data.startedAt,
          callsSoFar: 0,
        });
      } catch {
        // ignore malformed payload
      }
    });

    source.addEventListener("round_resolve", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as ResolvedRound;
        setLastResolved(data);
        setHistory((prev) => [data, ...prev].slice(0, 20));
      } catch {
        // ignore malformed payload
      }
    });

    return () => {
      source.close();
    };
  }, []);

  async function submitCall(userId: string, call: "up" | "down") {
    const res = await fetch(`${SERVER_URL}/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, call }),
    });
    const data = await res.json();
    return Boolean(data.accepted);
  }

  return { status, currentLine, openRound, history, lastResolved, submitCall };
}