/**
 * Tilt — Stat Game Server (goals/cards/corners Hi-Lo)
 *
 * Sibling to server.ts, but wired to the SCORES stream and StatRoundEngine
 * instead of the odds stream and RoundEngine. This is the pivot toward the
 * "predict the next stat" mechanic instead of "predict the odds line."
 *
 * ⚠️ DEPENDS ON scoreTickDecoder.ts, WHICH IS UNVERIFIED ⚠️
 * See scoreTickDecoder.ts for details — until a real captured tick confirms
 * the field names, this server may silently receive zero usable snapshots
 * even while connected and streaming. Watch the console: it logs every raw
 * tick it receives so you can tell if decodeScoreTick() is actually
 * producing snapshots or returning null on everything.
 *
 * Run with:
 *   ANCHOR_PROVIDER_URL="https://api.devnet.solana.com" \
 *   ANCHOR_WALLET="./wallet.json" \
 *   FIXTURE_ID=18209181 \
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
import { updatePlayerScore } from "./leaderboardClient";

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
const FIXTURE_ID = Number(process.env.FIXTURE_ID || "18209181");
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

// ---- Main ----
async function main() {
  const engine = new StatRoundEngine({
    fixtureId: FIXTURE_ID,
    roundDurationMs: ROUND_DURATION_MS,
    basePoints: 10,
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
        res.write(`event: state\ndata: ${JSON.stringify({ openRound, currentTotals })}\n\n`);
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
  const reader = await activateAndGetScoresStream();
  const decoder = new TextDecoder();
  let rawTickCount = 0;
  let decodedCount = 0;
  console.log("[Stat Server] Live. Feeding score ticks into stat engine.\n");

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

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
              // Periodically surface raw ticks that failed to decode, so
              // it's obvious in the logs if the decoder needs fixing —
              // not spamming every single tick, just a sample.
              console.log(`[Stat Server] undecoded raw tick (sample):`, JSON.stringify(raw));
            }
          } catch {
            // ignore non-JSON keepalive lines
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
    engine.stop();
    console.log(`[Stat Server] Stream ended. Raw ticks: ${rawTickCount}, decoded: ${decodedCount}`);
  }
}

main().catch((err) => {
  console.error("[Stat Server] Fatal error:", err.response?.data || err.message || err);
  if (err.cause) console.error("[Stat Server] Cause:", err.cause);
  process.exit(1);
});