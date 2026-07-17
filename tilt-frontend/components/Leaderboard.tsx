"use client";

import { useEffect, useState } from "react";

interface LeaderboardEntry {
  owner: string;
  bestStreak: number;
  totalPoints: number;
  matchesPlayed: number;
  roundsWon: number;
}

const STAT_SERVER_URL =
  process.env.NEXT_PUBLIC_STAT_SERVER_URL || "http://localhost:8788";

function shortenPubkey(pubkey: string): string {
  if (pubkey.length <= 10) return pubkey;
  return `${pubkey.slice(0, 4)}..${pubkey.slice(-4)}`;
}

const RANK_MEDALS: Record<number, string> = { 0: "🥇", 1: "🥈", 2: "🥉" };

interface LeaderboardProps {
  myUserId: string | null;
  /** Bumped by the parent whenever a round resolves, to trigger a refetch. */
  refreshKey: number;
}

function SkeletonRow() {
  return (
    <div className="lb-skeleton">
      <span className="skel skel-rank" />
      <span className="skel skel-owner" />
      <span className="skel skel-streak" />
      <span className="skel skel-pts" />
    </div>
  );
}

export function Leaderboard({ myUserId, refreshKey }: LeaderboardProps) {
  const [entries, setEntries]   = useState<LeaderboardEntry[] | null>(null);
  const [error, setError]       = useState<string | null>(null);
  const [showAll, setShowAll]   = useState(false);

  useEffect(() => {
    let cancelled = false;
    setEntries(null); // triggers skeleton on each refresh

    fetch(`${STAT_SERVER_URL}/leaderboard`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) {
          if (data.entries) {
            setEntries(data.entries);
            setError(null);
          } else {
            setError("Leaderboard unavailable");
          }
        }
      })
      .catch(() => {
        if (!cancelled) setError("Could not reach leaderboard");
      });

    return () => { cancelled = true; };
  }, [refreshKey]);

  const visible = entries
    ? showAll
      ? entries
      : entries.slice(0, 5)
    : null;

  return (
    <section className="leaderboard">
      <div className="lb-header">
        <h2 className="section-title">Leaderboard</h2>
        <span className="lb-subtitle">All-time · on-chain</span>
      </div>

      {error && <div className="lb-hint">{error}</div>}

      {/* Skeleton loading */}
      {!error && entries === null && (
        <div className="lb-list">
          {[0, 1, 2, 3].map((i) => <SkeletonRow key={i} />)}
        </div>
      )}

      {/* Empty state */}
      {!error && entries && entries.length === 0 && (
        <div className="lb-empty">
          <span className="lb-empty-icon" aria-hidden="true">🏆</span>
          <span>No players yet — be the first to win a round.</span>
        </div>
      )}

      {/* Entries */}
      {visible && visible.length > 0 && (
        <>
          <div className="lb-list">
            {visible.map((e, i) => {
              const isMe    = e.owner === myUserId;
              const medal   = RANK_MEDALS[i];
              return (
                <div key={e.owner} className={`lb-row${isMe ? " me" : ""}${i === 0 ? " first" : ""}`}>
                  <span className="lb-rank">
                    {medal ?? `#${i + 1}`}
                  </span>
                  <span className="lb-owner" title={e.owner}>
                    {isMe ? "You" : shortenPubkey(e.owner)}
                  </span>
                  <span className="lb-streak" title={`Best streak: ${e.bestStreak}`}>
                    🔥{e.bestStreak}
                  </span>
                  <span className="lb-points">{e.totalPoints} pts</span>
                </div>
              );
            })}
          </div>

          {entries && entries.length > 5 && (
            <button
              className="lb-show-more"
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll ? "Show less ▲" : `Show all ${entries.length} ▼`}
            </button>
          )}
        </>
      )}

      <style jsx>{`
        .leaderboard {
          background: var(--bg-1);
          border: 1px solid var(--border);
          border-radius: var(--r-xl);
          padding: 22px 20px;
          display: flex;
          flex-direction: column;
          gap: 14px;
        }
        .lb-header {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 12px;
        }
        .section-title {
          font-family: var(--font-display);
          font-size: 16px;
          font-weight: 800;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--text-dim);
        }
        .lb-subtitle {
          font-size: 11px;
          color: var(--text-faint);
          font-family: var(--font-mono);
          text-transform: uppercase;
          letter-spacing: 0.05em;
          background: var(--bg-3);
          border: 1px solid var(--border);
          border-radius: var(--r-pill);
          padding: 2px 8px;
        }
        .lb-hint {
          font-size: 13px;
          color: var(--text-dim);
          font-family: var(--font-mono);
        }
        .lb-empty {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 13px;
          color: var(--text-dim);
          padding: 8px 0;
        }
        .lb-empty-icon { font-size: 18px; }
        .lb-list {
          display: flex;
          flex-direction: column;
          gap: 5px;
        }

        /* Skeleton */
        .lb-skeleton {
          display: grid;
          grid-template-columns: 32px 1fr auto auto;
          align-items: center;
          gap: 12px;
          padding: 11px 12px;
          border-radius: var(--r-sm);
          background: var(--bg-2);
          border: 1px solid var(--border);
        }
        .skel {
          display: block;
          border-radius: var(--r-pill);
          background: linear-gradient(
            90deg,
            var(--bg-3) 0%,
            var(--border-hi) 50%,
            var(--bg-3) 100%
          );
          background-size: 400px 100%;
          animation: shimmer 1.4s ease-in-out infinite;
          height: 12px;
        }
        .skel-rank  { width: 20px; }
        .skel-owner { width: 80px; }
        .skel-streak{ width: 36px; }
        .skel-pts   { width: 48px; }

        /* Rows */
        .lb-row {
          display: grid;
          grid-template-columns: 36px 1fr auto auto;
          align-items: center;
          gap: 12px;
          padding: 10px 12px;
          border-radius: var(--r-sm);
          background: var(--bg-2);
          border: 1px solid var(--border);
          font-family: var(--font-mono);
          font-size: 13px;
          transition: border-color var(--t-mid), background var(--t-mid);
          animation: slide-up 280ms ease;
        }
        .lb-row:hover { border-color: var(--border-hi); }
        .lb-row.first {
          border-color: rgba(242,199,68,0.35);
          background: var(--line-muted);
          box-shadow: 0 0 16px rgba(242,199,68,0.06);
        }
        .lb-row.me {
          border-color: var(--line);
          background: var(--line-muted);
          box-shadow: inset 3px 0 0 var(--line);
        }
        .lb-rank {
          font-size: 16px;
          line-height: 1;
          color: var(--text-dim);
        }
        .lb-owner {
          color: var(--text);
          font-size: 12px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .lb-row.me .lb-owner {
          color: var(--line);
          font-weight: 700;
        }
        .lb-streak {
          color: var(--up);
          font-size: 12px;
          white-space: nowrap;
        }
        .lb-points {
          font-weight: 700;
          color: var(--line);
          white-space: nowrap;
          font-size: 13px;
        }
        .lb-show-more {
          width: 100%;
          padding: 8px;
          border-radius: var(--r-sm);
          border: 1px solid var(--border);
          background: var(--bg-2);
          color: var(--text-dim);
          font-size: 12px;
          font-family: var(--font-mono);
          cursor: pointer;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          transition: border-color var(--t-mid), color var(--t-mid);
        }
        .lb-show-more:hover {
          border-color: var(--border-hi);
          color: var(--text);
        }
      `}</style>
    </section>
  );
}