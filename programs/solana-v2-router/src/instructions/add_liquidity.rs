use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use solana_v2_amm::{self, cpi::accounts::MintLp};

use solana_v2_amm::{
    constants::{AMM_CONFIG_SEED, LOCKED_LP_SEED, LP_MINT_SEED, POOL_SEED},
    errors::Errors as AmmErrors,
    state::{AmmConfig, Pool},
};

use crate::{errors::Errors, math::calculate_liquidity_amounts};

pub fn add_liquidity(
    ctx: Context<AddLiquidity>,
    amount_a_desired: u64,
    amount_b_desired: u64,
    amount_a_min: u64,
    amount_b_min: u64,
    deadline: i64,
) -> Result<()> {
    require!(Clock::get()?.unix_timestamp <= deadline, Errors::Expired);

    let pool = &ctx.accounts.pool;

    let (amount_a, amount_b) = calculate_liquidity_amounts(
        amount_a_desired,
        amount_b_desired,
        amount_a_min,
        amount_b_min,
        pool.reserve_a,
        pool.reserve_b,
    )?;

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_account_a.to_account_info(),
                to: ctx.accounts.pool_account_a.to_account_info(),
                authority: ctx.accounts.provider.to_account_info(),
            },
        ),
        amount_a,
    )?;

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_account_b.to_account_info(),
                to: ctx.accounts.pool_account_b.to_account_info(),
                authority: ctx.accounts.provider.to_account_info(),
            },
        ),
        amount_b,
    )?;

    let cpi_accounts = MintLp {
        amm_config: ctx.accounts.amm_config.to_account_info(),
        pool: ctx.accounts.pool.to_account_info(),
        mint_a: ctx.accounts.mint_a.to_account_info(),
        mint_b: ctx.accounts.mint_b.to_account_info(),
        pool_account_a: ctx.accounts.pool_account_a.to_account_info(),
        pool_account_b: ctx.accounts.pool_account_b.to_account_info(),
        locked_lp_account: ctx.accounts.locked_lp_account.to_account_info(),
        mint_lp: ctx.accounts.mint_lp.to_account_info(),
        fee_to_lp_account: ctx
            .accounts
            .fee_to_lp_account
            .as_ref()
            .map(|account| account.to_account_info()),
        to_lp_account: ctx.accounts.to_lp_account.to_account_info(),
        provider: ctx.accounts.provider.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
    };

    solana_v2_amm::cpi::mint(CpiContext::new(
        ctx.accounts.amm_program.to_account_info(),
        cpi_accounts,
    ))?;

    Ok(())
}

#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    pub amm_program: Program<'info, solana_v2_amm::program::SolanaV2Amm>,

    #[account(
        seeds = [AMM_CONFIG_SEED],
        bump,
        seeds::program = amm_program.key(),
    )]
    pub amm_config: Account<'info, AmmConfig>,

    #[account(
        mut,
        seeds = [
            POOL_SEED,
            mint_a.key().as_ref(),
            mint_b.key().as_ref(),
        ],
        bump = pool.bump,
        seeds::program = amm_program.key(),
        has_one = mint_a,
        has_one = mint_b,
    )]
    pub pool: Box<Account<'info, Pool>>,

    #[account(
        constraint = mint_a.key() < mint_b.key()
            @ AmmErrors::InvalidMintOrder
    )]
    pub mint_a: Box<Account<'info, Mint>>,

    pub mint_b: Box<Account<'info, Mint>>,

    #[account(
        mut,
        token::mint = mint_a,
        token::authority = provider,
    )]
    pub user_account_a: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = mint_b,
        token::authority = provider,
    )]
    pub user_account_b: Box<Account<'info, TokenAccount>>,

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
        seeds = [
            LOCKED_LP_SEED,
            pool.key().as_ref(),
        ],
        bump,
        seeds::program = amm_program.key(),
        token::mint = mint_lp,
        token::authority = pool,
    )]
    pub locked_lp_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [
            LP_MINT_SEED,
            pool.key().as_ref(),
        ],
        bump,
        seeds::program = amm_program.key(),
        mint::authority = pool,
    )]
    pub mint_lp: Box<Account<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = mint_lp,
        associated_token::authority = amm_config.fee_to,
    )]
    pub fee_to_lp_account: Option<Box<Account<'info, TokenAccount>>>,

    #[account(
        mut,
        token::mint = mint_lp,
    )]
    pub to_lp_account: Box<Account<'info, TokenAccount>>,

    pub provider: Signer<'info>,

    pub token_program: Program<'info, Token>,
}
