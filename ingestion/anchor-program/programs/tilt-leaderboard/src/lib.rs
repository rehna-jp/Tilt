use anchor_lang::prelude::*;

// Placeholder — replace with the real deployed program ID after `anchor build`
// generates a fresh keypair, then run `anchor keys sync`.
declare_id!("75RwuxJxo78e2mXswbhYW197ykfZjHV7mJQnJZCkDBbk");

// Replace this with your real backend wallet pubkey before deploying.
// Using the System Program's ID as a placeholder: it's a real, guaranteed-
// correct 32-byte pubkey (no typo risk), and it can never actually sign a
// transaction, so the program is safely inert until you set a real key.
pub const AUTHORITY_PUBKEY: Pubkey = pubkey!("3HA4rikM96RMZ5g5dBFeALzWuPnzdzvGDNqLDtfYvkia");

#[program]
pub mod tilt_leaderboard {
    use super::*;

    /// Called by the backend after a round resolves, once per player who
    /// made a call in that round. Not called per-round for a whole match —
    /// only for players who actually participated, to avoid writing
    /// unnecessary on-chain data for empty rounds.
    pub fn update_score(
        ctx: Context<UpdateScore>,
        new_streak: u16,
        points_delta: u32,
        won: bool,
    ) -> Result<()> {
        let player_score = &mut ctx.accounts.player_score;

        // First time we see this player — record ownership.
        if player_score.owner == Pubkey::default() {
            player_score.owner = ctx.accounts.player.key();
        }

        if new_streak > player_score.best_streak {
            player_score.best_streak = new_streak;
        }

        player_score.total_points = player_score
            .total_points
            .checked_add(points_delta)
            .ok_or(TiltError::Overflow)?;

        player_score.matches_played = player_score
            .matches_played
            .checked_add(1)
            .ok_or(TiltError::Overflow)?;

        if won {
            player_score.rounds_won = player_score
                .rounds_won
                .checked_add(1)
                .ok_or(TiltError::Overflow)?;
        }

        Ok(())
    }
}

#[account]
pub struct PlayerScore {
    pub owner: Pubkey,        // 32
    pub best_streak: u16,     // 2
    pub total_points: u32,    // 4
    pub matches_played: u32,  // 4
    pub rounds_won: u32,      // 4
}

impl PlayerScore {
    // 8 (Anchor account discriminator) + fields above
    pub const SIZE: usize = 8 + 32 + 2 + 4 + 4 + 4;
}

#[derive(Accounts)]
pub struct UpdateScore<'info> {
    #[account(mut, address = AUTHORITY_PUBKEY @ TiltError::Unauthorized)]
    pub authority: Signer<'info>,

    /// CHECK: this is the player the score PDA belongs to. It does not need
    /// to sign — the backend authority is the trusted source of round
    /// outcomes, since it's the process that actually resolved the round
    /// against live TxLINE data.
    pub player: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = authority,
        space = PlayerScore::SIZE,
        seeds = [b"player_score", player.key().as_ref()],
        bump
    )]
    pub player_score: Account<'info, PlayerScore>,

    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum TiltError {
    #[msg("Only the trusted backend authority can update scores")]
    Unauthorized,
    #[msg("Arithmetic overflow while updating score")]
    Overflow,
}