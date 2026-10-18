use anchor_lang::{
    prelude::*,
    system_program::{self, Transfer as SystemTransfer},
};
use anchor_spl::token::{
    self, spl_token::native_mint, CloseAccount, Mint, Token, TokenAccount, Transfer,
};
use solana_v2_amm::{
    self,
    constants::{AMM_CONFIG_SEED, LP_MINT_SEED, POOL_SEED},
    cpi::accounts::BurnLp,
    errors::Errors as AmmErrors,
    state::{AmmConfig, Pool},
};

use crate::errors::Errors;

pub fn remove_liquidity_sol(
    ctx: Context<RemoveLiquiditySol>,
    liquidity: u64,
    amount_token_min: u64,
    amount_sol_min: u64,
    deadline: i64,
) -> Result<()> {
    require!(Clock::get()?.unix_timestamp <= deadline, Errors::Expired);

    let is_sol_a = ctx.accounts.mint_a.key() == native_mint::id();

    // 1. Transfer LP tokens into the pool.
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

    // 2. Capture balances before the burn.
    let token_before = ctx.accounts.to_token_account.amount;
    let wsol_before = ctx.accounts.temporary_wsol_account.amount;

    // Map recipient accounts to canonical A/B order.
    let (to_account_a, to_account_b) = if is_sol_a {
        (
            ctx.accounts.temporary_wsol_account.to_account_info(),
            ctx.accounts.to_token_account.to_account_info(),
        )
    } else {
        (
            ctx.accounts.to_token_account.to_account_info(),
            ctx.accounts.temporary_wsol_account.to_account_info(),
        )
    };

    // 3. Burn LP tokens through the AMM core.
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
        to_account_a,
        to_account_b,
        provider: ctx.accounts.provider.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
    };

    solana_v2_amm::cpi::burn(CpiContext::new(
        ctx.accounts.amm_program.to_account_info(),
        cpi_accounts,
    ))?;

    // 4. Reload balances modified by the AMM CPI.
    ctx.accounts.to_token_account.reload()?;
    ctx.accounts.temporary_wsol_account.reload()?;

    let amount_token = ctx
        .accounts
        .to_token_account
        .amount
        .checked_sub(token_before)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    let amount_sol = ctx
        .accounts
        .temporary_wsol_account
        .amount
        .checked_sub(wsol_before)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    // 5. Enforce minimum received amounts.
    require!(
        amount_token >= amount_token_min,
        Errors::InsufficientAmountA
    );
    require!(amount_sol >= amount_sol_min, Errors::InsufficientAmountB);

    // 6. Unwrap WSOL.
    // Closing the account returns withdrawn SOL + rent to provider.
    token::close_account(CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.temporary_wsol_account.to_account_info(),
            destination: ctx.accounts.provider.to_account_info(),
            authority: ctx.accounts.provider.to_account_info(),
        },
    ))?;

    // 7. Forward exactly the withdrawn SOL to the recipient.
    // The provider retains the refunded rent.
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            SystemTransfer {
                from: ctx.accounts.provider.to_account_info(),
                to: ctx.accounts.sol_recipient.to_account_info(),
            },
        ),
        amount_sol,
    )?;

    Ok(())
}

#[derive(Accounts)]
pub struct RemoveLiquiditySol<'info> {
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
        constraint = (
            mint_a.key() == native_mint::id()
            || mint_b.key() == native_mint::id()
        ) @ Errors::InvalidSolMint,
    )]
    pub mint_a: Box<Account<'info, Mint>>,

    pub mint_b: Box<Account<'info, Mint>>,

    // Required to initialize the temporary WSOL account.
    #[account(
        address = native_mint::ID @ Errors::InvalidSolMint,
    )]
    pub mint_sol: Box<Account<'info, Mint>>,

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

    // Arbitrary non-WSOL token recipient.
    #[account(
        mut,
        constraint = to_token_account.mint ==
            if mint_a.key() == native_mint::id() {
                mint_b.key()
            } else {
                mint_a.key()
            } @ Errors::InvalidTokenMint,
    )]
    pub to_token_account: Box<Account<'info, TokenAccount>>,

    // Fresh keypair-backed temporary WSOL account.
    #[account(
        init,
        payer = provider,
        token::mint = mint_sol,
        token::authority = provider,
    )]
    pub temporary_wsol_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: Receives native SOL only.
    #[account(mut)]
    pub sol_recipient: UncheckedAccount<'info>,

    #[account(mut)]
    pub provider: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
