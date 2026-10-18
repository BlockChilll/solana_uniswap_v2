use anchor_lang::prelude::*;

#[event]
pub struct PoolCreated {
    pub pool: Pubkey,
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,
    pub mint_lp: Pubkey,
}

#[event]
pub struct MintLiquidity {
    pub pool: Pubkey,
    pub provider: Pubkey,
    pub amount_a: u64,
    pub amount_b: u64,
    pub liquidity: u64,
}

#[event]
pub struct BurnLiquidity {
    pub pool: Pubkey,
    pub provider: Pubkey,
    pub amount_a: u64,
    pub amount_b: u64,
    pub liquidity: u64,
}

#[event]
pub struct Swap {
    pub pool: Pubkey,
    pub trader: Pubkey,
    pub amount_a_in: u64,
    pub amount_b_in: u64,
    pub amount_a_out: u64,
    pub amount_b_out: u64,
}

#[event]
pub struct Sync {
    pub pool: Pubkey,
    pub reserve_a: u64,
    pub reserve_b: u64,
}
