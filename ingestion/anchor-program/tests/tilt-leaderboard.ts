/**
 * Tilt — Leaderboard program tests
 *
 * Run against a fresh local validator (recommended, doesn't touch devnet
 * or cost real devnet SOL, gives clean state every run):
 *
 *   anchor test --provider.cluster localnet
 *
 * This test needs the SAME keypair that's hardcoded as AUTHORITY_PUBKEY in
 * lib.rs (your ingestion/wallet.json) to exercise the "authorized" path,
 * since the program only accepts score updates signed by that exact key.
 * Set AUTHORITY_KEYPAIR_PATH below if your wallet.json lives elsewhere.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { assert } from "chai";

// Resolved relative to THIS FILE's location (not the current working
// directory — fs.readFileSync uses CWD by default, which caused the
// previous ENOENT since `anchor test` runs from the anchor-program root,
// not from tests/). __dirname here is
// ingestion/anchor-program/tests, so two levels up is ingestion/.
const AUTHORITY_KEYPAIR_PATH = path.join(__dirname, "..", "..", "wallet.json");

describe("tilt-leaderboard", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // anchor.workspace picks up the program by its Cargo package name,
  // converted to the generated type name — matches what `anchor build`
  // produces in target/types/tilt_leaderboard.ts
  const program = anchor.workspace.TiltLeaderboard as Program<any>;

  let authority: Keypair;
  let randomPlayer: Keypair;
  let unauthorizedSigner: Keypair;

  before(async () => {
    // Load the real backend authority keypair — this must match
    // AUTHORITY_PUBKEY hardcoded in lib.rs, or every "authorized" test
    // below will fail with the same Unauthorized error we're testing for
    // in the negative case.
    const raw = JSON.parse(fs.readFileSync(AUTHORITY_KEYPAIR_PATH, "utf-8"));
    authority = Keypair.fromSecretKey(new Uint8Array(raw));

    randomPlayer = Keypair.generate();
    unauthorizedSigner = Keypair.generate();

    // Fund both the authority and the unauthorized signer so they can pay
    // for transactions / rent. On localnet this is instant; on devnet
    // you'd need to pre-fund the authority wallet yourself beforehand.
    for (const kp of [authority, unauthorizedSigner]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig, "confirmed");
    }
  });

  function derivePlayerScorePda(player: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("player_score"), player.toBuffer()],
      program.programId
    );
    return pda;
  }

  it("creates a new PlayerScore account on first update (init_if_needed)", async () => {
    const playerScorePda = derivePlayerScorePda(randomPlayer.publicKey);

    await program.methods
      .updateScore(3, 100, true) // new_streak=3, points_delta=100, won=true
      .accounts({
        authority: authority.publicKey,
        player: randomPlayer.publicKey,
        playerScore: playerScorePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    const account = await (program.account as any).playerScore.fetch(playerScorePda);

    assert.strictEqual(account.owner.toBase58(), randomPlayer.publicKey.toBase58());
    assert.strictEqual(account.bestStreak, 3);
    assert.strictEqual(account.totalPoints, 100);
    assert.strictEqual(account.matchesPlayed, 1);
    assert.strictEqual(account.roundsWon, 1);
  });

  it("accumulates points and matches on a second update, without resetting", async () => {
    const playerScorePda = derivePlayerScorePda(randomPlayer.publicKey);

    await program.methods
      .updateScore(2, 50, false) // lower streak this time, a loss
      .accounts({
        authority: authority.publicKey,
        player: randomPlayer.publicKey,
        playerScore: playerScorePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    const account = await (program.account as any).playerScore.fetch(playerScorePda);

    // best_streak should NOT drop just because this round's streak was lower
    assert.strictEqual(account.bestStreak, 3, "best_streak must not decrease");
    assert.strictEqual(account.totalPoints, 150, "points should accumulate: 100 + 50");
    assert.strictEqual(account.matchesPlayed, 2);
    assert.strictEqual(account.roundsWon, 1, "rounds_won should not increment on a loss");
  });

  it("updates best_streak when a new streak exceeds the previous best", async () => {
    const playerScorePda = derivePlayerScorePda(randomPlayer.publicKey);

    await program.methods
      .updateScore(7, 20, true) // new best streak of 7
      .accounts({
        authority: authority.publicKey,
        player: randomPlayer.publicKey,
        playerScore: playerScorePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    const account = await (program.account as any).playerScore.fetch(playerScorePda);
    assert.strictEqual(account.bestStreak, 7);
    assert.strictEqual(account.totalPoints, 170);
    assert.strictEqual(account.roundsWon, 2);
  });

  it("rejects a score update from any signer other than the hardcoded authority", async () => {
    const playerScorePda = derivePlayerScorePda(unauthorizedSigner.publicKey);

    let threw = false;
    try {
      await program.methods
        .updateScore(1, 10, true)
        .accounts({
          authority: unauthorizedSigner.publicKey, // NOT the real authority
          player: unauthorizedSigner.publicKey,
          playerScore: playerScorePda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([unauthorizedSigner])
        .rpc();
    } catch (err: any) {
      threw = true;
      const msg = err.toString();
      assert.include(
        msg,
        "Unauthorized",
        `expected an Unauthorized error, got: ${msg}`
      );
    }

    assert.isTrue(threw, "expected the transaction to be rejected, but it succeeded");
  });
});