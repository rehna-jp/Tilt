"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useWallet } from "@solana/wallet-adapter-react";
import { CrowdMeter } from "@/components/CrowdMeter";
import { StreakBadge } from "@/components/StreakBadge";
import { useStatGameSocket, StatCategory, HiLoCall } from "@/lib/useStatGameSocket";

// WalletMultiButton renders differently on the server (no wallet extension
// visible yet) vs. the client (after it detects Phantom/Solflare), which
// causes a hydration mismatch if server-rendered. Loading it client-only
// fixes this — standard, documented fix for @solana/wallet-adapter-react-ui.
const WalletMultiButton = dynamic(
  async () => (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton,
  { ssr: false }
);

const ROUND_DURATION_MS = Number(process.env.NEXT_PUBLIC_ROUND_DURATION_MS || "90000");

const CATEGORY_LABELS: Record<StatCategory, string> = {
  goals: "Goals",
  yellowCards: "Yellow Cards",
  redCards: "Red Cards",
  corners: "Corners",
};

const CATEGORY_ORDER: StatCategory[] = ["goals", "yellowCards", "redCards", "corners"];

export default function Home() {
  const { publicKey, connected } = useWallet();
  const userId = publicKey?.toBase58() ?? null;

  const { status, currentTotals, openRound, lastResolved, myLastOutcome, history, submitCall } =
    useStatGameSocket(userId);

  const [selectedCategory, setSelectedCategory] = useState<StatCategory>("corners");
  const [myCall, setMyCall] = useState<HiLoCall | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [streak, setStreak] = useState(0);

  useEffect(() => {
    setMyCall(null);
  }, [openRound?.roundId]);

  useEffect(() => {
    if (myLastOutcome) setStreak(myLastOutcome.streakAfter);
  }, [myLastOutcome]);

  useEffect(() => {
    if (!openRound) {
      setSecondsLeft(null);
      return;
    }
    const tick = () => {
      const elapsed = Date.now() - openRound.startedAt;
      setSecondsLeft(Math.max(0, Math.ceil((ROUND_DURATION_MS - elapsed) / 1000)));
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [openRound]);

  async function handleCall(call: HiLoCall) {
    setSubmitting(true);
    const accepted = await submitCall(selectedCategory, call);
    if (accepted) setMyCall(call);
    setSubmitting(false);
  }

  const startValueForSelected = openRound?.startTotals[selectedCategory] ?? null;
  const currentValueForSelected = currentTotals?.[selectedCategory] ?? null;

  const myResolvedOutcome = lastResolved?.playerOutcomes.find((o) => o.userId === userId) ?? null;
  const consensusForMyCategory = lastResolved?.categoryOutcomes.find(
    (o) => o.category === (myResolvedOutcome?.category ?? selectedCategory)
  );

  return (
    <main className="page">
      <header className="topbar">
        <div className="brand">TILT</div>
        <WalletMultiButton />
      </header>

      <section className="stage">
        <div className="status-row">
          <span className={`status-dot status-${status}`} />
          <span className="status-label">
            {status === "open" ? "Live" : status === "connecting" ? "Connecting" : "Disconnected"}
          </span>
          <span className="spacer" />
          <StreakBadge streak={streak} />
        </div>

        <div className="category-picker">
          {CATEGORY_ORDER.map((cat) => (
            <button
              key={cat}
              className={`category-btn ${selectedCategory === cat ? "active" : ""}`}
              onClick={() => setSelectedCategory(cat)}
              disabled={myCall !== null}
            >
              <span className="category-label">{CATEGORY_LABELS[cat]}</span>
              <span className="category-value">{currentTotals ? currentTotals[cat] : "—"}</span>
            </button>
          ))}
        </div>

        <div className="selected-readout">
          <span className="readout-label">{CATEGORY_LABELS[selectedCategory]} this round</span>
          <span className="readout-value">
            {startValueForSelected !== null ? startValueForSelected : "—"}
            <span className="readout-arrow">→</span>
            {currentValueForSelected !== null ? currentValueForSelected : "—"}
          </span>
        </div>

        <div className="round-meta">
          {openRound ? (
            <>
              Round {openRound.roundId}
              {secondsLeft !== null && <> · {secondsLeft}s left</>}
            </>
          ) : (
            "Waiting for a live round to open…"
          )}
        </div>

        <div className="call-row">
          <button
            className="call-btn higher"
            disabled={!connected || !openRound || submitting || myCall !== null}
            onClick={() => handleCall("higher")}
          >
            ▲ Higher
          </button>
          <button
            className="call-btn lower"
            disabled={!connected || !openRound || submitting || myCall !== null}
            onClick={() => handleCall("lower")}
          >
            ▼ Lower
          </button>
        </div>

        {!connected && <div className="hint">Connect your wallet to make a call.</div>}
        {myCall && (
          <div className="hint">
            Your call: {CATEGORY_LABELS[selectedCategory]} {myCall === "higher" ? "▲ Higher" : "▼ Lower"} — locked in.
          </div>
        )}

        {myResolvedOutcome && (
          <div className={`result-banner ${myResolvedOutcome.won ? "won" : "lost"}`}>
            <div className="result-headline">
              {myResolvedOutcome.won ? "You won this round" : "You lost this round"}
            </div>
            <div className="result-detail">
              {CATEGORY_LABELS[myResolvedOutcome.category]} called {myResolvedOutcome.call}
              {myResolvedOutcome.won && (
                <> — +{myResolvedOutcome.pointsEarned} pts (×{myResolvedOutcome.multiplier})</>
              )}
            </div>
            {consensusForMyCategory && (
              <div className="result-consensus">
                <CrowdMeter
                  higherPct={consensusForMyCategory.higherPct}
                  totalCalls={consensusForMyCategory.callsForCategory}
                />
              </div>
            )}
          </div>
        )}
      </section>

      <section className="history">
        <h2>Recent rounds</h2>
        <div className="ticker">
          {history.length === 0 && <span className="hint">No resolved rounds yet.</span>}
          {history.map((r) => (
            <div key={r.roundId} className="ticker-item">
              <span className="ticker-round">#{r.roundId}</span>
              <span className="ticker-cats">
                {r.categoryOutcomes.map((o) => (
                  <span key={o.category} className={`ticker-cat ${o.result}`}>
                    {CATEGORY_LABELS[o.category]}: {o.result === "flat" ? "flat" : o.result === "higher" ? "▲" : "▼"}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      </section>

      <style jsx>{`
        .page {
          min-height: 100vh;
          max-width: 640px;
          margin: 0 auto;
          padding: 24px 20px 60px;
          display: flex;
          flex-direction: column;
          gap: 32px;
        }
        .topbar {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .brand {
          font-family: var(--font-display);
          font-weight: 800;
          font-size: 28px;
          letter-spacing: 0.04em;
          color: var(--line);
        }
        .stage {
          background: var(--bg-elevated);
          border: 1px solid var(--border);
          border-radius: 16px;
          padding: 28px 22px;
          display: flex;
          flex-direction: column;
          gap: 18px;
        }
        .status-row {
          display: flex;
          align-items: center;
          gap: 8px;
          font-family: var(--font-mono);
          font-size: 12px;
          color: var(--text-dim);
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .status-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: var(--text-dim);
        }
        .status-open {
          background: var(--up);
        }
        .status-connecting {
          background: var(--line);
        }
        .status-closed {
          background: var(--down);
        }
        .spacer {
          flex: 1;
        }
        .category-picker {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 10px;
        }
        .category-btn {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 4px;
          padding: 12px 14px;
          border-radius: 10px;
          border: 1px solid var(--border);
          background: var(--bg-elevated-2);
          color: var(--text);
          cursor: pointer;
          transition: border-color 120ms ease;
        }
        .category-btn.active {
          border-color: var(--line);
        }
        .category-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .category-label {
          font-family: var(--font-body);
          font-size: 13px;
          color: var(--text-dim);
        }
        .category-value {
          font-family: var(--font-mono);
          font-size: 22px;
          font-weight: 600;
          color: var(--text);
        }
        .selected-readout {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          padding: 10px 4px;
          border-bottom: 1px solid var(--border);
        }
        .readout-label {
          font-size: 13px;
          color: var(--text-dim);
        }
        .readout-value {
          font-family: var(--font-mono);
          font-size: 20px;
          font-weight: 600;
          color: var(--line);
        }
        .readout-arrow {
          margin: 0 8px;
          color: var(--text-dim);
        }
        .round-meta {
          font-family: var(--font-mono);
          font-size: 13px;
          color: var(--text-dim);
        }
        .call-row {
          display: flex;
          gap: 16px;
        }
        .call-btn {
          flex: 1;
          padding: 16px;
          border-radius: 10px;
          border: 1px solid var(--border);
          background: var(--bg-elevated-2);
          color: var(--text);
          font-family: var(--font-display);
          font-weight: 700;
          font-size: 18px;
          letter-spacing: 0.03em;
          cursor: pointer;
          transition: transform 120ms ease;
        }
        .call-btn:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
        .call-btn:not(:disabled):hover {
          transform: translateY(-2px);
        }
        .call-btn.higher {
          border-color: var(--up);
          color: var(--up);
        }
        .call-btn.lower {
          border-color: var(--down);
          color: var(--down);
        }
        .hint {
          font-size: 13px;
          color: var(--text-dim);
        }
        .result-banner {
          padding: 16px;
          border-radius: 12px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .result-banner.won {
          background: rgba(53, 208, 127, 0.1);
          border: 1px solid var(--up);
        }
        .result-banner.lost {
          background: rgba(255, 92, 92, 0.08);
          border: 1px solid var(--down);
        }
        .result-headline {
          font-family: var(--font-display);
          font-weight: 700;
          font-size: 18px;
        }
        .result-banner.won .result-headline {
          color: var(--up);
        }
        .result-banner.lost .result-headline {
          color: var(--down);
        }
        .result-detail {
          font-family: var(--font-mono);
          font-size: 13px;
          color: var(--text-dim);
        }
        .history h2 {
          font-family: var(--font-display);
          font-size: 20px;
          font-weight: 700;
          margin: 0 0 12px;
          color: var(--text-dim);
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .ticker {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .ticker-item {
          display: flex;
          flex-direction: column;
          gap: 4px;
          padding: 10px 12px;
          border-radius: 8px;
          background: var(--bg-elevated);
          border: 1px solid var(--border);
        }
        .ticker-round {
          font-family: var(--font-mono);
          font-size: 12px;
          color: var(--text-dim);
        }
        .ticker-cats {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
          font-family: var(--font-mono);
          font-size: 12px;
        }
        .ticker-cat.higher {
          color: var(--up);
        }
        .ticker-cat.lower {
          color: var(--down);
        }
        .ticker-cat.flat {
          color: var(--text-dim);
        }
      `}</style>
    </main>
  );
}