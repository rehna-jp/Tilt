/**
 * Tilt — TxLINE activation + live odds stream test
 *
 * Purpose: prove out the full pipe end-to-end before building anything else.
 *   1. Load/create a local Solana keypair
 *   2. Subscribe on-chain to the World Cup free tier (service level 1 or 12)
 *   3. Activate an API token via signed message
 *   4. Connect to the live odds SSE stream and print ticks to console
 *
 * Run with:
 *   ANCHOR_PROVIDER_URL="https://api.mainnet-beta.solana.com" \
 *   ANCHOR_WALLET="./wallet.json" \
 *   npx ts-node activate_and_stream.ts
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

// ---- Network config (verified against live IDL + docs, 2026-07-02) ----
// Mainnet is required for real-time (service level 12).
// Devnet only documents service level 1 (60s delay) per the World Cup docs.
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

const { rpcUrl, apiOrigin, programId } = CONFIG[NETWORK];
const apiBaseUrl = `${apiOrigin}/api`;

// The devnet and mainnet programs have structurally different IDLs (e.g. devnet
// has an extra request_devnet_faucet instruction and different account list),
// verified directly from TxODDS's docs source (documentation/programs/{network}.mdx)
// on 2026-07-02. Loading the wrong one causes silent account-mismatch failures.
const idl = (NETWORK as string) === "mainnet"
  ? require("./idl/txoracle.json")
  : require("./idl/txoracle_devnet.json");

// TXLINE_MINT is read from the loaded IDL's constants, not hardcoded — this is
// the pattern used in TxODDS's own example scripts and avoids the stale-README
// mismatch we found between the GitHub repo's top-level README and its actual IDL.
const TXLINE_MINT = new PublicKey(
  (idl as any).constants.find((c: any) => c.name === "TXLINE_MINT").value as string
);

// Free tier: service level 1 = 60s delay, service level 12 = real-time (mainnet only)
const SERVICE_LEVEL_ID = 1;
const DURATION_WEEKS = 4;
const SELECTED_LEAGUES: number[] = []; // empty = standard World Cup bundle

async function main() {
  console.log(`[Tilt] Network: ${NETWORK}`);
  console.log(`[Tilt] Program ID: ${programId.toBase58()}`);
  console.log(`[Tilt] TxL mint: ${TXLINE_MINT.toBase58()}`);

  const provider = AnchorProvider.env();
  anchor.setProvider(provider);

  const program = new Program<Txoracle>(idl as any, provider);

  if (!program.programId.equals(programId)) {
    throw new Error(
      `Loaded IDL program ${program.programId.toBase58()} does not match ${NETWORK} program ${programId.toBase58()}`
    );
  }

  // --- Step 1: Subscribe on-chain (free tier, no TxL purchase needed) ---
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

  console.log("[Tilt] Subscribing on-chain (free World Cup tier)...");

  // The user's TxL associated token account must exist before `subscribe`
  // will accept it — the program does not create it for you. We create it
  // idempotently (no-op if it already exists) as a pre-instruction in the
  // same transaction.
  const createUserAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    provider.wallet.publicKey, // payer
    userTokenAccount,
    provider.wallet.publicKey, // owner
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

  console.log(`[Tilt] Subscribed. tx: ${txSig}`);

  // --- Step 2: Guest JWT + activation ---
  console.log("[Tilt] Requesting guest JWT...");
  const authResponse = await axios.post(`${apiOrigin}/auth/guest/start`);
  const jwt = authResponse.data.token;

  const messageString = `${txSig}:${SELECTED_LEAGUES.join(",")}:${jwt}`;
  const message = new TextEncoder().encode(messageString);

  const localPayer = (provider.wallet as anchor.Wallet & {
    payer?: anchor.web3.Keypair;
  }).payer;

  if (!localPayer) {
    throw new Error("This script requires a local Anchor keypair wallet (ANCHOR_WALLET env).");
  }

  const signatureBytes = nacl.sign.detached(message, localPayer.secretKey);
  const walletSignature = Buffer.from(signatureBytes).toString("base64");

  console.log("[Tilt] Activating API token...");
  const activationResponse = await axios.post(
    `${apiBaseUrl}/token/activate`,
    { txSig, walletSignature, leagues: SELECTED_LEAGUES },
    { headers: { Authorization: `Bearer ${jwt}` } }
  );

  const apiToken = activationResponse.data.token || activationResponse.data;
  console.log("[Tilt] API token activated.");

  // --- Step 3: Connect to the live odds stream and print ticks ---
  console.log("[Tilt] Connecting to odds stream...");
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

  const reader = streamResponse.body.getReader();
  const decoder = new TextDecoder();
  let tickCount = 0;

  console.log("[Tilt] Streaming live. Ctrl+C to stop.\n");

  try {
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
            console.log(`[tick ${tickCount}]`, JSON.stringify(data));
          } catch {
            // ignore non-JSON keepalive lines
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

main().catch((err) => {
  console.error("[Tilt] Fatal error:", err.response?.data || err.message || err);
  process.exit(1);
});