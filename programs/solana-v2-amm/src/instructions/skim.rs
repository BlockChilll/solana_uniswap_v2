use crate::{constants::POOL_SEED, errors::Errors, state::Pool};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

pub fn skim(ctx: Context<Skim>) -> Result<()> {
    let pool = &ctx.accounts.pool;

    let excess_a = ctx
        .accounts
        .pool_account_a
        .amount
        .checked_sub(pool.reserve_a)
        .ok_or(Errors::InsufficientLiquidity)?;

    let excess_b = ctx
        .accounts
        .pool_account_b
        .amount
        .checked_sub(pool.reserve_b)
        .ok_or(Errors::InsufficientLiquidity)?;

    let bump = [pool.bump];

    let signer_seeds: &[&[u8]] = &[POOL_SEED, pool.mint_a.as_ref(), pool.mint_b.as_ref(), &bump];

    let signer = &[signer_seeds];

    if excess_a > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.pool_account_a.to_account_info(),
                    to: ctx.accounts.to_account_a.to_account_info(),
                    authority: pool.to_account_info(),
                },
                signer,
            ),
            excess_a,
        )?;
    }

    if excess_b > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.pool_account_b.to_account_info(),
                    to: ctx.accounts.to_account_b.to_account_info(),
                    authority: pool.to_account_info(),
                },
                signer,
            ),
            excess_b,
        )?;
    }

    Ok(())
}

#[derive(Accounts)]
pub struct Skim<'info> {
    #[account(
        seeds = [
            POOL_SEED,
            mint_a.key().as_ref(),
            mint_b.key().as_ref(),
        ],
        bump = pool.bump,
        has_one = mint_a,
        has_one = mint_b,
    )]
    pub pool: Box<Account<'info, Pool>>,

    #[account(
        constraint = mint_a.key() < mint_b.key()
            @ Errors::InvalidMintOrder
    )]
    pub mint_a: Box<Account<'info, Mint>>,

    pub mint_b: Box<Account<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = mint_a,
        associated_token::authority = pool,
    )]
    pub pool_account_a: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = mint_b,
        associated_token::authority = pool,
    )]
    pub pool_account_b: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = mint_a,
        constraint = to_account_a.key() != pool_account_a.key()
            @ Errors::InvalidRecipient,
    )]
    pub to_account_a: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = mint_b,
        constraint = to_account_b.key() != pool_account_b.key()
            @ Errors::InvalidRecipient,
    )]
    pub to_account_b: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}
