# Tilt — Technical Documentation

**Track:** Consumer and Fan Experiences
**Built on:** TxLINE (TxODDS), Solana (devnet)
**Team/Builder:** [PreciousJeremy]
**Repository:** [[GITHUB REPO URL HERE](https://github.com/rehna-jp/Tilt)]
**Demo Video:** [DEMO VIDEO LINK HERE]
**Live Deployment / API Endpoint:** [DEPLOYED LINK OR API ENDPOINT HERE]

---

## 1. Core Idea

Tilt is a live, social prediction game built for World Cup matches. Every
round, players pick one live match stat — Goals, Yellow Cards, Red Cards,
or Corners — and call whether it will go **Higher** or **Lower** by the
time the round ends. Calls resolve against TxLINE's real-time score feed,
not a delayed or simulated one.

Three mechanics differentiate it from a plain Hi-Lo guessing game:

- **Multi-stat choice** — each player independently picks which stat to
  play each round, rather than everyone guessing the same fixed number.
  Some stats (corners) move often and are lower-risk; others (goals, red
  cards) are rare and higher-reward.
- **Streak multiplier** — consecutive correct calls multiply the points
  earned (1× → 1.5× at a streak of 2 → 2× at 5 → 3× at 10), giving
  players a reason to keep playing rather than cash out immediately.
- **Crowd consensus** — after each round resolves, players see what
  percentage of everyone else called Higher vs. Lower for that stat,
  turning a solitary guess into a shared, social moment.

Every round's outcome is written to a real on-chain leaderboard (Solana
devnet), so streaks and points are independently verifiable — not just a
number in a database we could quietly reset.

### Why this design

Our first prototype asked players to predict the direction of the live
**odds line** itself (will the moneyline drift up or down). Technically
interesting, but in testing it required financial-market literacy most
casual fans don't have and don't want to learn mid-match — the number on
screen meant nothing to someone who just wants to watch football. We
pivoted to goals/cards/corners specifically because it's instantly
legible: no explanation needed, and it uses TxLINE's live score feed more
directly than the odds feed does.

---

## 2. Architecture

```
TxLINE Scores SSE Stream (live match data)
        │
        ▼
scoreTickDecoder.ts   — decodes raw ticks into { goals, yellowCards,
                         redCards, corners } totals, verified against a
                         real captured tick from a live World Cup match
        │
        ▼
StatRoundEngine       — round lifecycle: opens a round, accepts each
                         player's (category, call) pair, resolves against
                         real stat movement, computes streaks/multipliers/
                         crowd consensus
        │
        ├──► statServer.ts (Node/TS)
        │      - SSE broadcast to the frontend (round_start, round_resolve,
        │        snapshot, match_info events)
        │      - HTTP endpoints: /state, /call, /leaderboard, /session-stats
        │      - Resilient reconnect (exponential backoff, cheap session
        │        reuse before falling back to full re-activation)
        │      - Fires on-chain score updates after each round resolves
        │
        └──► Next.js frontend
               - Wallet Adapter (Phantom/Solflare) for player identity
               - Live category picker, countdown, Higher/Lower calls
               - Streak badge, crowd consensus meter, resolved-round ticker
               - On-chain leaderboard view (all-time, combined across
                 game modes)

Solana devnet — Anchor program (tilt_leaderboard)
  - One PDA per player, seeded by wallet pubkey
  - update_score gated to a single trusted authority (the backend's
    wallet) — players cannot write their own scores
  - Tracks best_streak (monotonic), total_points, matches_played,
    rounds_won, with checked arithmetic throughout
  - 4 passing tests, including a negative test confirming unauthorized
    signers are rejected
```

### Why an on-chain leaderboard, not just a database

TxLINE's own data is cryptographically anchored on Solana — if the
underlying match data is verifiable, the game's outcomes should be too.
Writing every resolved round's result to a real Anchor program means a
player's streak isn't just "trust us," it's independently checkable
against a public devnet explorer.

---

## 3. TxLINE Endpoints Used

| Endpoint | Purpose |
|---|---|
| On-chain `subscribe` instruction (`tx-on-chain` Anchor program) | Free-tier World Cup data subscription, paid via TxL utility token |
| `POST /auth/guest/start` | Guest JWT issuance |
| `POST /api/token/activate` | Exchanges a signed on-chain subscription proof for an API token |
| `GET /api/scores/stream` | Live SSE score feed — goals, yellow/red cards, corners, per participant and combined |
| `GET /api/odds/stream` | Live SSE odds feed — used in our first prototype (see Section 1); not used by the shipped game, kept in the repo as a working reference implementation |
| `GET /api/fixtures/snapshot` | Fixture metadata (team names, kickoff time, competition) — used to show real match names instead of bare fixture IDs |

---

## 4. Feedback on the TxLINE API

**What worked well:** the free World Cup tier removed any cost barrier to
building against real tournament data, which mattered a lot for a
hackathon timeline. The SSE transport for both odds and scores is simple
and reliable — plain `fetch` + `ReadableStream`, no special client library
required. Once the on-chain subscribe/activate flow is understood, it's a
clean, repeatable pattern.

**Where we hit friction:**

- **On-chain subscribe/activate is a real setup cost.** It's a multi-step
  flow (on-chain transaction → guest JWT → signed message → API token)
  before a single byte of match data can be read. Worth it for the
  cryptographic guarantees, but it's a steeper first-integration curve
  than a typical API key.
- **The exact live score-tick JSON schema wasn't easy to find.** The
  hosted docs describe the on-chain stat *encoding* (which numeric key
  maps to which stat), but the actual wire format of a live SSE tick isn't
  shown anywhere obvious. We ended up capturing a real tick from a live
  match and cross-referencing it against TxODDS's own
  `documentation/scores/soccer-feed.mdx` (found in their GitHub repo, not
  surfaced by the hosted docs search) to confirm the stat-key mapping.
- **Two sources of truth occasionally disagreed.** The GitHub repo's
  top-level README listed a different token mint address than both the
  hosted quickstart docs and the actual live IDL constants (which matched
  the docs, not the README). Worth a quick internal audit so integrators
  don't have to cross-check three sources to find the current value.
- **`GameState` didn't always seem to reflect the real match phase** in
  what we observed (e.g., a tick mid-match with a non-zero clock and score
  still reported `"scheduled"`). We ended up relying on `Clock.Running`
  and the numeric stats themselves rather than `GameState` to determine if
  a match was actually live.

---

## 5. Repository Structure

```
Tilt/
├── ingestion/              # Backend: TxLINE integration + game server
│   ├── statServer.ts        # Main game server (goals/cards/corners)
│   ├── scoreTickDecoder.ts  # Verified score-tick decoder
│   ├── leaderboardClient.ts # On-chain leaderboard read/write
│   ├── game/
│   │   ├── statTypes.ts
│   │   └── statRoundEngine.ts
│   ├── capture_scores.ts   # Diagnostic: raw score stream capture
│   ├── lookup_fixtures.ts  # Diagnostic: fixture/team name lookup
│   └── anchor-program/     # On-chain leaderboard (Anchor/Rust)
│       └── programs/tilt-leaderboard/src/lib.rs
└── tilt-frontend/          # Next.js frontend
    ├── app/page.tsx
    ├── components/
    │   ├── CrowdMeter.tsx
    │   ├── StreakBadge.tsx
    │   └── Leaderboard.tsx
    └── lib/useStatGameSocket.ts
```

---

## 6. Known Limitations

- Round timing (default 90s) is a fixed, server-wide setting — not
  per-player configurable, by design (keeps the crowd consensus meter
  meaningful, since it depends on everyone seeing the same round window).
- The on-chain leaderboard's `total_points` is combined across any Tilt
  game mode sharing a player's wallet; the frontend separately shows
  "this session" points for the specific game just played, alongside the
  combined on-chain total.
- Wallet connection is required before playing (no anonymous/guest mode),
  since on-chain identity is what makes streaks verifiable rather than
  just numbers in memory.