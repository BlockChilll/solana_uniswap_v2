use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use solana_v2_amm::{
    self,
    constants::{AMM_CONFIG_SEED, LP_MINT_SEED, POOL_SEED},
    cpi::accounts::BurnLp,
    errors::Errors as AmmErrors,
    state::{AmmConfig, Pool},
};

use crate::errors::Errors;

pub fn remove_liquidity(
    ctx: Context<RemoveLiquidity>,
    liquidity: u64,
    amount_a_min: u64,
    amount_b_min: u64,
    deadline: i64,
) -> Result<()> {
    require!(Clock::get()?.unix_timestamp <= deadline, Errors::Expired);

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_lp_account.to_account_info(),
                to: ctx.accounts.pool_account_lp.to_account_info(),
                authority: ctx.accounts.provider.to_account_info(),
            },
        ),
        liquidity,
    )?;

    // Capture recipient balances before the AMM burn.
    let balance_a_before = ctx.accounts.to_account_a.amount;
    let balance_b_before = ctx.accounts.to_account_b.amount;

    let cpi_accounts = BurnLp {
        amm_config: ctx.accounts.amm_config.to_account_info(),
        pool: ctx.accounts.pool.to_account_info(),
        mint_a: ctx.accounts.mint_a.to_account_info(),
        mint_b: ctx.accounts.mint_b.to_account_info(),
        pool_account_a: ctx.accounts.pool_account_a.to_account_info(),
        pool_account_b: ctx.accounts.pool_account_b.to_account_info(),
        mint_lp: ctx.accounts.mint_lp.to_account_info(),
        pool_account_lp: ctx.accounts.pool_account_lp.to_account_info(),
        fee_to_lp_account: ctx
            .accounts
            .fee_to_lp_account
            .as_ref()
            .map(|account| account.to_account_info()),
        to_account_a: ctx.accounts.to_account_a.to_account_info(),
        to_account_b: ctx.accounts.to_account_b.to_account_info(),
        provider: ctx.accounts.provider.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
    };

    solana_v2_amm::cpi::burn(CpiContext::new(
        ctx.accounts.amm_program.to_account_info(),
        cpi_accounts,
    ))?;

    // Reload because the AMM CPI modified the recipient accounts.
    ctx.accounts.to_account_a.reload()?;
    ctx.accounts.to_account_b.reload()?;

    let amount_a = ctx
        .accounts
        .to_account_a
        .amount
        .checked_sub(balance_a_before)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    let amount_b = ctx
        .accounts
        .to_account_b
        .amount
        .checked_sub(balance_b_before)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    require!(amount_a >= amount_a_min, Errors::InsufficientAmountA);
    require!(amount_b >= amount_b_min, Errors::InsufficientAmountB);

    Ok(())
}

#[derive(Accounts)]
pub struct RemoveLiquidity<'info> {
    pub amm_program: Program<'info, solana_v2_amm::program::SolanaV2Amm>,

    #[account(
        seeds = [AMM_CONFIG_SEED],
        bump,
        seeds::program = amm_program.key(),
    )]
    pub amm_config: Box<Account<'info, AmmConfig>>,

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
            @ AmmErrors::InvalidMintOrder,
    )]
    pub mint_a: Box<Account<'info, Mint>>,

    pub mint_b: Box<Account<'info, Mint>>,

    #[account(
        mut,
        token::mint = mint_lp,
        token::authority = provider,
    )]
    pub user_lp_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = mint_lp,
        associated_token::authority = pool,
    )]
    pub pool_account_lp: Box<Account<'info, TokenAccount>>,

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
        seeds = [LP_MINT_SEED, pool.key().as_ref()],
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

    // Arbitrary recipient token accounts, matching core burn().
    #[account(
        mut,
        token::mint = mint_a,
    )]
    pub to_account_a: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = mint_b,
    )]
    pub to_account_b: Box<Account<'info, TokenAccount>>,

    pub provider: Signer<'info>,
    pub token_program: Program<'info, Token>,
}
