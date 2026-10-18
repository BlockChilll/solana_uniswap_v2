use crate::events::PoolCreated;
use crate::{
    constants::{LOCKED_LP_SEED, LP_MINT_SEED, POOL_SEED},
    errors::*,
    state::Pool,
};
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};

pub fn create_pool(ctx: Context<CreatePool>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;

    pool.bump = ctx.bumps.pool;
    pool.mint_a = ctx.accounts.mint_a.key();
    pool.mint_b = ctx.accounts.mint_b.key();
    pool.reserve_a = 0;
    pool.reserve_b = 0;
    pool.k_last = 0;
    pool.price_a_cumulative_last = [0; 4];
    pool.price_b_cumulative_last = [0; 4];

    let timestamp = Clock::get()?.unix_timestamp;
    pool.block_timestamp_last = timestamp as u32;

    emit!(PoolCreated {
        pool: pool.key(),
        mint_a: pool.mint_a,
        mint_b: pool.mint_b,
        mint_lp: ctx.accounts.mint_lp.key(),
    });

    Ok(())
}

#[derive(Accounts)]
pub struct CreatePool<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Pool::INIT_SPACE,
        seeds = [
            POOL_SEED,
            mint_a.key().as_ref(),
            mint_b.key().as_ref(),
        ],
        bump
    )]
    pub pool: Box<Account<'info, Pool>>,

    #[account(
        constraint = mint_a.key() < mint_b.key()
            @ Errors::InvalidMintOrder
    )]
    pub mint_a: Account<'info, Mint>,
    pub mint_b: Account<'info, Mint>,

    #[account(
        init,
        payer = payer,
        seeds = [
            LP_MINT_SEED,
            pool.key().as_ref(),
        ],
        bump,
        mint::decimals = 6,
        mint::authority = pool,
    )]
    pub mint_lp: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = payer,
        associated_token::mint = mint_a,
        associated_token::authority = pool,
    )]
    pub pool_account_a: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = payer,
        associated_token::mint = mint_b,
        associated_token::authority = pool,
    )]
    pub pool_account_b: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = payer,
        associated_token::mint = mint_lp,
        associated_token::authority = pool,
    )]
    pub pool_account_lp: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = payer,
        seeds = [LOCKED_LP_SEED, pool.key().as_ref()],
        bump,
        token::mint = mint_lp,
        token::authority = pool,
    )]
    pub locked_lp_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
