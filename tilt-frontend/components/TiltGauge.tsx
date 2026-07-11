"use client";

interface TiltGaugeProps {
  /** Line value when the current round started */
  startLine: number | null;
  /** Most recent live line value */
  currentLine: number | null;
}

/**
 * A needle gauge that physically tilts toward whichever direction the odds
 * line has moved since the round started. This is Tilt's signature visual —
 * everything else on the page stays quiet so this reads clearly.
 */
export function TiltGauge({ startLine, currentLine }: TiltGaugeProps) {
  const delta = startLine !== null && currentLine !== null ? currentLine - startLine : 0;

  // Clamp the visual tilt so a huge odds swing doesn't peg the needle
  // uselessly at the extreme — scale relative to the start line's own size.
  const relativeMove = startLine ? delta / startLine : 0;
  const clamped = Math.max(-1, Math.min(1, relativeMove * 12));
  const angleDeg = clamped * 40; // -40..+40 degrees from vertical

  const needleColor = delta > 0.0005 ? "var(--up)" : delta < -0.0005 ? "var(--down)" : "var(--text-dim)";

  return (
    <div className="gauge-wrap" role="img" aria-label={`Line tilt: ${delta > 0 ? "up" : delta < 0 ? "down" : "flat"}`}>
      <svg viewBox="0 0 220 140" width="220" height="140">
        <path
          d="M 20 120 A 90 90 0 0 1 200 120"
          fill="none"
          stroke="var(--border)"
          strokeWidth="10"
          strokeLinecap="round"
        />
        <g style={{ transition: "transform 400ms cubic-bezier(0.34, 1.56, 0.64, 1)" }} transform={`rotate(${angleDeg} 110 120)`}>
          <line x1="110" y1="120" x2="110" y2="35" stroke={needleColor} strokeWidth="4" strokeLinecap="round" />
          <circle cx="110" cy="120" r="8" fill={needleColor} />
        </g>
      </svg>
      <style jsx>{`
        .gauge-wrap {
          display: flex;
          justify-content: center;
        }
      `}</style>
    </div>
  );
}