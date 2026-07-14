"use client";

import { useEffect, useState } from "react";

interface LeaderboardEntry {
  owner: string;
  bestStreak: number;
  totalPoints: number;
  matchesPlayed: number;
  roundsWon: number;
}

const STAT_SERVER_URL = process.env.NEXT_PUBLIC_STAT_SERVER_URL || "http://localhost:8788";

function shortenPubkey(pubkey: string): string {
  if (pubkey.length <= 10) return pubkey;
  return `${pubkey.slice(0, 4)}..${pubkey.slice(-4)}`;
}

interface LeaderboardProps {
  myUserId: string | null;
  /** Bumped by the parent whenever a round resolves, to trigger a refetch. */
  refreshKey: number;
}

export function Leaderboard({ myUserId, refreshKey }: LeaderboardProps) {
  const [entries, setEntries] = useState<LeaderboardEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

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

    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  return (
    <section className="leaderboard">
      <h2>On-chain Leaderboard</h2>
      <p className="lb-subtitle">All-time total, combined across every Tilt game mode</p>

      {error && <div className="lb-hint">{error}</div>}
      {!error && entries === null && <div className="lb-hint">Loading…</div>}
      {!error && entries && entries.length === 0 && (
        <div className="lb-hint">No players on the leaderboard yet — be the first to win a round.</div>
      )}

      {entries && entries.length > 0 && (
        <div className="lb-list">
          {entries.map((e, i) => (
            <div key={e.owner} className={`lb-row ${e.owner === myUserId ? "me" : ""}`}>
              <span className="lb-rank">#{i + 1}</span>
              <span className="lb-owner">{shortenPubkey(e.owner)}</span>
              <span className="lb-streak">🔥{e.bestStreak}</span>
              <span className="lb-points">{e.totalPoints} pts</span>
            </div>
          ))}
        </div>
      )}

      <style jsx>{`
        .leaderboard {
          margin-top: 8px;
        }
        .leaderboard h2 {
          font-family: var(--font-display);
          font-size: 20px;
          font-weight: 700;
          margin: 0 0 4px;
          color: var(--text-dim);
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .lb-subtitle {
          font-size: 12px;
          color: var(--text-dim);
          margin: 0 0 12px;
        }
        .lb-hint {
          font-size: 13px;
          color: var(--text-dim);
        }
        .lb-list {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .lb-row {
          display: grid;
          grid-template-columns: 32px 1fr auto auto;
          align-items: center;
          gap: 12px;
          padding: 10px 12px;
          border-radius: 8px;
          background: var(--bg-elevated);
          border: 1px solid var(--border);
          font-family: var(--font-mono);
          font-size: 13px;
        }
        .lb-row.me {
          border-color: var(--line);
          background: rgba(242, 199, 68, 0.06);
        }
        .lb-rank {
          color: var(--text-dim);
        }
        .lb-owner {
          color: var(--text);
        }
        .lb-streak {
          color: var(--up);
          font-size: 12px;
        }
        .lb-points {
          font-weight: 700;
          color: var(--line);
        }
      `}</style>
    </section>
  );
}