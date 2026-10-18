use anchor_lang::prelude::*;

// YOUR_WALLET_PUBLIC_KEY
pub const INITIAL_AUTHORITY: Pubkey = pubkey!("cNuU9CNKFMJtpvxxS2xACLP6zYwFFAKDDh5AjmN7o2E");

pub const AMM_CONFIG_SEED: &[u8] = b"amm_config";
pub const POOL_SEED: &[u8] = b"pool";
pub const LP_MINT_SEED: &[u8] = b"lp_mint";
pub const LOCKED_LP_SEED: &[u8] = b"lock";

pub const MINIMUM_LIQUIDITY: u64 = 1_000;
