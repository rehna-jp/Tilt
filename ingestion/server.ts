/**
 * Tilt — Game Server
 *
 * Combines three pieces into one long-running process:
 *   1. TxLINE activation + live odds stream (same verified flow as
 *      activate_and_stream.ts)
 *   2. RoundEngine, fed by that stream
 *   3. A tiny HTTP server exposing:
 *        GET  /events  — SSE stream of round_start / tick / round_resolve events
 *        POST /call    — { userId, call: "up"|"down" } submits a player's call
 *        GET  /state   — current line + open round snapshot (polling fallback)
 *
 * This is intentionally plain Node http (no Express) to keep dependencies
 * minimal. The Next.js frontend connects to GET /events with EventSource.
 *
 * Run with:
 *   ANCHOR_PROVIDER_URL="https://api.devnet.solana.com" \
 *   ANCHOR_WALLET="./wallet.json" \
 *   FIXTURE_ID=18179549 \
 *   npx ts-node server.ts
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
import { RoundEngine, OddsTick } from "./game/roundEngine";

// ---- Config (mirrors activate_and_stream.ts, verified 2026-07) ----
const NETWORK: "mainnet" | "devnet" = "devnet";

const CONFIG = {
  mainnet: {
    rpcUrl: "https://api.mainnet-beta.solana.com",
    apiOrigin: "https://txline.txodds.com",
    programId: new PublicKey("9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA"),
  },
  devnet: {
    rpcUrl: "https://api.devnet.solana.com",
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
const FIXTURE_ID = Number(process.env.FIXTURE_ID || "18179549");
const SUPER_ODDS_TYPE = process.env.SUPER_ODDS_TYPE || "1X2_PARTICIPANT_RESULT";
const PRICE_NAME = process.env.PRICE_NAME || "part1";
const ROUND_DURATION_MS = Number(process.env.ROUND_DURATION_MS || "90000"); // 90s default
const HTTP_PORT = Number(process.env.PORT || "8787");

// ---- SSE broadcast plumbing ----
type SseClient = { res: http.ServerResponse; id: number };
let sseClients: SseClient[] = [];
let nextClientId = 1;

function broadcast(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.res.write(payload);
  }
}

// ---- TxLINE activation (same flow as activate_and_stream.ts) ----
async function activateAndGetOddsStream() {
  const provider = AnchorProvider.env();
  anchor.setProvider(provider);

  const program = new Program<Txoracle>(idl as any, provider);
  if (!program.programId.equals(programId)) {
    throw new Error(
      `Loaded IDL program ${program.programId.toBase58()} does not match ${NETWORK} program ${programId.toBase58()}`
    );
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
  const [pricingMatrixPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pricing_matrix")],
    program.programId
  );
  const userTokenAccount = getAssociatedTokenAddressSync(
    TXLINE_MINT,
    provider.wallet.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  console.log("[Tilt Server] Subscribing on-chain...");
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
  console.log(`[Tilt Server] Subscribed. tx: ${txSig}`);

  console.log("[Tilt Server] Requesting guest JWT...");
  const authResponse = await axios.post(`${apiOrigin}/auth/guest/start`);
  const jwt = authResponse.data.token;

  const messageString = `${txSig}:${SELECTED_LEAGUES.join(",")}:${jwt}`;
  const message = new TextEncoder().encode(messageString);
  const localPayer = (provider.wallet as anchor.Wallet & { payer?: anchor.web3.Keypair }).payer;
  if (!localPayer) throw new Error("Requires a local Anchor keypair wallet.");
  const signatureBytes = nacl.sign.detached(message, localPayer.secretKey);
  const walletSignature = Buffer.from(signatureBytes).toString("base64");

  console.log("[Tilt Server] Activating API token...");
  const activationResponse = await axios.post(
    `${apiBaseUrl}/token/activate`,
    { txSig, walletSignature, leagues: SELECTED_LEAGUES },
    { headers: { Authorization: `Bearer ${jwt}` } }
  );
  const apiToken = activationResponse.data.token || activationResponse.data;
  console.log("[Tilt Server] API token activated.");

  const streamUrl = `${apiBaseUrl}/odds/stream`;
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
  const engine = new RoundEngine({
    fixtureId: FIXTURE_ID,
    superOddsType: SUPER_ODDS_TYPE,
    priceName: PRICE_NAME,
    roundDurationMs: ROUND_DURATION_MS,
  });

  engine.onRoundStart((payload) => {
    console.log(`[round ${payload.roundId}] started at ${payload.startLine}`);
    broadcast("round_start", payload);
  });

  engine.onRoundResolve((result) => {
    console.log(`[round ${result.roundId}] resolved: ${result.direction} (${result.startLine} -> ${result.endLine})`);
    broadcast("round_resolve", result);
  });

  engine.onTick(({ line, ts }) => {
    broadcast("tick", { line, ts });
  });

  // --- HTTP server ---
  const server = http.createServer((req, res) => {
    // Basic CORS for local dev — tighten before any real deployment
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
      console.log(`[Tilt Server] SSE client connected (#${client.id}), total: ${sseClients.length}`);

      // Send current state immediately so late joiners aren't blank
      const openRound = engine.getOpenRound();
      const currentLine = engine.getCurrentLine();
      if (openRound && currentLine !== null) {
        res.write(`event: state\ndata: ${JSON.stringify({ openRound, currentLine })}\n\n`);
      }

      req.on("close", () => {
        sseClients = sseClients.filter((c) => c.id !== client.id);
        console.log(`[Tilt Server] SSE client disconnected (#${client.id}), total: ${sseClients.length}`);
      });
      return;
    }

    if (req.method === "GET" && req.url === "/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          currentLine: engine.getCurrentLine(),
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
          const { userId, call } = JSON.parse(body);
          if (!userId || (call !== "up" && call !== "down")) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "userId and call ('up'|'down') required" }));
            return;
          }
          const accepted = engine.submitCall(userId, call);
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
    console.log(`[Tilt Server] HTTP server listening on :${HTTP_PORT}`);
    console.log(`[Tilt Server] SSE endpoint:  http://localhost:${HTTP_PORT}/events`);
    console.log(`[Tilt Server] Call endpoint: POST http://localhost:${HTTP_PORT}/call`);
    console.log(`[Tilt Server] Tracking fixture ${FIXTURE_ID}, market ${SUPER_ODDS_TYPE}/${PRICE_NAME}`);
  });

  // --- Connect to TxLINE and pump ticks into the engine ---
  const reader = await activateAndGetOddsStream();
  const decoder = new TextDecoder();
  const seenFixtures = new Set<number>();
  console.log("[Tilt Server] Live. Feeding ticks into round engine.\n");

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data:") || line.startsWith("Message:")) {
          const payload = line.startsWith("data:") ? line.slice(5) : line.slice(9);
          try {
            const data = JSON.parse(payload.trim()) as OddsTick;
            // TEMP: log every distinct fixture seen, to discover what's live right now
            if (data.FixtureId !== undefined) {
              if (!seenFixtures.has(data.FixtureId)) {
                seenFixtures.add(data.FixtureId);
                console.log(`[Tilt Server] Saw new live fixture: ${data.FixtureId} (market: ${data.SuperOddsType})`);
              }
            }
            engine.ingest(data);
          } catch {
            // ignore non-JSON keepalive lines
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
    engine.stop();
  }
}

main().catch((err) => {
  console.error("[Tilt Server] Fatal error:", err.response?.data || err.message || err);
  if (err.cause) {
    console.error("[Tilt Server] Underlying cause:", err.cause);
  }
  process.exit(1);
});