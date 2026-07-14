/**
 * Tilt — Leaderboard client
 *
 * Wraps calls to the deployed tilt_leaderboard Anchor program's
 * update_score instruction. Requires idl/tilt_leaderboard.json to be
 * present — copy it from your local build:
 *
 *   cp anchor-program/target/idl/tilt_leaderboard.json ingestion/idl/
 *
 * The signer used here must match AUTHORITY_PUBKEY hardcoded in the
 * deployed program's lib.rs (your ingestion wallet), or every call will
 * fail with the program's Unauthorized error.
 */

import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";

// From `anchor deploy` output — update if you ever redeploy to a new address.
export const LEADERBOARD_PROGRAM_ID = new PublicKey(
  "75RwuxJxo78e2mXswbhYW197ykfZjHV7mJQnJZCkDBbk"
);

let cachedProgram: Program | null = null;

function loadLeaderboardIdl() {
  try {
    return require("./idl/tilt_leaderboard.json");
  } catch {
    throw new Error(
      "Missing ingestion/idl/tilt_leaderboard.json — copy it from " +
        "anchor-program/target/idl/tilt_leaderboard.json after running `anchor build`."
    );
  }
}

/** Lazily creates (and caches) the Anchor Program client for the leaderboard. */
export function getLeaderboardProgram(): Program {
  if (cachedProgram) return cachedProgram;

  const idl = loadLeaderboardIdl();
  const provider = AnchorProvider.env();
  anchor.setProvider(provider);

  const program = new Program(idl, provider);
  if (!program.programId.equals(LEADERBOARD_PROGRAM_ID)) {
    throw new Error(
      `Loaded leaderboard IDL program ${program.programId.toBase58()} does not match ` +
        `expected ${LEADERBOARD_PROGRAM_ID.toBase58()} — did you redeploy? Update LEADERBOARD_PROGRAM_ID.`
    );
  }

  cachedProgram = program;
  return program;
}

function derivePlayerScorePda(programId: PublicKey, player: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("player_score"), player.toBuffer()],
    programId
  );
  return pda;
}

/**
 * Writes a score update on-chain for one player. Call this once per player
 * who participated in a resolved round — not once per round overall.
 *
 * @param playerPubkeyStr base58 wallet address (this is what the frontend
 *   sends as `userId`, since it's `publicKey.toBase58()` from the wallet adapter)
 * @param newStreak the player's CURRENT streak after this round (0 if they
 *   just lost and their streak reset) — the program only raises best_streak
 *   if this exceeds the stored value, it never lowers it
 * @param pointsDelta points earned THIS round (added to their running total)
 * @param won whether they called this round correctly
 */
export async function updatePlayerScore(
  playerPubkeyStr: string,
  newStreak: number,
  pointsDelta: number,
  won: boolean
): Promise<string> {
  const program = getLeaderboardProgram();
  const provider = program.provider as AnchorProvider;

  let player: PublicKey;
  try {
    player = new PublicKey(playerPubkeyStr);
  } catch {
    throw new Error(`Invalid player pubkey: ${playerPubkeyStr}`);
  }

  const playerScorePda = derivePlayerScorePda(program.programId, player);

  const sig = await program.methods
    .updateScore(newStreak, pointsDelta, won)
    .accounts({
      authority: provider.wallet.publicKey,
      player,
      playerScore: playerScorePda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  return sig;
}

export interface LeaderboardEntry {
  owner: string; // base58 pubkey
  bestStreak: number;
  totalPoints: number;
  matchesPlayed: number;
  roundsWon: number;
}

/**
 * Fetches ALL PlayerScore accounts for this program and returns them sorted
 * by totalPoints descending. Uses Anchor's own account decoder (via
 * program.account.playerScore.all()) rather than hand-parsing raw bytes —
 * it already knows the correct discriminator and field layout from the IDL,
 * so this can't drift out of sync with the on-chain struct the way a manual
 * byte-offset parser could.
 *
 * No pagination/limit here since the program deliberately has no on-chain
 * ranking (see anchor-program/SETUP.md) — this is exactly the off-chain
 * indexing approach that design assumed callers would use.
 */
export async function fetchLeaderboard(limit = 50): Promise<LeaderboardEntry[]> {
  const program = getLeaderboardProgram();

  // Cast to `any` here because the generic Program<Idl> type (used since we
  // don't have the real generated TiltLeaderboard type in this file — see
  // the same caveat noted for updatePlayerScore) doesn't know the account
  // namespace's exact shape at compile time. The runtime behavior is
  // standard Anchor and was exercised indirectly by the passing program
  // tests, but this specific read path hasn't been run yet — worth a
  // careful first test.
  const accounts = await (program.account as any).playerScore.all();

  const entries: LeaderboardEntry[] = accounts.map((a: any) => ({
    owner: a.account.owner.toBase58(),
    bestStreak: a.account.bestStreak,
    totalPoints: a.account.totalPoints,
    matchesPlayed: a.account.matchesPlayed,
    roundsWon: a.account.roundsWon,
  }));

  entries.sort((a, b) => b.totalPoints - a.totalPoints);
  return entries.slice(0, limit);
}