use anchor_lang::{
    prelude::*,
    system_program::{self, Transfer as SolTransfer},
};
use anchor_spl::token::{self, CloseAccount, Mint, SyncNative, Token, TokenAccount, Transfer};

use crate::{
    errors::Errors,
    helpers::{calculate_swap_amounts, execute_swap_hops},
};

pub fn swap_exact_sol_for_tokens<'info>(
    ctx: Context<'_, '_, '_, 'info, SwapExactSolForTokens<'info>>,
    amount_in: u64,
    amount_out_min: u64,
    path: Vec<Pubkey>,
    deadline: i64,
) -> Result<Vec<u64>> {
    require!(
        path.first() == Some(&anchor_spl::token::spl_token::native_mint::ID),
        Errors::InvalidSwapPath
    );

    let amounts = calculate_swap_amounts(
        &ctx.accounts.amm_program.key(),
        ctx.remaining_accounts,
        amount_in,
        amount_out_min,
        &path,
        deadline,
        true,
    )?;

    // Transfer native SOL into the WSOL token account.
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

    // Synchronize the token balance with the lamports.
    token::sync_native(CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        SyncNative {
            account: ctx.accounts.temporary_wsol_account.to_account_info(),
        },
    ))?;

    // Transfer WSOL to the first pool's input vault.
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

    // Execute the same multi-hop logic as token swaps.
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

    // Close the temporary WSOL account, refunding rent.
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
pub struct SwapExactSolForTokens<'info> {
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
