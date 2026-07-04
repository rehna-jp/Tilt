/**
 * Tilt — Round Engine test harness
 *
 * Replays the exact tick data captured from the live devnet run (fixture
 * 18179549, 1X2_PARTICIPANT_RESULT, part1) through RoundEngine to confirm
 * round start/resolve behaves correctly against real field values —
 * no network required.
 *
 * Run with: npx ts-node game/test_round_engine.ts
 */

import { RoundEngine, OddsTick } from "./roundEngine";

// Real ticks captured live (trimmed to the ones relevant to fixture
// 18179549 / 1X2_PARTICIPANT_RESULT), plus a heartbeat and an off-fixture
// tick mixed in to prove filtering works.
const capturedTicks: OddsTick[] = [
  {
    FixtureId: 18179549,
    Ts: 1783134967162,
    SuperOddsType: "1X2_PARTICIPANT_RESULT",
    InRunning: true,
    PriceNames: ["part1", "draw", "part2"],
    Prices: [1115, 10700, 100000],
  },
  {
    FixtureId: 18179549,
    Ts: 1783134968361,
    SuperOddsType: "1X2_PARTICIPANT_RESULT",
    InRunning: true,
    PriceNames: ["part1", "draw", "part2"],
    Prices: [1118, 10500, 97000],
  },
  // heartbeat — must be ignored
  { Ts: 1783134981 } as OddsTick,
  // different fixture — must be ignored by this engine instance
  {
    FixtureId: 18185036,
    Ts: 1783134986560,
    SuperOddsType: "1X2_PARTICIPANT_RESULT",
    InRunning: false,
    PriceNames: ["part1", "draw", "part2"],
    Prices: [5541, 2213, 2719],
  },
  {
    FixtureId: 18179549,
    Ts: 1783134990064,
    SuperOddsType: "1X2_PARTICIPANT_RESULT",
    InRunning: true,
    PriceNames: ["part1", "draw", "part2"],
    Prices: [1116, 10600, 100000],
  },
];

const engine = new RoundEngine({
  fixtureId: 18179549,
  superOddsType: "1X2_PARTICIPANT_RESULT",
  priceName: "part1",
  roundDurationMs: 999999, // long enough that we resolve manually in this test
});

let roundStarts = 0;
engine.onRoundStart(({ roundId, startLine }) => {
  roundStarts++;
  console.log(`[round ${roundId}] STARTED at line ${startLine}`);
});

engine.onTick(({ line, ts }) => {
  console.log(`[tick] line=${line} ts=${ts}`);
});

console.log("--- feeding captured ticks ---");
let accepted = 0;
for (const tick of capturedTicks) {
  const wasUsed = engine.ingest(tick);
  if (wasUsed) accepted++;
}

console.log(`\n--- results ---`);
console.log(`Ticks fed: ${capturedTicks.length}`);
console.log(`Ticks accepted (matched fixture+market+outcome): ${accepted}`);
console.log(`Rounds started: ${roundStarts}`);
console.log(`Current tracked line: ${engine.getCurrentLine()}`);
console.log(`Open round: ${JSON.stringify(engine.getOpenRound())}`);

// Sanity assertions
const expectedAccepted = 3; // the 3 ticks matching fixture 18179549 + 1X2_PARTICIPANT_RESULT
if (accepted !== expectedAccepted) {
  console.error(`❌ FAIL: expected ${expectedAccepted} accepted ticks, got ${accepted}`);
  process.exit(1);
}
if (roundStarts !== 1) {
  console.error(`❌ FAIL: expected exactly 1 round to start (on first valid tick), got ${roundStarts}`);
  process.exit(1);
}
// Last accepted tick was part1 price 1116 -> decimal 1.116
if (engine.getCurrentLine() !== 1.116) {
  console.error(`❌ FAIL: expected current line 1.116, got ${engine.getCurrentLine()}`);
  process.exit(1);
}

console.log("\n✅ All checks passed — engine correctly filters, decodes, and tracks the line.");

engine.stop();