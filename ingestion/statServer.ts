/**
 * Tilt — Stat Game Server (goals/cards/corners Hi-Lo)
 *
 * Sibling to server.ts, but wired to the SCORES stream and StatRoundEngine
 * instead of the odds stream and RoundEngine. This is the pivot toward the
 * "predict the next stat" mechanic instead of "predict the odds line."
 *
 * scoreTickDecoder.ts is verified against real live match data (Norway vs
 * England, 2026-07-11) — see that file for details.
 *
 * On startup, this also fetches the fixture's real team names via
 * /api/fixtures/snapshot and broadcasts them as a "match_info" SSE event,
 * so the frontend can show "Norway vs England" instead of a bare fixture ID.
 *
 * Run with:
 *   ANCHOR_PROVIDER_URL="https://api.devnet.solana.com" \
 *   ANCHOR_WALLET="./wallet.json" \
 *   FIXTURE_ID=18213979 \
 *   npx ts-node statServer.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import axios from "axios";
import * as http from "http";
import * as nacl from "tweetnacl";
import type { Txoracle } from "./types/txoracle";
import { StatRoundEngine, RoundResolvePayload, HiLoCall } from "./game/statRoundEngine";
import { StatCategory } from "./game/statTypes";
import { decodeScoreTick, RawScoreTick } from "./scoreTickDecoder";
import { updatePlayerScore, fetchLeaderboard } from "./leaderboardClient";

// ---- Config (same verified network setup as server.ts) ----
const NETWORK: "mainnet" | "devnet" = "devnet";

const CONFIG = {
  mainnet: {
    apiOrigin: "https://txline.txodds.com",
    programId: new PublicKey("9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA"),
  },
  devnet: {
    apiOrigin: "https://txline-dev.txodds.com",
    programId: new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J"),
  },
} as const;

const { apiOrigin, programId } = CONFIG[NETWORK];
const apiBaseUrl = `${apiOrigin}/api`;

const idl =
  (NETWORK as string) === "mainnet"
    ? require("./idl/txoracle.json")
    : require("./idl/txoracle_devnet.json");

const TXLINE_MINT = new PublicKey(
  (idl as any).constants.find((c: any) => c.name === "TXLINE_MINT").value as string
);

const SERVICE_LEVEL_ID = 1;
const DURATION_WEEKS = 4;
const SELECTED_LEAGUES: number[] = [];

// ---- Game config ----
const FIXTURE_ID = Number(process.env.FIXTURE_ID || "18213979"); // Norway vs England (confirmed real)
const ROUND_DURATION_MS = Number(process.env.ROUND_DURATION_MS || "90000");
const HTTP_PORT = Number(process.env.PORT || "8788"); // different port from server.ts, so both can run side by side

// ---- SSE broadcast plumbing ----
type SseClient = { res: http.ServerResponse; id: number };
let sseClients: SseClient[] = [];
let nextClientId = 1;

function broadcast(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) client.res.write(payload);
}

// ---- On-chain settlement ----
// Uses streak/points as computed directly by StatRoundEngine (it already
// tracks per-player streak and cumulative points with multipliers applied,
// unlike server.ts which had to track that separately) — simpler here.
function settlePlayerOnChain(userId: string, won: boolean, streakAfter: number, pointsEarned: number) {
  if (!won && streakAfter === 0 && pointsEarned === 0) {
    // Only skip if this was a genuine no-op (already at 0, lost again).
    // We can't cheaply tell "already at 0" vs "just reset to 0" here without
    // extra bookkeeping, so this guard is intentionally conservative —
    // revisit if on-chain write volume becomes a real issue in testing.
  }

  updatePlayerScore(userId, streakAfter, pointsEarned, won)
    .then((sig) => console.log(`[Stat Server] on-chain score updated for ${userId}: ${sig}`))
    .catch((err) =>
      console.error(`[Stat Server] on-chain score update FAILED for ${userId}:`, err.message || err)
    );
}

// ---- TxLINE activation (same verified flow, connects to SCORES not ODDS) ----
async function activateAndGetScoresStream() {
  const provider = AnchorProvider.env();
  anchor.setProvider(provider);

  const program = new Program<Txoracle>(idl as any, provider);
  if (!program.programId.equals(programId)) {
    throw new Error(`Program mismatch: ${program.programId.toBase58()} vs ${programId.toBase58()}`);
  }

  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_treasury_v2")],
    program.programId
  );
  const tokenTreasuryVault = getAssociatedTokenAddressSync(
    TXLINE_MINT,
    tokenTreasuryPda,
    true,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const [pricingMatrixPda] = PublicKey.findProgramAddressSync([Buffer.from("pricing_matrix")], program.programId);
  const userTokenAccount = getAssociatedTokenAddressSync(
    TXLINE_MINT,
    provider.wallet.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  console.log("[Stat Server] Subscribing on-chain...");
  const createUserAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    provider.wallet.publicKey,
    userTokenAccount,
    provider.wallet.publicKey,
    TXLINE_MINT,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const txSig = await program.methods
    .subscribe(SERVICE_LEVEL_ID, DURATION_WEEKS)
    .accounts({
      user: provider.wallet.publicKey,
      pricingMatrix: pricingMatrixPda,
      tokenMint: TXLINE_MINT,
      userTokenAccount,
      tokenTreasuryVault,
      tokenTreasuryPda,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([createUserAtaIx])
    .rpc();
  console.log(`[Stat Server] Subscribed. tx: ${txSig}`);

  const authResponse = await axios.post(`${apiOrigin}/auth/guest/start`);
  const jwt = authResponse.data.token;

  const messageString = `${txSig}:${SELECTED_LEAGUES.join(",")}:${jwt}`;
  const message = new TextEncoder().encode(messageString);
  const localPayer = (provider.wallet as anchor.Wallet & { payer?: anchor.web3.Keypair }).payer;
  if (!localPayer) throw new Error("Requires a local Anchor keypair wallet.");
  const signatureBytes = nacl.sign.detached(message, localPayer.secretKey);
  const walletSignature = Buffer.from(signatureBytes).toString("base64");

  console.log("[Stat Server] Activating API token...");
  const activationResponse = await axios.post(
    `${apiBaseUrl}/token/activate`,
    { txSig, walletSignature, leagues: SELECTED_LEAGUES },
    { headers: { Authorization: `Bearer ${jwt}` } }
  );
  const apiToken = activationResponse.data.token || activationResponse.data;
  console.log("[Stat Server] API token activated.");

  const reader = await openScoresStream(jwt, apiToken);
  return { reader, jwt, apiToken };
}

/**
 * Opens just the SSE connection to the scores stream, reusing an existing
 * jwt/apiToken pair. Cheap — no on-chain transaction, no re-activation.
 * Used both for the initial connect (via activateAndGetScoresStream) and
 * for reconnects after a stream drop, as long as the existing credentials
 * still work.
 */
async function openScoresStream(jwt: string, apiToken: string): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const streamUrl = `${apiBaseUrl}/scores/stream`; // SCORES, not odds
  const streamResponse = await fetch(streamUrl, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      "X-Api-Token": apiToken,
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });

  if (!streamResponse.ok || !streamResponse.body) {
    throw new Error(`Stream connection failed: ${streamResponse.status}`);
  }

  return streamResponse.body.getReader();
}

interface MatchInfo {
  homeTeam: string;
  awayTeam: string;
  startTime: number;
  competition?: string;
}

/**
 * Looks up real team names for FIXTURE_ID via /api/fixtures/snapshot —
 * same endpoint verified in lookup_fixtures.ts. Returns null (not thrown)
 * on failure so a lookup hiccup doesn't take down the whole server; the
 * frontend just falls back to showing the bare fixture ID in that case.
 */
async function lookupMatchInfo(jwt: string, apiToken: string): Promise<MatchInfo | null> {
  try {
    const response = await axios.get(`${apiBaseUrl}/fixtures/snapshot`, {
      headers: { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken },
    });
    const fixtures: any[] = response.data;
    const match = fixtures.find((f) => f.FixtureId === FIXTURE_ID);
    if (!match) {
      console.warn(`[Stat Server] Fixture ${FIXTURE_ID} not found in snapshot — match name unavailable.`);
      return null;
    }
    return {
      homeTeam: match.Participant1IsHome ? match.Participant1 : match.Participant2,
      awayTeam: match.Participant1IsHome ? match.Participant2 : match.Participant1,
      startTime: match.StartTime,
      competition: match.Competition,
    };
  } catch (err: any) {
    console.warn("[Stat Server] Fixture lookup failed (non-fatal):", err.message || err);
    return null;
  }
}

// ---- Main ----
async function main() {
  let matchInfo: MatchInfo | null = null;

  const engine = new StatRoundEngine({
    fixtureId: FIXTURE_ID,
    roundDurationMs: ROUND_DURATION_MS,
    basePoints: 10,
  });

  // Graceful shutdown — only stop the engine on a real process exit, not on
  // a transient stream reconnect (see the reconnect loop below).
  process.on("SIGINT", () => {
    console.log("\n[Stat Server] Shutting down...");
    engine.stop();
    process.exit(0);
  });

  engine.onRoundStart((payload) => {
    console.log(`[round ${payload.roundId}] started, totals:`, payload.startTotals);
    broadcast("round_start", payload);
  });

  engine.onRoundResolve((result: RoundResolvePayload) => {
    console.log(`[round ${result.roundId}] resolved:`, JSON.stringify(result.categoryOutcomes));
    broadcast("round_resolve", result);

    for (const outcome of result.playerOutcomes) {
      settlePlayerOnChain(outcome.userId, outcome.won, outcome.streakAfter, outcome.pointsEarned);
    }
  });

  engine.onSnapshot((snapshot) => {
    broadcast("snapshot", snapshot);
  });

  // --- HTTP server ---
  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && req.url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const client: SseClient = { res, id: nextClientId++ };
      sseClients.push(client);
      console.log(`[Stat Server] SSE client connected (#${client.id}), total: ${sseClients.length}`);

      const openRound = engine.getOpenRound();
      const currentTotals = engine.getCurrentTotals();
      if (openRound && currentTotals) {
        res.write(`event: state\ndata: ${JSON.stringify({ openRound, currentTotals, matchInfo })}\n\n`);
      }
      // Send match info separately too, in case a round hasn't opened yet
      // (currentTotals may be null early on, but match info is available
      // as soon as the fixtures lookup completes at startup).
      if (matchInfo) {
        res.write(`event: match_info\ndata: ${JSON.stringify(matchInfo)}\n\n`);
      }

      req.on("close", () => {
        sseClients = sseClients.filter((c) => c.id !== client.id);
        console.log(`[Stat Server] SSE client disconnected (#${client.id}), total: ${sseClients.length}`);
      });
      return;
    }

    if (req.method === "GET" && req.url === "/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          currentTotals: engine.getCurrentTotals(),
          openRound: engine.getOpenRound(),
        })
      );
      return;
    }

    if (req.method === "GET" && req.url === "/leaderboard") {
      fetchLeaderboard()
        .then((entries) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ entries }));
        })
        .catch((err) => {
          console.error("[Stat Server] Leaderboard fetch failed:", err.message || err);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Failed to fetch leaderboard" }));
        });
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/session-stats")) {
      // This game mode's OWN tracking of a player's streak/points, kept
      // separate from the combined on-chain total (which sums points from
      // both server.ts's odds game and this stat game, since they share
      // one PlayerScore PDA per wallet). Useful for the frontend to show
      // "you earned X points in THIS game" alongside the all-time total.
      const url = new URL(req.url, `http://localhost:${HTTP_PORT}`);
      const userId = url.searchParams.get("userId");
      if (!userId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "userId query param required" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          streak: engine.getPlayerStreak(userId),
          sessionPoints: engine.getPlayerPoints(userId),
        })
      );
      return;
    }

    if (req.method === "POST" && req.url === "/call") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const { userId, category, call } = JSON.parse(body) as {
            userId: string;
            category: StatCategory;
            call: HiLoCall;
          };
          const validCategories: StatCategory[] = ["goals", "yellowCards", "redCards", "corners"];
          if (!userId || !validCategories.includes(category) || (call !== "higher" && call !== "lower")) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: "userId, category ('goals'|'yellowCards'|'redCards'|'corners'), and call ('higher'|'lower') required",
              })
            );
            return;
          }
          const accepted = engine.submitCall(userId, category, call);
          res.writeHead(accepted ? 200 : 409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ accepted }));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid JSON body" }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(HTTP_PORT, () => {
    console.log(`[Stat Server] HTTP server listening on :${HTTP_PORT}`);
    console.log(`[Stat Server] SSE endpoint:  http://localhost:${HTTP_PORT}/events`);
    console.log(`[Stat Server] Call endpoint: POST http://localhost:${HTTP_PORT}/call`);
    console.log(`[Stat Server] Tracking fixture ${FIXTURE_ID} (goals/cards/corners)`);
  });

  // --- Connect to scores stream and pump ticks through the decoder ---
  let { reader, jwt, apiToken } = await activateAndGetScoresStream();

  matchInfo = await lookupMatchInfo(jwt, apiToken);
  if (matchInfo) {
    console.log(`[Stat Server] Match: ${matchInfo.homeTeam} vs ${matchInfo.awayTeam}`);
    broadcast("match_info", matchInfo);
  } else {
    console.log(`[Stat Server] Match name unavailable — frontend will show fixture ID ${FIXTURE_ID} instead.`);
  }

  const decoder = new TextDecoder();
  let rawTickCount = 0;
  let decodedCount = 0;
  console.log("[Stat Server] Live. Feeding score ticks into stat engine.\n");

  // Reconnect strategy: a stream drop (network hiccup, TxLINE-side reset,
  // etc.) is treated as recoverable, not fatal. We first try a cheap
  // reconnect (same jwt/apiToken, just a fresh SSE connection) with
  // exponential backoff. If several of those in a row fail — e.g. because
  // the token itself expired, which we have no documented lifetime for —
  // we fall back to a full re-activation (new on-chain subscribe + new
  // token). This two-tier approach avoids paying on-chain transaction costs
  // on every transient network blip while still recovering from a genuinely
  // expired session.
  const MAX_CHEAP_RETRIES_BEFORE_FULL_REACTIVATION = 5;
  const BASE_BACKOFF_MS = 2000;
  const MAX_BACKOFF_MS = 30000;
  let consecutiveFailures = 0;

  while (true) {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          console.warn("[Stat Server] Stream ended (server closed connection). Reconnecting...");
          break;
        }

        consecutiveFailures = 0; // a successful read means the connection is healthy

        const chunk = decoder.decode(value);
        for (const line of chunk.split("\n")) {
          if (line.startsWith("data:") || line.startsWith("Message:")) {
            const payload = line.startsWith("data:") ? line.slice(5) : line.slice(9);
            try {
              const raw = JSON.parse(payload.trim()) as RawScoreTick;
              rawTickCount++;

              const snapshot = decodeScoreTick(raw);
              if (snapshot) {
                decodedCount++;
                engine.ingest(snapshot);
              } else if (rawTickCount % 20 === 1) {
                console.log(`[Stat Server] undecoded raw tick (sample):`, JSON.stringify(raw));
              }
            } catch {
              // ignore non-JSON keepalive lines
            }
          }
        }
      }
    } catch (err: any) {
      console.error("[Stat Server] Stream read error:", err.message || err);
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // already released or in a bad state — safe to ignore
      }
    }

    consecutiveFailures++;
    const useFullReactivation = consecutiveFailures > MAX_CHEAP_RETRIES_BEFORE_FULL_REACTIVATION;
    const backoffMs = Math.min(BASE_BACKOFF_MS * 2 ** (consecutiveFailures - 1), MAX_BACKOFF_MS);

    console.log(
      `[Stat Server] Reconnect attempt ${consecutiveFailures} in ${backoffMs}ms` +
        (useFullReactivation ? " (full re-activation)" : " (reusing existing session)")
    );
    await new Promise((resolve) => setTimeout(resolve, backoffMs));

    try {
      if (useFullReactivation) {
        const fresh = await activateAndGetScoresStream();
        reader = fresh.reader;
        jwt = fresh.jwt;
        apiToken = fresh.apiToken;
        consecutiveFailures = 0;
        console.log("[Stat Server] Full re-activation succeeded.");
      } else {
        reader = await openScoresStream(jwt, apiToken);
        console.log("[Stat Server] Reconnected using existing session.");
      }
    } catch (reconnectErr: any) {
      console.error("[Stat Server] Reconnect attempt failed:", reconnectErr.message || reconnectErr);
      // Loop back around — the next iteration will back off further and
      // eventually escalate to full re-activation if not already there.
    }
  }
}

main().catch((err) => {
  console.error("[Stat Server] Fatal error:", err.response?.data || err.message || err);
  if (err.cause) console.error("[Stat Server] Cause:", err.cause);
  process.exit(1);
});