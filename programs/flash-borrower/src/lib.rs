use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("BceaKYr4FsKAcFQwqR98N4E1wmxWcXaMfa7sNL32bwfT");

#[program]
pub mod flash_borrower {
    use super::*;

    pub fn flash_swap_callback(
        ctx: Context<FlashSwapCallback>,
        repayment_amount: u64,
    ) -> Result<()> {
        let cpi_accounts = Transfer {
            from: ctx.accounts.to_account_a.to_account_info(),
            to: ctx.accounts.pool_account_a.to_account_info(),
            authority: ctx.accounts.trader.to_account_info(),
        };

        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);

        token::transfer(cpi_ctx, repayment_amount)?;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct FlashSwapCallback<'info> {
    pub trader: Signer<'info>,

    pub mint_a: Account<'info, Mint>,
    pub mint_b: Account<'info, Mint>,

    #[account(
        mut,
        token::mint = mint_a,
        token::authority = trader,
    )]
    pub to_account_a: Account<'info, TokenAccount>,

    #[account(mut)]
    pub to_account_b: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = mint_a,
    )]
    pub pool_account_a: Account<'info, TokenAccount>,

    #[account(mut)]
    pub pool_account_b: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}
