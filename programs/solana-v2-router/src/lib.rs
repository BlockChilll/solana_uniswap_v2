use anchor_lang::prelude::*;

mod errors;
mod helpers;
mod instructions;
mod math;

use instructions::*;

declare_id!("2b4VvZBkuHoMTxHNaZRdCwmkBiKg4DjUhdY5GBG6Hj2E");

#[program]
pub mod solana_v2_router {
    use super::*;

    pub fn add_liquidity(
        ctx: Context<AddLiquidity>,
        amount_a_desired: u64,
        amount_b_desired: u64,
        amount_a_min: u64,
        amount_b_min: u64,
        deadline: i64,
    ) -> Result<()> {
        instructions::add_liquidity(
            ctx,
            amount_a_desired,
            amount_b_desired,
            amount_a_min,
            amount_b_min,
            deadline,
        )
    }

    pub fn add_liquidity_sol(
        ctx: Context<AddLiquiditySol>,
        amount_token_desired: u64,
        amount_token_min: u64,
        amount_sol_min: u64,
        max_sol: u64,
        deadline: i64,
    ) -> Result<()> {
        instructions::add_liquidity_sol(
            ctx,
            amount_token_desired,
            amount_token_min,
            amount_sol_min,
            max_sol,
            deadline,
        )
    }

    pub fn remove_liquidity(
        ctx: Context<RemoveLiquidity>,
        liquidity: u64,
        amount_a_min: u64,
        amount_b_min: u64,
        deadline: i64,
    ) -> Result<()> {
        instructions::remove_liquidity(ctx, liquidity, amount_a_min, amount_b_min, deadline)
    }

    pub fn remove_liquidity_sol(
        ctx: Context<RemoveLiquiditySol>,
        liquidity: u64,
        amount_token_min: u64,
        amount_sol_min: u64,
        deadline: i64,
    ) -> Result<()> {
        instructions::remove_liquidity_sol(
            ctx,
            liquidity,
            amount_token_min,
            amount_sol_min,
            deadline,
        )
    }

    pub fn swap_exact_tokens_for_tokens<'info>(
        ctx: Context<'_, '_, '_, 'info, SwapExactTokensForTokens<'info>>,
        amount_in: u64,
        amount_out_min: u64,
        path: Vec<Pubkey>,
        deadline: i64,
    ) -> Result<Vec<u64>> {
        instructions::swap_exact_tokens_for_tokens(ctx, amount_in, amount_out_min, path, deadline)
    }

    pub fn swap_tokens_for_exact_tokens<'info>(
        ctx: Context<'_, '_, '_, 'info, SwapTokensForExactTokens<'info>>,
        amount_out: u64,
        amount_in_max: u64,
        path: Vec<Pubkey>,
        deadline: i64,
    ) -> Result<Vec<u64>> {
        instructions::swap_tokens_for_exact_tokens(ctx, amount_out, amount_in_max, path, deadline)
    }

    pub fn swap_exact_sol_for_tokens<'info>(
        ctx: Context<'_, '_, '_, 'info, SwapExactSolForTokens<'info>>,
        amount_in: u64,
        amount_out_min: u64,
        path: Vec<Pubkey>,
        deadline: i64,
    ) -> Result<Vec<u64>> {
        instructions::swap_exact_sol_for_tokens(ctx, amount_in, amount_out_min, path, deadline)
    }

    pub fn swap_exact_tokens_for_sol<'info>(
        ctx: Context<'_, '_, '_, 'info, SwapExactTokensForSol<'info>>,
        amount_in: u64,
        amount_out_min: u64,
        path: Vec<Pubkey>,
        deadline: i64,
    ) -> Result<Vec<u64>> {
        instructions::swap_exact_tokens_for_sol(ctx, amount_in, amount_out_min, path, deadline)
    }

    pub fn swap_sol_for_exact_tokens<'info>(
        ctx: Context<'_, '_, '_, 'info, SwapSolForExactTokens<'info>>,
        amount_out: u64,
        amount_in_max: u64,
        path: Vec<Pubkey>,
        deadline: i64,
    ) -> Result<Vec<u64>> {
        instructions::swap_sol_for_exact_tokens(ctx, amount_out, amount_in_max, path, deadline)
    }

    pub fn swap_tokens_for_exact_sol<'info>(
        ctx: Context<'_, '_, '_, 'info, SwapTokensForExactSol<'info>>,
        amount_out: u64,
        amount_in_max: u64,
        path: Vec<Pubkey>,
        deadline: i64,
    ) -> Result<Vec<u64>> {
        instructions::swap_tokens_for_exact_sol(ctx, amount_out, amount_in_max, path, deadline)
    }
}

#[derive(Accounts)]
pub struct Initialize {}
