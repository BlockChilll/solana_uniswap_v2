use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct AmmConfig {
    pub fee_to: Pubkey,
    pub fee_to_setter: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct Pool {
    // Ordered token mints
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,

    // Cached token reserves
    pub reserve_a: u64,
    pub reserve_b: u64,

    // TWAP oracle
    pub block_timestamp_last: u32,
    pub price_a_cumulative_last: [u64; 4],
    pub price_b_cumulative_last: [u64; 4],

    // Protocol fee accounting
    pub k_last: u128,

    // Pool PDA bump
    pub bump: u8,
}
