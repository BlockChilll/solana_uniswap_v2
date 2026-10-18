use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::helpers::execute_swap;

pub fn swap_tokens_for_exact_tokens<'info>(
    ctx: Context<'_, '_, '_, 'info, SwapTokensForExactTokens<'info>>,
    amount_out: u64,
    amount_in_max: u64,
    path: Vec<Pubkey>,
    deadline: i64,
) -> Result<Vec<u64>> {
    execute_swap(
        ctx.accounts.trader.to_account_info(),
        ctx.accounts.user_token_account.to_account_info(),
        ctx.accounts.to_token_account.to_account_info(),
        ctx.accounts.amm_program.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        ctx.remaining_accounts,
        amount_out,
        amount_in_max,
        path,
        deadline,
        false,
    )
}

#[derive(Accounts)]
pub struct SwapTokensForExactTokens<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(mut, token::authority = trader)]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub to_token_account: Account<'info, TokenAccount>,

    pub amm_program: Program<'info, solana_v2_amm::program::SolanaV2Amm>,
    pub token_program: Program<'info, Token>,
}
