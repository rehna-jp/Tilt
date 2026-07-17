"use client";

interface CrowdMeterProps {
  higherPct: number;
  totalCalls: number;
}

/** Animated split bar showing % of players who called Higher vs Lower. */
export function CrowdMeter({ higherPct, totalCalls }: CrowdMeterProps) {
  const lowerPct = 100 - higherPct;

  return (
    <div className="crowd-meter">
      <div className="crowd-header">
        <span className="crowd-label">Crowd sentiment</span>
        <span className="crowd-count">
          {totalCalls} {totalCalls === 1 ? "player" : "players"}
        </span>
      </div>

      <div className="crowd-bar" role="img" aria-label={`${higherPct}% called higher, ${lowerPct}% called lower`}>
        <div
          className="bar-higher"
          style={{ width: `${higherPct}%` }}
        />
        <div
          className="bar-lower"
          style={{ width: `${lowerPct}%` }}
        />
      </div>

      <div className="crowd-pcts">
        <span className="pct-higher">▲ {higherPct}%</span>
        <span className="pct-lower">{lowerPct}% ▼</span>
      </div>

      <style jsx>{`
        .crowd-meter {
          width: 100%;
          font-family: var(--font-mono);
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .crowd-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .crowd-label {
          font-size: 11px;
          color: var(--text-dim);
          text-transform: uppercase;
          letter-spacing: 0.05em;
          font-family: var(--font-body);
        }
        .crowd-count {
          font-size: 11px;
          color: var(--text-faint);
          background: var(--bg-3);
          border: 1px solid var(--border);
          border-radius: var(--r-pill);
          padding: 2px 8px;
        }
        .crowd-bar {
          display: flex;
          width: 100%;
          height: 8px;
          border-radius: var(--r-pill);
          overflow: hidden;
          background: var(--border);
          gap: 1px;
        }
        .bar-higher {
          background: var(--up);
          min-width: 0;
          transition: width 600ms cubic-bezier(.4,0,.2,1);
          border-radius: var(--r-pill) 0 0 var(--r-pill);
          box-shadow: 0 0 8px var(--up-glow);
        }
        .bar-lower {
          background: var(--down);
          min-width: 0;
          transition: width 600ms cubic-bezier(.4,0,.2,1);
          border-radius: 0 var(--r-pill) var(--r-pill) 0;
          box-shadow: 0 0 8px var(--down-glow);
        }
        .crowd-pcts {
          display: flex;
          justify-content: space-between;
          font-size: 12px;
          font-weight: 700;
        }
        .pct-higher { color: var(--up); }
        .pct-lower  { color: var(--down); }
      `}</style>
    </div>
  );
}