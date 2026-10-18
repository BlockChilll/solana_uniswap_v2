use crate::{
    constants::{AMM_CONFIG_SEED, LOCKED_LP_SEED, LP_MINT_SEED, MINIMUM_LIQUIDITY, POOL_SEED},
    errors::Errors,
    events::MintLiquidity,
    helpers::{mint_fee, update},
    state::{AmmConfig, Pool},
};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};
use std::cmp::min;

pub fn mint(ctx: Context<MintLp>) -> Result<()> {
    let reserve_a = ctx.accounts.pool.reserve_a;
    let reserve_b = ctx.accounts.pool.reserve_b;
    let balance_a = ctx.accounts.pool_account_a.amount;
    let balance_b = ctx.accounts.pool_account_b.amount;

    let amount_a = balance_a
        .checked_sub(reserve_a)
        .ok_or(Errors::InsufficientVaultBalance)?;

    let amount_b = balance_b
        .checked_sub(reserve_b)
        .ok_or(Errors::InsufficientVaultBalance)?;

    let is_fee_on = mint_fee(
        &mut ctx.accounts.pool,
        &ctx.accounts.amm_config,
        &ctx.accounts.mint_lp,
        ctx.accounts.fee_to_lp_account.as_ref(),
        &ctx.accounts.token_program,
    )?;

    ctx.accounts.mint_lp.reload()?;
    let total_supply = ctx.accounts.mint_lp.supply;
    let pool = &mut ctx.accounts.pool;

    let bump = [pool.bump];
    let signer_seeds: &[&[u8]] = &[POOL_SEED, pool.mint_a.as_ref(), pool.mint_b.as_ref(), &bump];
    let signer = &[signer_seeds];

    let liquidity: u128 = if total_supply == 0 {
        let liquidity = ((amount_a as u128) * (amount_b as u128))
            .isqrt()
            .checked_sub(MINIMUM_LIQUIDITY as u128)
            .ok_or(Errors::InsufficientLiquidityMinted)?;

        let cpi_accounts = MintTo {
            mint: ctx.accounts.mint_lp.to_account_info(),
            to: ctx.accounts.locked_lp_account.to_account_info(),
            authority: pool.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer,
        );
        token::mint_to(cpi_ctx, MINIMUM_LIQUIDITY)?;

        liquidity
    } else {
        min(
            (amount_a as u128) * (total_supply as u128) / (reserve_a as u128),
            (amount_b as u128) * (total_supply as u128) / (reserve_b as u128),
        )
    };

    require!(liquidity > 0, Errors::InsufficientLiquidityMinted);

    let cpi_accounts = MintTo {
        mint: ctx.accounts.mint_lp.to_account_info(),
        to: ctx.accounts.to_lp_account.to_account_info(),
        authority: pool.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts,
        signer,
    );

    let liquidity: u64 = u64::try_from(liquidity).map_err(|_| ProgramError::ArithmeticOverflow)?;
    token::mint_to(cpi_ctx, liquidity)?;

    let pool_key = pool.key();
    update(pool, pool_key, balance_a, balance_b, reserve_a, reserve_b)?;

    if is_fee_on {
        pool.k_last = (pool.reserve_a as u128) * (pool.reserve_b as u128);
    }

    emit!(MintLiquidity {
        pool: pool.key(),
        provider: ctx.accounts.provider.key(),
        amount_a,
        amount_b,
        liquidity,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct MintLp<'info> {
    #[account(
        seeds = [
            AMM_CONFIG_SEED
        ],
        bump,
    )]
    pub amm_config: Account<'info, AmmConfig>,

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
        associated_token::mint = mint_a,
        associated_token::authority = pool,
    )]
    pub pool_account_a: Box<Account<'info, TokenAccount>>,

    #[account(
        associated_token::mint = mint_b,
        associated_token::authority = pool,
    )]
    pub pool_account_b: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [LOCKED_LP_SEED, pool.key().as_ref()],
        bump,
        token::mint = mint_lp,
        token::authority = pool,
    )]
    pub locked_lp_account: Account<'info, TokenAccount>,

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
        associated_token::authority = amm_config.fee_to,
    )]
    pub fee_to_lp_account: Option<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = mint_lp,
    )]
    pub to_lp_account: Account<'info, TokenAccount>,

    pub provider: Signer<'info>,
    pub token_program: Program<'info, Token>,
}
