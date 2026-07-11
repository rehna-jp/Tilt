"use client";

interface CrowdMeterProps {
  higherPct: number;
  totalCalls: number;
}

/** A horizontal split bar showing what % of players called Higher vs Lower. */
export function CrowdMeter({ higherPct, totalCalls }: CrowdMeterProps) {
  const lowerPct = 100 - higherPct;

  return (
    <div className="crowd-meter">
      <div className="crowd-meter-label">
        {totalCalls} {totalCalls === 1 ? "player" : "players"} called this round
      </div>
      <div className="crowd-meter-bar">
        <div className="crowd-meter-higher" style={{ width: `${higherPct}%` }} />
        <div className="crowd-meter-lower" style={{ width: `${lowerPct}%` }} />
      </div>
      <div className="crowd-meter-pcts">
        <span className="pct-higher">▲ {higherPct}%</span>
        <span className="pct-lower">{lowerPct}% ▼</span>
      </div>

      <style jsx>{`
        .crowd-meter {
          width: 100%;
          font-family: var(--font-mono);
        }
        .crowd-meter-label {
          font-size: 11px;
          color: var(--text-dim);
          margin-bottom: 6px;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .crowd-meter-bar {
          display: flex;
          width: 100%;
          height: 10px;
          border-radius: 6px;
          overflow: hidden;
          background: var(--border);
        }
        .crowd-meter-higher {
          background: var(--up);
          transition: width 300ms ease;
        }
        .crowd-meter-lower {
          background: var(--down);
          transition: width 300ms ease;
        }
        .crowd-meter-pcts {
          display: flex;
          justify-content: space-between;
          font-size: 12px;
          margin-top: 4px;
        }
        .pct-higher {
          color: var(--up);
        }
        .pct-lower {
          color: var(--down);
        }
      `}</style>
    </div>
  );
}