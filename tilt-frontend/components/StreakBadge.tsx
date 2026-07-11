"use client";

interface StreakBadgeProps {
  streak: number;
}

function multiplierForStreak(streak: number): number {
  if (streak >= 10) return 3;
  if (streak >= 5) return 2;
  if (streak >= 2) return 1.5;
  return 1;
}

/** Shows the player's current streak with its active point multiplier. */
export function StreakBadge({ streak }: StreakBadgeProps) {
  const multiplier = multiplierForStreak(streak);
  const isHot = streak >= 5;

  if (streak === 0) {
    return (
      <div className="streak-badge idle">
        <span className="streak-label">No streak yet</span>
        <style jsx>{`
          .streak-badge {
            display: inline-flex;
            align-items: center;
            padding: 6px 12px;
            border-radius: 999px;
            background: var(--bg-elevated-2);
            border: 1px solid var(--border);
          }
          .streak-label {
            font-family: var(--font-mono);
            font-size: 12px;
            color: var(--text-dim);
          }
        `}</style>
      </div>
    );
  }

  return (
    <div className={`streak-badge ${isHot ? "hot" : ""}`}>
      <span className="streak-fire">{isHot ? "🔥" : ""}</span>
      <span className="streak-count">{streak}</span>
      <span className="streak-word">streak</span>
      <span className="streak-mult">×{multiplier}</span>

      <style jsx>{`
        .streak-badge {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 6px 14px;
          border-radius: 999px;
          background: var(--bg-elevated-2);
          border: 1px solid var(--line);
          font-family: var(--font-mono);
        }
        .streak-badge.hot {
          border-color: var(--up);
          box-shadow: 0 0 12px rgba(53, 208, 127, 0.25);
        }
        .streak-fire {
          font-size: 14px;
        }
        .streak-count {
          font-weight: 700;
          font-size: 15px;
          color: var(--line);
        }
        .streak-word {
          font-size: 12px;
          color: var(--text-dim);
        }
        .streak-mult {
          font-weight: 700;
          font-size: 13px;
          color: var(--up);
          margin-left: 2px;
        }
      `}</style>
    </div>
  );
}