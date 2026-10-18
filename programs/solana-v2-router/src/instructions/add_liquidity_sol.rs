use anchor_lang::{
    prelude::*,
    system_program::{self, Transfer as SystemTransfer},
};
use anchor_spl::token::{
    self, spl_token::native_mint, CloseAccount, Mint, SyncNative, Token, TokenAccount, Transfer,
};
use solana_v2_amm::{
    self,
    constants::{AMM_CONFIG_SEED, LOCKED_LP_SEED, LP_MINT_SEED, POOL_SEED},
    cpi::accounts::MintLp,
    errors::Errors as AmmErrors,
    state::{AmmConfig, Pool},
};

use crate::{errors::Errors, math::calculate_liquidity_amounts};

pub fn add_liquidity_sol(
    ctx: Context<AddLiquiditySol>,
    amount_token_desired: u64,
    amount_token_min: u64,
    amount_sol_min: u64,
    max_sol: u64,
    deadline: i64,
) -> Result<()> {
    require!(Clock::get()?.unix_timestamp <= deadline, Errors::Expired);

    let is_sol_a = ctx.accounts.mint_a.key() == native_mint::id();

    // Map token/SOL inputs to canonical A/B order.
    let (desired_a, desired_b, min_a, min_b) = if is_sol_a {
        (
            max_sol,
            amount_token_desired,
            amount_sol_min,
            amount_token_min,
        )
    } else {
        (
            amount_token_desired,
            max_sol,
            amount_token_min,
            amount_sol_min,
        )
    };

    let (amount_a, amount_b) = calculate_liquidity_amounts(
        desired_a,
        desired_b,
        min_a,
        min_b,
        ctx.accounts.pool.reserve_a,
        ctx.accounts.pool.reserve_b,
    )?;

    let (amount_sol, amount_token) = if is_sol_a {
        (amount_a, amount_b)
    } else {
        (amount_b, amount_a)
    };

    require!(
        amount_sol > 0 && amount_token > 0,
        Errors::InsufficientAmount
    );

    let pool_token_account = if is_sol_a {
        &ctx.accounts.pool_account_b
    } else {
        &ctx.accounts.pool_account_a
    };

    let pool_sol_account = if is_sol_a {
        &ctx.accounts.pool_account_a
    } else {
        &ctx.accounts.pool_account_b
    };

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_token_account.to_account_info(),
                to: pool_token_account.to_account_info(),
                authority: ctx.accounts.provider.to_account_info(),
            },
        ),
        amount_token,
    )?;

    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            SystemTransfer {
                from: ctx.accounts.provider.to_account_info(),
                to: ctx.accounts.temporary_wsol_account.to_account_info(),
            },
        ),
        amount_sol,
    )?;

    token::sync_native(CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        SyncNative {
            account: ctx.accounts.temporary_wsol_account.to_account_info(),
        },
    ))?;

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.temporary_wsol_account.to_account_info(),
                to: pool_sol_account.to_account_info(),
                authority: ctx.accounts.provider.to_account_info(),
            },
        ),
        amount_sol,
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

    token::close_account(CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.temporary_wsol_account.to_account_info(),
            destination: ctx.accounts.provider.to_account_info(),
            authority: ctx.accounts.provider.to_account_info(),
        },
    ))?;

    Ok(())
}

#[derive(Accounts)]
pub struct AddLiquiditySol<'info> {
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
            @ AmmErrors::InvalidMintOrder,
        constraint = (
            mint_a.key() == native_mint::id()
            || mint_b.key() == native_mint::id()
        ) @ Errors::InvalidSolMint,
    )]
    pub mint_a: Box<Account<'info, Mint>>,

    pub mint_b: Box<Account<'info, Mint>>,

    // Needed to initialize the temporary WSOL token account.
    #[account(
        address = native_mint::ID @ Errors::InvalidSolMint,
        constraint = (
            mint_sol.key() == mint_a.key()
            || mint_sol.key() == mint_b.key()
        ) @ Errors::InvalidSolMint,
    )]
    pub mint_sol: Box<Account<'info, Mint>>,

    #[account(
        mut,
        token::authority = provider,
        constraint = user_token_account.mint ==
            if mint_a.key() == native_mint::id() {
                mint_b.key()
            } else {
                mint_a.key()
            } @ Errors::InvalidTokenMint,
    )]
    pub user_token_account: Box<Account<'info, TokenAccount>>,

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
        seeds = [LOCKED_LP_SEED, pool.key().as_ref()],
        bump,
        seeds::program = amm_program.key(),
        token::mint = mint_lp,
        token::authority = pool,
    )]
    pub locked_lp_account: Box<Account<'info, TokenAccount>>,

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

    #[account(
        mut,
        token::mint = mint_lp,
    )]
    pub to_lp_account: Box<Account<'info, TokenAccount>>,

    // Fresh keypair-backed token account.
    // The provider owns its tokens and pays its rent.
    #[account(
        init,
        payer = provider,
        token::mint = mint_sol,
        token::authority = provider,
    )]
    pub temporary_wsol_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub provider: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
