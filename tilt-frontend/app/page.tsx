"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useWallet } from "@solana/wallet-adapter-react";
import { CrowdMeter } from "@/components/CrowdMeter";
import { StreakBadge } from "@/components/StreakBadge";
import { Leaderboard } from "@/components/Leaderboard";
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
const ROUND_DURATION_S  = ROUND_DURATION_MS / 1000;

const CATEGORY_LABELS: Record<StatCategory, string> = {
  goals:       "Goals",
  yellowCards: "Yellow Cards",
  redCards:    "Red Cards",
  corners:     "Corners",
};

const CATEGORY_ICONS: Record<StatCategory, string> = {
  goals:       "⚽",
  yellowCards: "🟨",
  redCards:    "🟥",
  corners:     "🚩",
};

const CATEGORY_ORDER: StatCategory[] = ["goals", "yellowCards", "redCards", "corners"];

// SVG ring countdown
const RING_R  = 22;
const RING_C  = 2 * Math.PI * RING_R; // ≈ 138.23

function CountdownRing({
  secondsLeft,
  total,
}: {
  secondsLeft: number | null;
  total: number;
}) {
  if (secondsLeft === null) return null;
  const pct    = Math.max(0, Math.min(1, secondsLeft / total));
  const offset = RING_C * (1 - pct);
  const isLow  = secondsLeft <= 15;

  return (
    <div className="countdown-wrap">
      <svg width="56" height="56" viewBox="0 0 56 56" aria-hidden="true">
        {/* Track */}
        <circle
          cx="28" cy="28" r={RING_R}
          fill="none"
          stroke="var(--border)"
          strokeWidth="3"
        />
        {/* Progress arc — starts at 12 o'clock */}
        <circle
          cx="28" cy="28" r={RING_R}
          fill="none"
          stroke={isLow ? "var(--down)" : "var(--line)"}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={RING_C}
          strokeDashoffset={offset}
          style={{
            transformOrigin: "28px 28px",
            transform: "rotate(-90deg)",
            transition: "stroke-dashoffset 1s linear, stroke 300ms ease",
            filter: isLow
              ? "drop-shadow(0 0 4px var(--down))"
              : "drop-shadow(0 0 4px var(--line-glow))",
          }}
        />
        <text
          x="28" y="33"
          textAnchor="middle"
          fontSize="13"
          fontWeight="700"
          fontFamily="var(--font-mono)"
          fill={isLow ? "var(--down)" : "var(--text)"}
        >
          {secondsLeft}
        </text>
      </svg>
    </div>
  );
}

export default function Home() {
  const { publicKey, connected } = useWallet();
  const userId = publicKey?.toBase58() ?? null;

  const {
    status,
    currentTotals,
    openRound,
    lastResolved,
    myLastOutcome,
    history,
    matchInfo,
    submitCall,
    fetchSessionStats,
  } = useStatGameSocket(userId);

  const [selectedCategory, setSelectedCategory] = useState<StatCategory>("corners");
  const [myCall, setMyCall]           = useState<HiLoCall | null>(null);
  const [submitting, setSubmitting]   = useState(false);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [streak, setStreak]           = useState(0);
  const [sessionPoints, setSessionPoints]       = useState(0);
  const [leaderboardRefreshKey, setLeaderboardRefreshKey] = useState(0);

  useEffect(() => { setMyCall(null); }, [openRound?.roundId]);

  useEffect(() => {
    if (myLastOutcome) setStreak(myLastOutcome.streakAfter);
  }, [myLastOutcome]);

  // Session points are THIS game mode's own running total (not the combined
  // on-chain total, which sums points from every game sharing this wallet's
  // PlayerScore PDA). Refetched each time a round resolves.
  useEffect(() => {
    if (!lastResolved) return;
    fetchSessionStats().then((stats) => {
      if (stats) setSessionPoints(stats.sessionPoints);
    });
  }, [lastResolved, fetchSessionStats]);

  // Bump the leaderboard refresh key whenever a round resolves — the
  // on-chain write happens async on the server right after resolution, so
  // this fetch may occasionally beat the actual write; a manual refresh a
  // few seconds later would catch it. Good enough for now, worth revisiting
  // if it feels laggy in practice.
  useEffect(() => {
    if (lastResolved) setLeaderboardRefreshKey((k) => k + 1);
  }, [lastResolved]);

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

  const startValueForSelected   = openRound?.startTotals[selectedCategory] ?? null;
  const currentValueForSelected = currentTotals?.[selectedCategory] ?? null;

  const myResolvedOutcome = lastResolved?.playerOutcomes.find((o) => o.userId === userId) ?? null;
  const consensusForMyCategory = lastResolved?.categoryOutcomes.find(
    (o) => o.category === (myResolvedOutcome?.category ?? selectedCategory)
  );

  const isLive   = status === "open";
  const isCallable = connected && !!openRound && !submitting && myCall === null;

  return (
    <main className="page">
      {/* ── Top Bar ────────────────────────────────── */}
      <header className="topbar">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/logo.png"
          alt="Tilt"
          className="brand-logo"
        />
        <div className="topbar-right">
          {sessionPoints > 0 && (
            <div className="pts-chip">
              <span className="pts-value">{sessionPoints}</span>
              <span className="pts-label">pts</span>
            </div>
          )}
          <StreakBadge streak={streak} />
          <WalletMultiButton />
        </div>
      </header>

      {/* ── Match Banner ───────────────────────────── */}
      {matchInfo && (
        <div className="match-banner">
          <div className="match-inner">
            <div className="match-teams">
              <span className="match-team">{matchInfo.homeTeam}</span>
              <span className="match-vs">VS</span>
              <span className="match-team">{matchInfo.awayTeam}</span>
            </div>
            {matchInfo.competition && (
              <div className="match-competition">{matchInfo.competition}</div>
            )}
          </div>
        </div>
      )}

      {/* ── Two-col layout ─────────────────────────── */}
      <div className="layout-grid">
        {/* ── LEFT: Game Stage ─────────────────────── */}
        <section className="stage">
          {/* Status bar */}
          <div className="status-row">
            <span className={`status-dot status-${status}`} aria-hidden="true" />
            <span className="status-label">
              {isLive ? "Live" : status === "connecting" ? "Connecting…" : "Offline"}
            </span>
            {openRound && (
              <span className="round-chip">Round {openRound.roundId}</span>
            )}
          </div>

          {/* Stat category picker */}
          <div className="category-picker">
            {CATEGORY_ORDER.map((cat) => (
              <button
                key={cat}
                id={`cat-${cat}`}
                className={`category-btn${selectedCategory === cat ? " active" : ""}`}
                onClick={() => setSelectedCategory(cat)}
                disabled={myCall !== null}
                aria-pressed={selectedCategory === cat}
              >
                <span className="cat-icon" aria-hidden="true">{CATEGORY_ICONS[cat]}</span>
                <span className="cat-label">{CATEGORY_LABELS[cat]}</span>
                <span className="cat-value">
                  {currentTotals ? currentTotals[cat] : "—"}
                </span>
              </button>
            ))}
          </div>

          {/* Selected readout */}
          <div className="readout-bar">
            <div className="readout-stat">
              <span className="readout-label">
                {CATEGORY_LABELS[selectedCategory]} — this round
              </span>
              <div className="readout-values">
                <span className="readout-start">
                  {startValueForSelected !== null ? startValueForSelected : "—"}
                </span>
                <span className="readout-arrow" aria-hidden="true">→</span>
                <span className="readout-current">
                  {currentValueForSelected !== null ? currentValueForSelected : "—"}
                </span>
              </div>
            </div>
            <CountdownRing secondsLeft={secondsLeft} total={ROUND_DURATION_S} />
          </div>

          {/* Call buttons */}
          <div className="call-row">
            <button
              id="call-higher"
              className="call-btn higher"
              disabled={!isCallable}
              onClick={() => handleCall("higher")}
            >
              <span className="call-arrow" aria-hidden="true">▲</span>
              <span className="call-word">Higher</span>
            </button>
            <button
              id="call-lower"
              className="call-btn lower"
              disabled={!isCallable}
              onClick={() => handleCall("lower")}
            >
              <span className="call-word">Lower</span>
              <span className="call-arrow" aria-hidden="true">▼</span>
            </button>
          </div>

          {/* Hint messages */}
          {!connected && (
            <div className="hint-row">
              <span className="hint-icon" aria-hidden="true">🔗</span>
              Connect your wallet to make a call.
            </div>
          )}
          {myCall && !myResolvedOutcome && (
            <div className="locked-in">
              <span className="locked-icon" aria-hidden="true">
                {myCall === "higher" ? "▲" : "▼"}
              </span>
              <span>
                Locked in — {CATEGORY_LABELS[selectedCategory]}&nbsp;
                <strong>{myCall === "higher" ? "Higher" : "Lower"}</strong>
              </span>
            </div>
          )}

          {/* Result banner */}
          {myResolvedOutcome && (
            <div className={`result-banner ${myResolvedOutcome.won ? "won" : "lost"}`}>
              <div className="result-headline">
                {myResolvedOutcome.won ? "🏆 You called it!" : "💀 Missed this one"}
              </div>
              <div className="result-detail">
                {CATEGORY_LABELS[myResolvedOutcome.category]} went&nbsp;
                <strong>
                  {myResolvedOutcome.call === "higher" ? "▲ higher" : "▼ lower"}
                </strong>
                {myResolvedOutcome.won && (
                  <span className="result-pts">
                    +{myResolvedOutcome.pointsEarned} pts
                    <span className="result-mult">×{myResolvedOutcome.multiplier}</span>
                  </span>
                )}
              </div>
              {consensusForMyCategory && (
                <div className="result-crowd">
                  <CrowdMeter
                    higherPct={consensusForMyCategory.higherPct}
                    totalCalls={consensusForMyCategory.callsForCategory}
                  />
                </div>
              )}
            </div>
          )}
        </section>

        {/* ── RIGHT: Sidebar ───────────────────────── */}
        <aside className="sidebar">
          <Leaderboard myUserId={userId} refreshKey={leaderboardRefreshKey} />

          {/* Recent rounds history */}
          <section className="history">
            <h2 className="section-title">Recent Rounds</h2>
            <div className="ticker">
              {history.length === 0 && (
                <div className="ticker-empty">No resolved rounds yet</div>
              )}
              {history.map((r) => (
                <div key={r.roundId} className="ticker-item">
                  <span className="ticker-round">#{r.roundId}</span>
                  <span className="ticker-cats">
                    {r.categoryOutcomes.map((o) => (
                      <span key={o.category} className={`ticker-cat ${o.result}`}>
                        {CATEGORY_ICONS[o.category as StatCategory]}
                        {o.result === "flat" ? " flat" : o.result === "higher" ? " ▲" : " ▼"}
                      </span>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>

      <style jsx>{`
        /* ─── Page ─────────────────────────────────── */
        .page {
          min-height: 100vh;
          max-width: 1100px;
          margin: 0 auto;
          padding: 20px 20px 80px;
          display: flex;
          flex-direction: column;
          gap: 20px;
        }

        /* ─── Top Bar ──────────────────────────────── */
        .topbar {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 16px;
          padding: 14px 20px;
          border-radius: var(--r-xl);
          background: var(--bg-glass);
          backdrop-filter: var(--glass-blur);
          -webkit-backdrop-filter: var(--glass-blur);
          border: 1px solid var(--glass-border);
          position: sticky;
          top: 12px;
          z-index: 10;
          box-shadow: var(--shadow-sm);
        }
        .brand-logo {
          height: 44px;
          width: auto;
          display: block;
          filter: drop-shadow(0 0 10px rgba(242, 199, 68, 0.45));
          transition: filter var(--t-mid), transform var(--t-fast);
        }
        .brand-logo:hover {
          filter: drop-shadow(0 0 16px rgba(242, 199, 68, 0.7));
          transform: scale(1.03);
        }
        .topbar-right {
          display: flex;
          align-items: center;
          gap: 12px;
          flex-wrap: wrap;
        }
        .pts-chip {
          display: flex;
          align-items: baseline;
          gap: 3px;
          background: var(--line-muted);
          border: 1px solid rgba(242,199,68,0.25);
          border-radius: var(--r-pill);
          padding: 5px 12px;
          animation: fade-in 400ms ease;
        }
        .pts-value {
          font-family: var(--font-mono);
          font-weight: 700;
          font-size: 15px;
          color: var(--line);
        }
        .pts-label {
          font-size: 11px;
          color: var(--text-dim);
          font-family: var(--font-body);
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }

        /* ─── Match Banner ─────────────────────────── */
        .match-banner {
          border-radius: var(--r-lg);
          background: var(--bg-2);
          border: 1px solid var(--border);
          overflow: hidden;
          animation: slide-up 350ms cubic-bezier(.4,0,.2,1);
        }
        .match-inner {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          padding: 14px 22px;
        }
        .match-teams {
          display: flex;
          align-items: center;
          gap: 14px;
        }
        .match-team {
          font-family: var(--font-display);
          font-weight: 800;
          font-size: 18px;
          letter-spacing: 0.02em;
          color: var(--text);
          text-transform: uppercase;
        }
        .match-vs {
          font-family: var(--font-mono);
          font-size: 11px;
          color: var(--text-faint);
          font-weight: 700;
          letter-spacing: 0.1em;
          border: 1px solid var(--border);
          border-radius: var(--r-sm);
          padding: 2px 6px;
        }
        .match-competition {
          font-family: var(--font-mono);
          font-size: 11px;
          color: var(--text-dim);
          text-transform: uppercase;
          letter-spacing: 0.06em;
          background: var(--bg-3);
          border: 1px solid var(--border);
          border-radius: var(--r-pill);
          padding: 4px 10px;
        }

        /* ─── Two-col layout ───────────────────────── */
        .layout-grid {
          display: grid;
          grid-template-columns: 1fr;
          gap: 20px;
          align-items: start;
        }
        @media (min-width: 900px) {
          .layout-grid {
            grid-template-columns: 1.2fr 1fr;
          }
        }

        /* ─── Stage ────────────────────────────────── */
        .stage {
          background: var(--bg-1);
          border: 1px solid var(--border);
          border-radius: var(--r-xl);
          padding: 24px 22px;
          display: flex;
          flex-direction: column;
          gap: 20px;
          box-shadow: var(--shadow-md);
          position: relative;
          overflow: hidden;
        }
        /* Subtle glow orb top-right */
        .stage::before {
          content: "";
          position: absolute;
          top: -40px;
          right: -40px;
          width: 180px;
          height: 180px;
          border-radius: 50%;
          background: radial-gradient(circle, rgba(242,199,68,0.05) 0%, transparent 70%);
          pointer-events: none;
        }

        /* ─── Status Row ───────────────────────────── */
        .status-row {
          display: flex;
          align-items: center;
          gap: 8px;
          font-family: var(--font-mono);
          font-size: 12px;
          color: var(--text-dim);
          text-transform: uppercase;
          letter-spacing: 0.06em;
        }
        .status-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: var(--text-dim);
          flex-shrink: 0;
        }
        .status-open {
          background: var(--up);
          animation: pulse-dot 2s ease-in-out infinite;
        }
        .status-connecting {
          background: var(--line);
          animation: pulse-dot-warn 1.2s ease-in-out infinite;
        }
        .status-closed {
          background: var(--down);
        }
        .status-label { color: var(--text-dim); }
        .round-chip {
          margin-left: auto;
          font-family: var(--font-mono);
          font-size: 11px;
          color: var(--text-dim);
          background: var(--bg-3);
          border: 1px solid var(--border);
          border-radius: var(--r-pill);
          padding: 3px 10px;
        }

        /* ─── Category Picker ──────────────────────── */
        .category-picker {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px;
        }
        .category-btn {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 6px;
          padding: 14px 16px;
          border-radius: var(--r-md);
          border: 1.5px solid var(--border);
          background: var(--bg-2);
          color: var(--text);
          cursor: pointer;
          transition:
            border-color var(--t-mid),
            background var(--t-mid),
            box-shadow var(--t-mid),
            transform var(--t-fast);
          text-align: left;
        }
        .category-btn:hover:not(:disabled) {
          border-color: var(--border-hi);
          background: var(--bg-3);
          transform: translateY(-1px);
        }
        .category-btn.active {
          border-color: var(--line);
          background: var(--line-muted);
          box-shadow: 0 0 0 1px rgba(242,199,68,0.15), inset 0 1px 0 rgba(255,255,255,0.04);
        }
        .category-btn:disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }
        .cat-icon {
          font-size: 18px;
          line-height: 1;
        }
        .cat-label {
          font-size: 12px;
          color: var(--text-dim);
          font-family: var(--font-body);
          font-weight: 500;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .cat-value {
          font-family: var(--font-mono);
          font-size: 26px;
          font-weight: 700;
          color: var(--text);
          line-height: 1;
        }

        /* ─── Readout Bar ──────────────────────────── */
        .readout-bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          padding: 14px 16px;
          border-radius: var(--r-md);
          background: var(--bg-2);
          border: 1px solid var(--border);
        }
        .readout-stat { flex: 1; }
        .readout-label {
          display: block;
          font-size: 12px;
          color: var(--text-dim);
          font-weight: 500;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          margin-bottom: 6px;
        }
        .readout-values {
          display: flex;
          align-items: baseline;
          gap: 10px;
        }
        .readout-start {
          font-family: var(--font-mono);
          font-size: 24px;
          font-weight: 700;
          color: var(--text-dim);
        }
        .readout-arrow {
          font-family: var(--font-mono);
          font-size: 16px;
          color: var(--text-faint);
        }
        .readout-current {
          font-family: var(--font-mono);
          font-size: 30px;
          font-weight: 700;
          color: var(--line);
          text-shadow: 0 0 16px var(--line-glow);
        }
        .countdown-wrap {
          flex-shrink: 0;
        }

        /* ─── Call Buttons ─────────────────────────── */
        .call-row {
          display: flex;
          gap: 12px;
        }
        .call-btn {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
          padding: 18px 16px;
          border-radius: var(--r-md);
          border: 1.5px solid transparent;
          font-family: var(--font-display);
          font-weight: 800;
          font-size: 22px;
          letter-spacing: 0.03em;
          text-transform: uppercase;
          cursor: pointer;
          transition:
            transform var(--t-fast),
            box-shadow var(--t-mid),
            filter var(--t-mid);
          position: relative;
          overflow: hidden;
        }
        .call-btn::after {
          content: "";
          position: absolute;
          inset: 0;
          background: rgba(255,255,255,0);
          transition: background var(--t-fast);
        }
        .call-btn:not(:disabled):hover::after {
          background: rgba(255,255,255,0.04);
        }
        .call-btn:not(:disabled):active {
          transform: scale(0.97);
        }
        .call-btn:disabled {
          opacity: 0.3;
          cursor: not-allowed;
        }
        .call-btn.higher {
          background: var(--grad-up);
          border-color: var(--up);
          color: var(--up);
        }
        .call-btn.higher:not(:disabled):hover {
          box-shadow: 0 4px 24px var(--up-glow);
          transform: translateY(-2px);
        }
        .call-btn.lower {
          background: var(--grad-down);
          border-color: var(--down);
          color: var(--down);
        }
        .call-btn.lower:not(:disabled):hover {
          box-shadow: 0 4px 24px var(--down-glow);
          transform: translateY(-2px);
        }
        .call-arrow {
          font-size: 20px;
          line-height: 1;
        }
        .call-word { line-height: 1; }

        /* ─── Hint / Lock-in ───────────────────────── */
        .hint-row {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 13px;
          color: var(--text-dim);
          animation: fade-in 300ms ease;
        }
        .hint-icon { font-size: 15px; }
        .locked-in {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 16px;
          border-radius: var(--r-sm);
          background: var(--line-muted);
          border: 1px solid rgba(242,199,68,0.2);
          font-size: 13px;
          color: var(--text-dim);
          animation: slide-up 250ms ease;
        }
        .locked-icon {
          font-size: 16px;
          color: var(--line);
        }
        .locked-in strong { color: var(--text); }

        /* ─── Result Banner ────────────────────────── */
        .result-banner {
          padding: 18px 20px;
          border-radius: var(--r-md);
          display: flex;
          flex-direction: column;
          gap: 10px;
          animation: result-in 350ms cubic-bezier(.4,0,.2,1);
        }
        .result-banner.won {
          background: var(--up-muted);
          border: 1.5px solid var(--up);
          box-shadow: 0 0 30px rgba(53,208,127,0.12);
        }
        .result-banner.lost {
          background: var(--down-muted);
          border: 1.5px solid var(--down);
          box-shadow: 0 0 30px rgba(255,92,92,0.10);
        }
        .result-headline {
          font-family: var(--font-display);
          font-weight: 800;
          font-size: 22px;
          letter-spacing: 0.02em;
          color: var(--text);
        }
        .result-banner.won .result-headline { color: var(--up); }
        .result-banner.lost .result-headline { color: var(--down); }
        .result-detail {
          font-family: var(--font-mono);
          font-size: 13px;
          color: var(--text-dim);
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
        }
        .result-detail strong { color: var(--text); }
        .result-pts {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          color: var(--line);
          font-weight: 700;
        }
        .result-mult {
          font-size: 11px;
          background: var(--line-muted);
          border: 1px solid rgba(242,199,68,0.25);
          border-radius: var(--r-pill);
          padding: 1px 6px;
        }
        .result-crowd { margin-top: 4px; }

        /* ─── Sidebar ──────────────────────────────── */
        .sidebar {
          display: flex;
          flex-direction: column;
          gap: 20px;
        }

        /* ─── History ──────────────────────────────── */
        .history {
          background: var(--bg-1);
          border: 1px solid var(--border);
          border-radius: var(--r-xl);
          padding: 22px 20px;
        }
        .section-title {
          font-family: var(--font-display);
          font-size: 16px;
          font-weight: 800;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--text-dim);
          margin-bottom: 14px;
        }
        .ticker {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .ticker-empty {
          font-size: 13px;
          color: var(--text-faint);
          font-family: var(--font-mono);
          padding: 8px 0;
        }
        .ticker-item {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 9px 12px;
          border-radius: var(--r-sm);
          background: var(--bg-2);
          border: 1px solid var(--border);
          transition: border-color var(--t-mid);
        }
        .ticker-item:hover { border-color: var(--border-hi); }
        .ticker-round {
          font-family: var(--font-mono);
          font-size: 11px;
          color: var(--text-faint);
          flex-shrink: 0;
          min-width: 28px;
        }
        .ticker-cats {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          font-family: var(--font-mono);
          font-size: 11px;
        }
        .ticker-cat {
          padding: 2px 6px;
          border-radius: var(--r-sm);
          background: var(--bg-3);
        }
        .ticker-cat.higher { color: var(--up); }
        .ticker-cat.lower  { color: var(--down); }
        .ticker-cat.flat   { color: var(--text-faint); }
      `}</style>
    </main>
  );
}