"use client";

interface StreakBadgeProps {
  streak: number;
}

function multiplierForStreak(streak: number): number {
  if (streak >= 10) return 3;
  if (streak >= 5)  return 2;
  if (streak >= 2)  return 1.5;
  return 1;
}

/** Shows the player's current streak with its active point multiplier. */
export function StreakBadge({ streak }: StreakBadgeProps) {
  if (streak === 0) return null;

  const multiplier = multiplierForStreak(streak);
  const isHot      = streak >= 5;
  const isOnFire   = streak >= 10;

  return (
    <div className={`streak-badge${isHot ? " hot" : ""}${isOnFire ? " on-fire" : ""}`}>
      {isHot && <span className="streak-fire" aria-hidden="true">🔥</span>}
      <span className="streak-count">{streak}</span>
      <span className="streak-word">streak</span>
      <span className="streak-mult">×{multiplier}</span>

      <style jsx>{`
        .streak-badge {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 5px 12px;
          border-radius: var(--r-pill);
          background: var(--line-muted);
          border: 1px solid rgba(242, 199, 68, 0.3);
          font-family: var(--font-mono);
          animation: badge-pop 300ms cubic-bezier(.4,0,.2,1);
          white-space: nowrap;
        }
        .streak-badge.hot {
          border-color: var(--up);
          background: var(--up-muted);
          box-shadow: 0 0 16px var(--up-glow);
        }
        .streak-badge.on-fire {
          animation: badge-pop 300ms ease, glow-pulse 1.6s ease-in-out infinite;
        }
        .streak-fire {
          font-size: 14px;
          line-height: 1;
        }
        .streak-count {
          font-weight: 700;
          font-size: 15px;
          color: var(--line);
        }
        .streak-badge.hot .streak-count {
          color: var(--up);
        }
        .streak-word {
          font-size: 11px;
          color: var(--text-dim);
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .streak-mult {
          font-weight: 700;
          font-size: 12px;
          color: var(--line);
          background: var(--line-muted);
          border: 1px solid rgba(242,199,68,0.2);
          border-radius: var(--r-pill);
          padding: 1px 6px;
          margin-left: 2px;
        }
        .streak-badge.hot .streak-mult {
          color: var(--up);
          background: var(--up-muted);
          border-color: rgba(53,208,127,0.2);
        }
      `}</style>
    </div>
  );
}