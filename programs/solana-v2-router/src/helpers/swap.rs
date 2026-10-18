use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::get_associated_token_address,
    token::{self, TokenAccount, Transfer},
};
use solana_v2_amm::{
    self, constants::POOL_SEED, cpi::accounts::SwapAccounts as AmmSwapAccounts, state::Pool,
};

use crate::{
    errors::Errors,
    math::{get_amounts_in, get_amounts_out},
};

const ACCOUNTS_PER_HOP: usize = 5;

// remaining_accounts, repeated for each hop:
// [pool, mint_a, mint_b, pool_account_a, pool_account_b]

fn hop<'a, 'info>(accounts: &'a [AccountInfo<'info>], i: usize) -> &'a [AccountInfo<'info>] {
    let start = i * ACCOUNTS_PER_HOP;
    &accounts[start..start + ACCOUNTS_PER_HOP]
}

fn input_vault<'info>(
    current: &[AccountInfo<'info>],
    input: Pubkey,
    output: Pubkey,
) -> AccountInfo<'info> {
    if input < output {
        current[3].clone()
    } else {
        current[4].clone()
    }
}

fn output_vault<'info>(
    current: &[AccountInfo<'info>],
    input: Pubkey,
    output: Pubkey,
) -> AccountInfo<'info> {
    if input < output {
        current[4].clone()
    } else {
        current[3].clone()
    }
}

fn output_destination<'info>(
    accounts: &[AccountInfo<'info>],
    path: &[Pubkey],
    i: usize,
    recipient: &AccountInfo<'info>,
) -> AccountInfo<'info> {
    if i == path.len() - 2 {
        recipient.clone()
    } else {
        let next = hop(accounts, i + 1);
        input_vault(next, path[i + 1], path[i + 2])
    }
}

fn unused_destination<'info>(
    accounts: &[AccountInfo<'info>],
    path: &[Pubkey],
    i: usize,
    user_input: &AccountInfo<'info>,
) -> AccountInfo<'info> {
    if i == 0 {
        user_input.clone()
    } else {
        let previous = hop(accounts, i - 1);
        output_vault(previous, path[i - 1], path[i])
    }
}

pub fn validate_hops<'info>(
    accounts: &[AccountInfo<'info>],
    path: &[Pubkey],
    amm_program: &Pubkey,
) -> Result<()> {
    require!(path.len() >= 2, Errors::InvalidSwapPath);

    let hops = path.len() - 1;

    require!(
        accounts.len()
            == hops
                .checked_mul(ACCOUNTS_PER_HOP)
                .ok_or(ProgramError::ArithmeticOverflow)?,
        Errors::InvalidSwapAccounts
    );

    for i in 0..hops {
        let current = hop(accounts, i);

        let input = path[i];
        let output = path[i + 1];

        require_keys_neq!(input, output, Errors::InvalidSwapPath);

        let (mint_a, mint_b) = if input < output {
            (input, output)
        } else {
            (output, input)
        };

        require_keys_eq!(*current[1].key, mint_a, Errors::InvalidSwapAccounts);

        require_keys_eq!(*current[2].key, mint_b, Errors::InvalidSwapAccounts);

        let (expected_pool, _) = Pubkey::find_program_address(
            &[POOL_SEED, mint_a.as_ref(), mint_b.as_ref()],
            amm_program,
        );

        require_keys_eq!(*current[0].key, expected_pool, Errors::InvalidSwapAccounts);

        require_keys_eq!(*current[0].owner, *amm_program, Errors::InvalidSwapAccounts);

        let pool = {
            let data = current[0].try_borrow_data()?;
            Pool::try_deserialize(&mut &data[..])?
        };

        require_keys_eq!(pool.mint_a, mint_a, Errors::InvalidSwapAccounts);

        require_keys_eq!(pool.mint_b, mint_b, Errors::InvalidSwapAccounts);

        require_keys_eq!(
            *current[3].key,
            get_associated_token_address(&expected_pool, &mint_a),
            Errors::InvalidSwapAccounts
        );

        require_keys_eq!(
            *current[4].key,
            get_associated_token_address(&expected_pool, &mint_b),
            Errors::InvalidSwapAccounts
        );
    }

    Ok(())
}

pub fn calculate_swap_amounts<'info>(
    amm_program: &Pubkey,
    remaining_accounts: &[AccountInfo<'info>],
    amount: u64,
    limit: u64,
    path: &[Pubkey],
    deadline: i64,
    exact_input: bool,
) -> Result<Vec<u64>> {
    require!(Clock::get()?.unix_timestamp <= deadline, Errors::Expired);

    validate_hops(remaining_accounts, path, amm_program)?;

    let pools: Vec<AccountInfo<'info>> = (0..path.len() - 1)
        .map(|i| hop(remaining_accounts, i)[0].clone())
        .collect();

    let amounts = if exact_input {
        let amounts = get_amounts_out(amm_program, amount, path, &pools)?;

        require!(
            *amounts.last().unwrap() >= limit,
            Errors::InsufficientOutputAmount
        );

        amounts
    } else {
        let amounts = get_amounts_in(amm_program, amount, path, &pools)?;

        require!(amounts[0] <= limit, Errors::ExcessiveInputAmount);

        amounts
    };

    Ok(amounts)
}

pub fn execute_swap_hops<'info>(
    trader: AccountInfo<'info>,
    user_input: AccountInfo<'info>,
    recipient: AccountInfo<'info>,
    amm_program: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
    remaining_accounts: &[AccountInfo<'info>],
    path: &[Pubkey],
    amounts: &[u64],
) -> Result<()> {
    for i in 0..path.len() - 1 {
        let current = hop(remaining_accounts, i);

        let input = path[i];
        let output = path[i + 1];

        let (amount_a_out, amount_b_out) = if input < output {
            (0, amounts[i + 1])
        } else {
            (amounts[i + 1], 0)
        };

        let destination = output_destination(remaining_accounts, path, i, &recipient);

        let unused = unused_destination(remaining_accounts, path, i, &user_input);

        let (to_account_a, to_account_b) = if input < output {
            (unused, destination)
        } else {
            (destination, unused)
        };

        solana_v2_amm::cpi::swap(
            CpiContext::new(
                amm_program.clone(),
                AmmSwapAccounts {
                    pool: current[0].clone(),
                    mint_a: current[1].clone(),
                    mint_b: current[2].clone(),
                    pool_account_a: current[3].clone(),
                    pool_account_b: current[4].clone(),
                    to_account_a,
                    to_account_b,
                    trader: trader.clone(),
                    token_program: token_program.clone(),
                    callback_program: None,
                },
            ),
            amount_a_out,
            amount_b_out,
            vec![],
        )?;
    }

    Ok(())
}

pub fn execute_swap<'info>(
    trader: AccountInfo<'info>,
    user_input: AccountInfo<'info>,
    recipient: AccountInfo<'info>,
    amm_program: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
    remaining_accounts: &[AccountInfo<'info>],
    amount: u64,
    limit: u64,
    path: Vec<Pubkey>,
    deadline: i64,
    exact_input: bool,
) -> Result<Vec<u64>> {
    let amounts = calculate_swap_amounts(
        amm_program.key,
        remaining_accounts,
        amount,
        limit,
        &path,
        deadline,
        exact_input,
    )?;

    require_keys_eq!(
        TokenAccount::try_deserialize(&mut &user_input.try_borrow_data()?[..])?.mint,
        path[0],
        Errors::InvalidSwapPath
    );

    require_keys_eq!(
        TokenAccount::try_deserialize(&mut &recipient.try_borrow_data()?[..])?.mint,
        path[path.len() - 1],
        Errors::InvalidSwapPath
    );

    // Transfer the calculated input amount to the first pool.
    let first = hop(remaining_accounts, 0);

    token::transfer(
        CpiContext::new(
            token_program.clone(),
            Transfer {
                from: user_input.clone(),
                to: input_vault(first, path[0], path[1]),
                authority: trader.clone(),
            },
        ),
        amounts[0],
    )?;

    execute_swap_hops(
        trader,
        user_input,
        recipient,
        amm_program,
        token_program,
        remaining_accounts,
        &path,
        &amounts,
    )?;

    Ok(amounts)
}
