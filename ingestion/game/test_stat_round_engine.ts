/**
 * Tilt — Stat Round Engine tests
 * Run with: npx ts-node game/test_stat_round_engine.ts
 *
 * Uses synthetic StatSnapshot objects — no dependency on the unverified
 * score-tick wire format, so these are fully trustworthy regardless of
 * whether scoreTickDecoder.ts has been corrected yet.
 */

import { StatRoundEngine, RoundResolvePayload } from "./statRoundEngine";
import { StatSnapshot } from "./statTypes";

let failures = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    console.log(`  ✅ ${label}`);
  } else {
    console.error(`  ❌ ${label}`);
    failures++;
  }
}

function snapshot(fixtureId: number, ts: number, goals: number, yellowCards: number, redCards: number, corners: number): StatSnapshot {
  return { fixtureId, ts, totals: { goals, yellowCards, redCards, corners } };
}

// ---- Test 1: multi-stat selection resolves each player against THEIR OWN category ----
console.log("Test 1: multi-stat choice");
{
  const engine = new StatRoundEngine({ fixtureId: 1, roundDurationMs: 999999, basePoints: 10 });
  let resolved: RoundResolvePayload | null = null;
  engine.onRoundResolve((p) => (resolved = p));

  engine.ingest(snapshot(1, 1, 0, 0, 0, 2)); // round 1 opens: goals=0, corners=2

  engine.submitCall("alice", "goals", "higher"); // betting goals go up
  engine.submitCall("bob", "corners", "higher"); // betting corners go up

  // goals stays at 0 (alice should LOSE), corners goes to 5 (bob should WIN)
  engine.ingest(snapshot(1, 2, 0, 0, 0, 5));

  // force resolution manually since we used a long duration
  (engine as any).resolveRound();

  const r = resolved as unknown as RoundResolvePayload;
  check("round resolved", r !== null);
  const aliceOutcome = r.playerOutcomes.find((o) => o.userId === "alice")!;
  const bobOutcome = r.playerOutcomes.find((o) => o.userId === "bob")!;
  check("alice (goals, higher) lost since goals stayed flat", aliceOutcome.won === false);
  check("bob (corners, higher) won since corners increased", bobOutcome.won === true);
  check("two categories were in play this round", r.categoryOutcomes.length === 2);

  engine.stop();
}

// ---- Test 2: streak multiplier increases points on consecutive wins ----
console.log("\nTest 2: streak multiplier");
{
  const engine = new StatRoundEngine({ fixtureId: 2, roundDurationMs: 999999, basePoints: 10 });
  const resolves: RoundResolvePayload[] = [];
  engine.onRoundResolve((p) => resolves.push(p));

  engine.ingest(snapshot(2, 1, 0, 0, 0, 0));

  // Round 1: alice calls corners higher, corners go up -> win, streak 1, multiplier 1x -> 10 pts
  engine.submitCall("alice", "corners", "higher");
  engine.ingest(snapshot(2, 2, 0, 0, 0, 1));
  (engine as any).resolveRound();

  // Round 2: same bet, corners go up again -> win, streak 2, multiplier 1.5x -> 15 pts
  engine.submitCall("alice", "corners", "higher");
  engine.ingest(snapshot(2, 3, 0, 0, 0, 2));
  (engine as any).resolveRound();

  const round1Alice = resolves[0].playerOutcomes.find((o) => o.userId === "alice")!;
  const round2Alice = resolves[1].playerOutcomes.find((o) => o.userId === "alice")!;

  check("round 1: streak becomes 1", round1Alice.streakAfter === 1);
  check("round 1: multiplier is 1x on first win", round1Alice.multiplier === 1);
  check("round 1: earns base points (10)", round1Alice.pointsEarned === 10);

  check("round 2: streak becomes 2", round2Alice.streakAfter === 2);
  check("round 2: multiplier bumps to 1.5x at streak 2", round2Alice.multiplier === 1.5);
  check("round 2: earns boosted points (15)", round2Alice.pointsEarned === 15);

  check("cumulative points tracked correctly", engine.getPlayerPoints("alice") === 25);

  engine.stop();
}

// ---- Test 3: a loss resets streak to 0 ----
console.log("\nTest 3: loss resets streak");
{
  const engine = new StatRoundEngine({ fixtureId: 3, roundDurationMs: 999999, basePoints: 10 });
  engine.ingest(snapshot(3, 1, 0, 0, 0, 0));

  engine.submitCall("carol", "goals", "higher");
  engine.ingest(snapshot(3, 2, 1, 0, 0, 0)); // goals went up -> win
  (engine as any).resolveRound();
  check("streak is 1 after a win", engine.getPlayerStreak("carol") === 1);

  engine.submitCall("carol", "goals", "lower");
  engine.ingest(snapshot(3, 3, 2, 0, 0, 0)); // goals went UP again, but carol called lower -> loss
  (engine as any).resolveRound();
  check("streak resets to 0 after a loss", engine.getPlayerStreak("carol") === 0);

  engine.stop();
}

// ---- Test 4: crowd consensus percentage is computed correctly ----
console.log("\nTest 4: crowd consensus");
{
  const engine = new StatRoundEngine({ fixtureId: 4, roundDurationMs: 999999 });
  let resolved: RoundResolvePayload | null = null;
  engine.onRoundResolve((p) => (resolved = p));

  engine.ingest(snapshot(4, 1, 0, 0, 0, 0));
  engine.submitCall("p1", "corners", "higher");
  engine.submitCall("p2", "corners", "higher");
  engine.submitCall("p3", "corners", "higher");
  engine.submitCall("p4", "corners", "lower");
  engine.ingest(snapshot(4, 2, 0, 0, 0, 3));
  (engine as any).resolveRound();

  const r = resolved as unknown as RoundResolvePayload;
  const cornersOutcome = r.categoryOutcomes.find((o) => o.category === "corners")!;
  check("4 players called corners this round", cornersOutcome.callsForCategory === 4);
  check("75% called higher (3 of 4)", cornersOutcome.higherPct === 75);

  engine.stop();
}

// ---- Test 5: a flat result (no change) counts as a loss for everyone ----
console.log("\nTest 5: flat result");
{
  const engine = new StatRoundEngine({ fixtureId: 5, roundDurationMs: 999999 });
  let resolved: RoundResolvePayload | null = null;
  engine.onRoundResolve((p) => (resolved = p));

  engine.ingest(snapshot(5, 1, 0, 0, 0, 4));
  engine.submitCall("dave", "corners", "higher");
  engine.ingest(snapshot(5, 2, 0, 0, 0, 4)); // unchanged
  (engine as any).resolveRound();

  const r = resolved as unknown as RoundResolvePayload;
  const daveOutcome = r.playerOutcomes.find((o) => o.userId === "dave")!;
  check("flat result is not a win", daveOutcome.won === false);
  check("category outcome marked as flat", r.categoryOutcomes[0].result === "flat");

  engine.stop();
}

console.log(`\n${failures === 0 ? "✅ All checks passed" : `❌ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);