use crate::{
    constants::{AMM_CONFIG_SEED, LP_MINT_SEED, POOL_SEED},
    errors::Errors,
    events::BurnLiquidity,
    helpers::{mint_fee, update},
    state::{AmmConfig, Pool},
};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};

pub fn burn(ctx: Context<BurnLp>) -> Result<()> {
    let reserve_a = ctx.accounts.pool.reserve_a;
    let reserve_b = ctx.accounts.pool.reserve_b;
    let balance_a = ctx.accounts.pool_account_a.amount;
    let balance_b = ctx.accounts.pool_account_b.amount;
    let liquidity = ctx.accounts.pool_account_lp.amount;

    let is_fee_on = mint_fee(
        &mut ctx.accounts.pool,
        &ctx.accounts.amm_config,
        &ctx.accounts.mint_lp,
        ctx.accounts.fee_to_lp_account.as_deref(),
        &ctx.accounts.token_program,
    )?;

    ctx.accounts.mint_lp.reload()?;
    let total_supply = ctx.accounts.mint_lp.supply;
    let pool = &mut ctx.accounts.pool;

    let amount_a = (liquidity as u128) * (balance_a as u128) / (total_supply as u128);
    let amount_b = (liquidity as u128) * (balance_b as u128) / (total_supply as u128);

    require!(
        amount_a > 0 && amount_b > 0,
        Errors::InsufficientLiquidityBurned
    );

    let bump = [pool.bump];
    let signer_seeds: &[&[u8]] = &[POOL_SEED, pool.mint_a.as_ref(), pool.mint_b.as_ref(), &bump];
    let signer = &[signer_seeds];

    // burn liquidity
    let cpi_accounts = Burn {
        mint: ctx.accounts.mint_lp.to_account_info(),
        from: ctx.accounts.pool_account_lp.to_account_info(),
        authority: pool.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts,
        signer,
    );
    token::burn(cpi_ctx, liquidity)?;

    // transfer token a
    let amount_a = u64::try_from(amount_a).map_err(|_| ProgramError::ArithmeticOverflow)?;
    let cpi_accounts = Transfer {
        to: ctx.accounts.to_account_a.to_account_info(),
        from: ctx.accounts.pool_account_a.to_account_info(),
        authority: pool.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts,
        signer,
    );
    token::transfer(cpi_ctx, amount_a)?;

    // transfer token b
    let amount_b = u64::try_from(amount_b).map_err(|_| ProgramError::ArithmeticOverflow)?;
    let cpi_accounts = Transfer {
        to: ctx.accounts.to_account_b.to_account_info(),
        from: ctx.accounts.pool_account_b.to_account_info(),
        authority: pool.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts,
        signer,
    );
    token::transfer(cpi_ctx, amount_b)?;

    ctx.accounts.pool_account_a.reload()?;
    ctx.accounts.pool_account_b.reload()?;

    let balance_a = ctx.accounts.pool_account_a.amount;
    let balance_b = ctx.accounts.pool_account_b.amount;

    let pool_key = pool.key();
    update(pool, pool_key, balance_a, balance_b, reserve_a, reserve_b)?;

    if is_fee_on {
        pool.k_last = (pool.reserve_a as u128) * (pool.reserve_b as u128);
    }

    emit!(BurnLiquidity {
        pool: pool.key(),
        provider: ctx.accounts.provider.key(),
        amount_a,
        amount_b,
        liquidity,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct BurnLp<'info> {
    #[account(
        seeds = [
            AMM_CONFIG_SEED
        ],
        bump,
    )]
    pub amm_config: Box<Account<'info, AmmConfig>>,

    #[account(
        mut,
        seeds = [
            POOL_SEED,
            mint_a.key().as_ref(),
            mint_b.key().as_ref(),
        ],
        bump,
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
        seeds = [
            LP_MINT_SEED,
            pool.key().as_ref(),
        ],
        bump,
        mint::authority = pool,
    )]
    pub mint_lp: Box<Account<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = mint_lp,
        associated_token::authority = pool,
    )]
    pub pool_account_lp: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = mint_lp,
        associated_token::authority = amm_config.fee_to,
    )]
    pub fee_to_lp_account: Option<Box<Account<'info, TokenAccount>>>,

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
