/**
 * Tilt — Score stream capture (diagnostic only)
 *
 * We couldn't find the exact score-tick JSON schema in TxLINE's docs (only
 * the on-chain stat encoding — which stats exist, not their wire format).
 * This script reuses the same activation flow as activate_and_stream.ts but
 * connects to /api/scores/stream instead of /api/odds/stream, and just
 * prints raw ticks so we can see the real field names before building the
 * stat-based round engine against them.
 *
 * Run with:
 *   ANCHOR_PROVIDER_URL="https://api.devnet.solana.com" \
 *   ANCHOR_WALLET="./wallet.json" \
 *   npx ts-node capture_scores.ts
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
import * as nacl from "tweetnacl";
import type { Txoracle } from "./types/txoracle";

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

async function main() {
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

  console.log("[Capture] Subscribing on-chain...");
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
  console.log(`[Capture] Subscribed. tx: ${txSig}`);

  const authResponse = await axios.post(`${apiOrigin}/auth/guest/start`);
  const jwt = authResponse.data.token;

  const messageString = `${txSig}:${SELECTED_LEAGUES.join(",")}:${jwt}`;
  const message = new TextEncoder().encode(messageString);
  const localPayer = (provider.wallet as anchor.Wallet & { payer?: anchor.web3.Keypair }).payer;
  if (!localPayer) throw new Error("Requires a local Anchor keypair wallet.");
  const signatureBytes = nacl.sign.detached(message, localPayer.secretKey);
  const walletSignature = Buffer.from(signatureBytes).toString("base64");

  console.log("[Capture] Activating API token...");
  const activationResponse = await axios.post(
    `${apiBaseUrl}/token/activate`,
    { txSig, walletSignature, leagues: SELECTED_LEAGUES },
    { headers: { Authorization: `Bearer ${jwt}` } }
  );
  const apiToken = activationResponse.data.token || activationResponse.data;
  console.log("[Capture] API token activated.");

  console.log("[Capture] Connecting to SCORES stream (not odds this time)...");
  const streamUrl = `${apiBaseUrl}/scores/stream`;
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

  const reader = streamResponse.body.getReader();
  const decoder = new TextDecoder();
  let tickCount = 0;
  const seenFixtures = new Set<number>();

  console.log("[Capture] Streaming live scores. Ctrl+C to stop.\n");

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value);
    for (const line of chunk.split("\n")) {
      if (line.startsWith("data:") || line.startsWith("Message:")) {
        const payload = line.startsWith("data:") ? line.slice(5) : line.slice(9);
        try {
          const data = JSON.parse(payload.trim());
          tickCount++;
          console.log(`[score tick ${tickCount}]`, JSON.stringify(data));
          if (data.FixtureId !== undefined && !seenFixtures.has(data.FixtureId)) {
            seenFixtures.add(data.FixtureId);
          }
        } catch {
          // ignore keepalive lines
        }
      }
    }
  }
}

main().catch((err) => {
  console.error("[Capture] Fatal error:", err.response?.data || err.message || err);
  if (err.cause) console.error("[Capture] Cause:", err.cause);
  process.exit(1);
});