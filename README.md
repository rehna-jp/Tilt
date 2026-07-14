# Tilt

A live, social prediction game for World Cup matches. Pick a stat — Goals,
Yellow Cards, Red Cards, or Corners — call whether it goes **Higher** or
**Lower**, and watch it resolve against real live match data from TxLINE.
Streaks and points are written to a real on-chain leaderboard on Solana.

Built for the [Superteam × TxODDS World Cup Hackathon](https://superteam.fun/earn) — Consumer and Fan Experiences track.

**[Full technical documentation →](docs/TECHNICAL_DOCUMENTATION.md)**

---

## What makes it different

- **Multi-stat choice** — every player picks their own stat to play each
  round, not one fixed number for everyone.
- **Streak multiplier** — consecutive wins multiply your points (up to 3×).
- **Crowd consensus** — see what % of players called each direction, right
  after every round resolves.
- **Real on-chain leaderboard** — every round's outcome is written to a
  deployed Solana program, not just a database row.

## Architecture

```
TxLINE live scores (SSE)
   → score tick decoder
   → round engine (multi-stat, streaks, consensus)
   → game server (SSE broadcast + REST endpoints)
   → Next.js frontend (wallet-based identity, live UI)

Solana devnet
   → Anchor program: per-player on-chain score PDA,
     writable only by the trusted backend authority
```

See [docs/TECHNICAL_DOCUMENTATION.md](docs/TECHNICAL_DOCUMENTATION.md) for
the full breakdown, TxLINE endpoints used, and API feedback.

## Running it locally

You'll need two things running at once: the backend game server, and the
frontend.

### 1. Backend (`ingestion/`)

```bash
cd ingestion
npm install
```

You'll need:
- A Solana devnet keypair (`wallet.json`) with a small amount of devnet SOL
- The deployed leaderboard program's IDL, copied to `ingestion/idl/tilt_leaderboard.json`
  (see `anchor-program/` to build and deploy it yourself)

Find a live fixture ID (or use a recent one):

```bash
ANCHOR_PROVIDER_URL="https://api.devnet.solana.com" \
ANCHOR_WALLET="./wallet.json" \
npx ts-node lookup_fixtures.ts
```

Run the game server:

```bash
ANCHOR_PROVIDER_URL="https://api.devnet.solana.com" \
ANCHOR_WALLET="./wallet.json" \
FIXTURE_ID=<fixture id> \
npx ts-node statServer.ts
```

### 2. Frontend (`tilt-frontend/`)

```bash
cd tilt-frontend
npm install
```

Create `.env.local`:

```
NEXT_PUBLIC_STAT_SERVER_URL=http://localhost:8788
NEXT_PUBLIC_SOLANA_RPC=https://api.devnet.solana.com
NEXT_PUBLIC_ROUND_DURATION_MS=90000
```

Run it:

```bash
npm run dev
```

Open **http://localhost:3000**, connect a Solana wallet (Phantom or
Solflare, devnet), and play.

### 3. On-chain program (`ingestion/anchor-program/`)

Already built, tested, and deployed to devnet
(`75RwuxJxo78e2mXswbhYW197ykfZjHV7mJQnJZCkDBbk`). To build/test it
yourself, see `anchor-program/SETUP.md` and `anchor-program/TESTS.md`.

## Project structure

```
Tilt/
├── README.md
├── docs/
│   └── TECHNICAL_DOCUMENTATION.md
├── ingestion/              # Backend: TxLINE integration + game logic
│   ├── statServer.ts
│   ├── scoreTickDecoder.ts
│   ├── leaderboardClient.ts
│   ├── game/
│   └── anchor-program/     # On-chain leaderboard (Anchor/Rust)
└── tilt-frontend/          # Next.js frontend
    ├── app/
    ├── components/
    └── lib/
```