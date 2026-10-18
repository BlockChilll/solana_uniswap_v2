use crate::{constants::POOL_SEED, errors::Errors, helpers::update, state::Pool};
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, TokenAccount};

pub fn sync(ctx: Context<Sync>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;

    let reserve_a = pool.reserve_a;
    let reserve_b = pool.reserve_b;

    let balance_a = ctx.accounts.pool_account_a.amount;
    let balance_b = ctx.accounts.pool_account_b.amount;

    let pool_key = pool.key();

    update(pool, pool_key, balance_a, balance_b, reserve_a, reserve_b)?;

    Ok(())
}

#[derive(Accounts)]
pub struct Sync<'info> {
    #[account(
        mut,
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
        associated_token::mint = mint_a,
        associated_token::authority = pool,
    )]
    pub pool_account_a: Box<Account<'info, TokenAccount>>,

    #[account(
        associated_token::mint = mint_b,
        associated_token::authority = pool,
    )]
    pub pool_account_b: Box<Account<'info, TokenAccount>>,
}
