/**
 * Tilt — Fixture lookup
 *
 * Fetches the fixtures snapshot and prints team names + fixture IDs, so we
 * can map a live fixture ID (seen in capture_scores.ts / server.ts logs)
 * to a real match name like "Norway vs England".
 *
 * Endpoint and field names verified from TxODDS's own example script
 * (get_fixtures_snapshot.ts) in their tx-on-chain repo — not guessed.
 *
 * Run with:
 *   ANCHOR_PROVIDER_URL="https://api.devnet.solana.com" \
 *   ANCHOR_WALLET="./wallet.json" \
 *   npx ts-node lookup_fixtures.ts
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

interface Fixture {
  FixtureId: number;
  Participant1: string;
  Participant2: string;
  Participant1IsHome: boolean;
  StartTime: number | string;
  Competition?: string;
  CompetitionId?: number;
}

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
  const [pricingMatrixPda] = PublicKey.findProgramAddressSync([Buffer.from("pricing_matrix")], program.programId);
  const userTokenAccount = getAssociatedTokenAddressSync(
    TXLINE_MINT,
    provider.wallet.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  console.log("[Lookup] Subscribing on-chain...");
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
  console.log(`[Lookup] Subscribed. tx: ${txSig}`);

  const authResponse = await axios.post(`${apiOrigin}/auth/guest/start`);
  const jwt = authResponse.data.token;

  const messageString = `${txSig}:${SELECTED_LEAGUES.join(",")}:${jwt}`;
  const message = new TextEncoder().encode(messageString);
  const localPayer = (provider.wallet as anchor.Wallet & { payer?: anchor.web3.Keypair }).payer;
  if (!localPayer) throw new Error("Requires a local Anchor keypair wallet.");
  const signatureBytes = nacl.sign.detached(message, localPayer.secretKey);
  const walletSignature = Buffer.from(signatureBytes).toString("base64");

  console.log("[Lookup] Activating API token...");
  const activationResponse = await axios.post(
    `${apiBaseUrl}/token/activate`,
    { txSig, walletSignature, leagues: SELECTED_LEAGUES },
    { headers: { Authorization: `Bearer ${jwt}` } }
  );
  const apiToken = activationResponse.data.token || activationResponse.data;
  console.log("[Lookup] API token activated.\n");

  const httpClient = axios.create({
    baseURL: apiOrigin,
    timeout: 30000,
    headers: {
      Authorization: `Bearer ${jwt}`,
      "X-Api-Token": apiToken,
    },
  });

  console.log("[Lookup] Fetching fixtures snapshot (all competitions)...");
  const response = await httpClient.get<Fixture[]>("/api/fixtures/snapshot");
  const fixtures = response.data;

  console.log(`[Lookup] Retrieved ${fixtures.length} fixtures.\n`);

  // Filter to anything involving Norway, England, Argentina, or Switzerland
  // (today's quarterfinals) so the output is scannable, not a wall of data.
  const keywords = ["norway", "england", "argentina", "switzerland"];
  const relevant = fixtures.filter((f) =>
    keywords.some(
      (kw) => f.Participant1?.toLowerCase().includes(kw) || f.Participant2?.toLowerCase().includes(kw)
    )
  );

  console.log(`[Lookup] Matches involving today's quarterfinal teams:\n`);
  for (const f of relevant) {
    console.log(`  ${f.Participant1} vs ${f.Participant2}`);
    console.log(`    FixtureId: ${f.FixtureId}`);
    console.log(`    StartTime: ${new Date(f.StartTime).toString()}`);
    console.log(`    Competition: ${f.Competition ?? "n/a"}`);
    console.log("");
  }

  if (relevant.length === 0) {
    console.log("  (none found — printing first 10 fixtures instead so you can see the real shape)\n");
    for (const f of fixtures.slice(0, 10)) {
      console.log(`  ${f.Participant1} vs ${f.Participant2} — FixtureId: ${f.FixtureId}`);
    }
  }
}

main().catch((err) => {
  console.error("[Lookup] Fatal error:", err.response?.data || err.message || err);
  process.exit(1);
});