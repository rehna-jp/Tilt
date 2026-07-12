/**
 * Tilt — Score decoder test
 * Verifies decodeScoreTick() against a REAL tick captured live during
 * Norway vs England, 2026-07-11 (fixture 18213979).
 * Run with: npx ts-node test_score_decoder.ts
 */

import { decodeScoreTick, RawScoreTick } from "./scoreTickDecoder";

let failures = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    console.log(`  ✅ ${label}`);
  } else {
    console.error(`  ❌ ${label}`);
    failures++;
  }
}

// Real tick #1 from capture_scores.ts, Norway vs England, 2026-07-11.
const realTick: RawScoreTick = {
  FixtureId: 18213979,
  GameState: "scheduled",
  StartTime: 1783803600000,
  IsTeam: true,
  FixtureGroupId: 10115675,
  CompetitionId: 72,
  CountryId: 466,
  SportId: 1,
  Participant1IsHome: true,
  Participant2Id: 1888,
  Participant1Id: 2661,
  Action: "attack_possession",
  Id: 463,
  Ts: 1783807962619,
  Seq: 501,
  StatusId: 4,
  Type: "Soccer",
  Clock: { Running: true, Seconds: 3012 },
  Stats: {
    "1": 1, "2": 1, "3": 0, "4": 0, "5": 0, "6": 0, "7": 0, "8": 2,
    "1001": 1, "1002": 1, "1003": 0, "1004": 0, "1005": 0, "1006": 0, "1007": 0, "1008": 2,
    "2001": 1, "2002": 1, "2003": 0, "2004": 0, "2005": 0, "2006": 0, "2007": 0, "2008": 2,
  },
  Participant: 2,
  Possession: 2,
};

console.log("Test: decode a real captured tick");
{
  const snapshot = decodeScoreTick(realTick);
  check("snapshot is not null", snapshot !== null);
  if (snapshot) {
    check("fixtureId matches", snapshot.fixtureId === 18213979);
    check("ts matches", snapshot.ts === 1783807962619);
    // key "1"=1 (P1 goals) + key "2"=1 (P2 goals) = 2 combined goals
    check("goals = 2 (1 + 1)", snapshot.totals.goals === 2);
    check("yellowCards = 0 (0 + 0)", snapshot.totals.yellowCards === 0);
    check("redCards = 0 (0 + 0)", snapshot.totals.redCards === 0);
    // key "7"=0 (P1 corners) + key "8"=2 (P2 corners) = 2 combined corners
    check("corners = 2 (0 + 2)", snapshot.totals.corners === 2);
  }
}

console.log("\nTest: heartbeat returns null");
{
  const heartbeat: RawScoreTick = { Ts: 1783740134 };
  const snapshot = decodeScoreTick(heartbeat);
  check("heartbeat (no FixtureId/Stats) decodes to null", snapshot === null);
}

console.log("\nTest: tick with FixtureId but no Stats returns null");
{
  const noStats: RawScoreTick = { FixtureId: 123, Ts: 456 };
  const snapshot = decodeScoreTick(noStats);
  check("tick without Stats object decodes to null", snapshot === null);
}

console.log(`\n${failures === 0 ? "✅ All checks passed — decoder verified against real data" : `❌ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);