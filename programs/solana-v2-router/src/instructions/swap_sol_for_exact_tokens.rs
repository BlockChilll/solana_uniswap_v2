use anchor_lang::{
    prelude::*,
    system_program::{self, Transfer as SolTransfer},
};
use anchor_spl::token::{self, CloseAccount, Mint, SyncNative, Token, TokenAccount, Transfer};

use crate::{
    errors::Errors,
    helpers::{calculate_swap_amounts, execute_swap_hops},
};

pub fn swap_sol_for_exact_tokens<'info>(
    ctx: Context<'_, '_, '_, 'info, SwapSolForExactTokens<'info>>,
    amount_out: u64,
    amount_in_max: u64,
    path: Vec<Pubkey>,
    deadline: i64,
) -> Result<Vec<u64>> {
    // SOL must be the first token in the path.
    require!(
        path.first() == Some(&anchor_spl::token::spl_token::native_mint::ID),
        Errors::InvalidSwapPath
    );

    // Exact-output mode: calculate required SOL using get_amounts_in().
    let amounts = calculate_swap_amounts(
        &ctx.accounts.amm_program.key(),
        ctx.remaining_accounts,
        amount_out,
        amount_in_max,
        &path,
        deadline,
        false,
    )?;

    require_keys_eq!(
        ctx.accounts.to_token_account.mint,
        *path.last().unwrap(),
        Errors::InvalidSwapPath
    );

    // Wrap only the required amount of SOL, not amount_in_max.
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            SolTransfer {
                from: ctx.accounts.trader.to_account_info(),
                to: ctx.accounts.temporary_wsol_account.to_account_info(),
            },
        ),
        amounts[0],
    )?;

    token::sync_native(CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        SyncNative {
            account: ctx.accounts.temporary_wsol_account.to_account_info(),
        },
    ))?;

    // Transfer WSOL directly to the first pool.
    let first = &ctx.remaining_accounts[..5];

    let first_input_vault = if path[0] < path[1] {
        first[3].clone()
    } else {
        first[4].clone()
    };

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.temporary_wsol_account.to_account_info(),
                to: first_input_vault,
                authority: ctx.accounts.trader.to_account_info(),
            },
        ),
        amounts[0],
    )?;

    // Execute the multi-hop swaps.
    execute_swap_hops(
        ctx.accounts.trader.to_account_info(),
        ctx.accounts.temporary_wsol_account.to_account_info(),
        ctx.accounts.to_token_account.to_account_info(),
        ctx.accounts.amm_program.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        ctx.remaining_accounts,
        &path,
        &amounts,
    )?;

    // Close the empty WSOL account and refund its rent.
    token::close_account(CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.temporary_wsol_account.to_account_info(),
            destination: ctx.accounts.trader.to_account_info(),
            authority: ctx.accounts.trader.to_account_info(),
        },
    ))?;

    Ok(amounts)
}

#[derive(Accounts)]
pub struct SwapSolForExactTokens<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(
        init,
        payer = trader,
        token::mint = wsol_mint,
        token::authority = trader,
    )]
    pub temporary_wsol_account: Box<Account<'info, TokenAccount>>,

    #[account(
        address = anchor_spl::token::spl_token::native_mint::ID
    )]
    pub wsol_mint: Account<'info, Mint>,

    #[account(mut)]
    pub to_token_account: Account<'info, TokenAccount>,

    pub amm_program: Program<'info, solana_v2_amm::program::SolanaV2Amm>,

    pub token_program: Program<'info, Token>,

    pub system_program: Program<'info, System>,
}
