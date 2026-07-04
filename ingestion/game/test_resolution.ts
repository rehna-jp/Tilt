/**
 * Tilt — Round Engine resolution test
 * Verifies that a round resolves correctly and scores calls as winners/losers.
 * Run with: npx ts-node game/test_resolution.ts
 */

import { RoundEngine, OddsTick } from "./roundEngine";

const engine = new RoundEngine({
  fixtureId: 18179549,
  superOddsType: "1X2_PARTICIPANT_RESULT",
  priceName: "part1",
  roundDurationMs: 50, // short so we can watch it resolve in a test
});

let resolvedResult: any = null;
engine.onRoundResolve((result) => {
  resolvedResult = result;
  console.log("[resolved]", JSON.stringify(result));
});

// First tick opens round 1 at line 1.115
engine.ingest({
  FixtureId: 18179549,
  Ts: 1,
  SuperOddsType: "1X2_PARTICIPANT_RESULT",
  PriceNames: ["part1", "draw", "part2"],
  Prices: [1115, 10700, 100000],
} as OddsTick);

// Two players call before resolution
engine.submitCall("alice", "up");
engine.submitCall("bob", "down");

// Line moves up before the round timer fires
setTimeout(() => {
  engine.ingest({
    FixtureId: 18179549,
    Ts: 2,
    SuperOddsType: "1X2_PARTICIPANT_RESULT",
    PriceNames: ["part1", "draw", "part2"],
    Prices: [1200, 10500, 97000], // 1.115 -> 1.200, a real "up" move
  } as OddsTick);
}, 10);

setTimeout(() => {
  if (!resolvedResult) {
    console.error("❌ FAIL: round never resolved");
    process.exit(1);
  }
  if (resolvedResult.direction !== "up") {
    console.error(`❌ FAIL: expected direction "up", got "${resolvedResult.direction}"`);
    process.exit(1);
  }
  if (!resolvedResult.winners.includes("alice")) {
    console.error("❌ FAIL: alice called up and should have won");
    process.exit(1);
  }
  if (!resolvedResult.losers.includes("bob")) {
    console.error("❌ FAIL: bob called down and should have lost");
    process.exit(1);
  }
  console.log("\n✅ All checks passed — resolution correctly scores winners and losers.");
  engine.stop();
  process.exit(0);
}, 100);