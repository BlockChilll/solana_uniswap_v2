use crate::{
    constants::POOL_SEED, errors::Errors, events::Swap, helpers::update, math::U256, state::Pool,
};
use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        program::invoke,
    },
};
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

pub fn swap<'info>(
    ctx: Context<'_, '_, '_, 'info, SwapAccounts<'info>>,
    amount_a_out: u64,
    amount_b_out: u64,
    callback_data: Vec<u8>,
) -> Result<()> {
    require!(
        amount_a_out > 0 || amount_b_out > 0,
        Errors::InsufficientOutputAmount
    );

    let reserve_a = ctx.accounts.pool.reserve_a;
    let reserve_b = ctx.accounts.pool.reserve_b;

    require!(
        amount_a_out < reserve_a && amount_b_out < reserve_b,
        Errors::InsufficientLiquidity
    );

    let pool = &mut ctx.accounts.pool;

    let bump = [pool.bump];
    let signer_seeds: &[&[u8]] = &[POOL_SEED, pool.mint_a.as_ref(), pool.mint_b.as_ref(), &bump];
    let signer = &[signer_seeds];

    if amount_a_out > 0 {
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
        token::transfer(cpi_ctx, amount_a_out)?;
    }

    if amount_b_out > 0 {
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
        token::transfer(cpi_ctx, amount_b_out)?;
    }

    // Flash loan callback start
    if !callback_data.is_empty() {
        let callback_program = ctx
            .accounts
            .callback_program
            .as_ref()
            .ok_or(Errors::MissingCallbackProgram)?;

        let mut callback_accounts = vec![
            ctx.accounts.trader.to_account_info(),
            ctx.accounts.mint_a.to_account_info(),
            ctx.accounts.mint_b.to_account_info(),
            ctx.accounts.to_account_a.to_account_info(),
            ctx.accounts.to_account_b.to_account_info(),
            ctx.accounts.pool_account_a.to_account_info(),
            ctx.accounts.pool_account_b.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
        ];

        callback_accounts.extend_from_slice(ctx.remaining_accounts);

        let account_metas: Vec<AccountMeta> = callback_accounts
            .iter()
            .map(|account| {
                let is_signer = account.is_signer;

                if account.is_writable {
                    AccountMeta::new(account.key(), is_signer)
                } else {
                    AccountMeta::new_readonly(account.key(), is_signer)
                }
            })
            .collect();

        let callback_ix = Instruction {
            program_id: callback_program.key(),
            accounts: account_metas,
            data: callback_data,
        };

        let mut invoke_accounts = callback_accounts.clone();
        invoke_accounts.push(callback_program.to_account_info());

        invoke(&callback_ix, &invoke_accounts)?;
    }
    // Flash loan callback end

    ctx.accounts.pool_account_a.reload()?;
    ctx.accounts.pool_account_b.reload()?;

    let balance_a = ctx.accounts.pool_account_a.amount;
    let balance_b = ctx.accounts.pool_account_b.amount;

    let amount_a_in = if balance_a > (reserve_a - amount_a_out) {
        balance_a - (reserve_a - amount_a_out)
    } else {
        0
    };
    let amount_b_in = if balance_b > (reserve_b - amount_b_out) {
        balance_b - (reserve_b - amount_b_out)
    } else {
        0
    };
    require!(
        amount_a_in > 0 || amount_b_in > 0,
        Errors::InsufficientInputAmount
    );

    let balance_a_adjusted = (balance_a as u128) * 1000 - (amount_a_in as u128) * 3;
    let balance_b_adjusted = (balance_b as u128) * 1000 - (amount_b_in as u128) * 3;

    let new_k = U256::from(balance_a_adjusted) * U256::from(balance_b_adjusted);
    let old_k = U256::from(reserve_a as u128 * reserve_b as u128) * U256::from(1_000_000u64);

    require!(new_k >= old_k, Errors::InvalidNewK);

    let pool_key = pool.key();
    update(pool, pool_key, balance_a, balance_b, reserve_a, reserve_b)?;

    emit!(Swap {
        pool: pool.key(),
        trader: ctx.accounts.trader.key(),
        amount_a_in,
        amount_b_in,
        amount_a_out,
        amount_b_out,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct SwapAccounts<'info> {
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

    pub trader: Signer<'info>,
    pub token_program: Program<'info, Token>,

    /// CHECK: Validated as executable and used only as a CPI target.
    #[account(executable)]
    pub callback_program: Option<UncheckedAccount<'info>>,
}
