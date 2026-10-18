use anchor_lang::prelude::*;
use solana_v2_amm::{constants::POOL_SEED, state::Pool};

use crate::errors::Errors;

pub fn quote(amount_a: u64, reserve_a: u64, reserve_b: u64) -> Result<u64> {
    require!(amount_a > 0, Errors::InsufficientAmount);
    require!(
        reserve_a > 0 && reserve_b > 0,
        Errors::InsufficientLiquidity
    );

    let amount_b = (amount_a as u128)
        .checked_mul(reserve_b as u128)
        .ok_or(ProgramError::ArithmeticOverflow)?
        .checked_div(reserve_a as u128)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    let amount_b = u64::try_from(amount_b).map_err(|_| ProgramError::ArithmeticOverflow)?;

    Ok(amount_b)
}

pub fn calculate_liquidity_amounts(
    amount_a_desired: u64,
    amount_b_desired: u64,
    amount_a_min: u64,
    amount_b_min: u64,
    reserve_a: u64,
    reserve_b: u64,
) -> Result<(u64, u64)> {
    let (amount_a, amount_b) = if reserve_a == 0 && reserve_b == 0 {
        (amount_a_desired, amount_b_desired)
    } else {
        let amount_b_optimal = quote(amount_a_desired, reserve_a, reserve_b)?;

        if amount_b_optimal <= amount_b_desired {
            require!(
                amount_b_optimal >= amount_b_min,
                Errors::InsufficientAmountB
            );
            (amount_a_desired, amount_b_optimal)
        } else {
            let amount_a_optimal = quote(amount_b_desired, reserve_b, reserve_a)?;
            assert!(amount_a_optimal <= amount_a_desired);
            require!(
                amount_a_optimal >= amount_a_min,
                Errors::InsufficientAmountA
            );

            (amount_a_optimal, amount_b_desired)
        }
    };

    Ok((amount_a, amount_b))
}

pub fn get_amount_out(amount_in: u64, reserve_in: u64, reserve_out: u64) -> Result<u64> {
    require!(amount_in > 0, Errors::InsufficientAmount);
    require!(
        reserve_in > 0 && reserve_out > 0,
        Errors::InsufficientLiquidity
    );

    let amount_in_with_fee = (amount_in as u128)
        .checked_mul(997)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    let numerator = amount_in_with_fee
        .checked_mul(reserve_out as u128)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    let denominator = (reserve_in as u128)
        .checked_mul(1000)
        .and_then(|v| v.checked_add(amount_in_with_fee))
        .ok_or(ProgramError::ArithmeticOverflow)?;

    let amount_out = numerator
        .checked_div(denominator)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    u64::try_from(amount_out).map_err(|_| ProgramError::ArithmeticOverflow.into())
}

pub fn get_amount_in(amount_out: u64, reserve_in: u64, reserve_out: u64) -> Result<u64> {
    require!(amount_out > 0, Errors::InsufficientAmount);
    require!(
        reserve_in > 0 && reserve_out > 0,
        Errors::InsufficientLiquidity
    );

    let numerator = (reserve_in as u128)
        .checked_mul(amount_out as u128)
        .and_then(|v| v.checked_mul(1000))
        .ok_or(ProgramError::ArithmeticOverflow)?;

    let denominator = (reserve_out as u128)
        .checked_sub(amount_out as u128)
        .and_then(|v| v.checked_mul(997))
        .ok_or(ProgramError::ArithmeticOverflow)?;

    let amount_in = numerator
        .checked_div(denominator)
        .and_then(|v| v.checked_add(1))
        .ok_or(ProgramError::ArithmeticOverflow)?;

    u64::try_from(amount_in).map_err(|_| ProgramError::ArithmeticOverflow.into())
}

pub fn get_reserves(
    amm_program: &Pubkey,
    token_in: &Pubkey,
    token_out: &Pubkey,
    pool_info: &AccountInfo,
) -> Result<(u64, u64)> {
    require_keys_neq!(*token_in, *token_out, Errors::InvalidSwapPath);

    let (mint_a, mint_b) = if token_in < token_out {
        (token_in, token_out)
    } else {
        (token_out, token_in)
    };

    let (expected_pool, _) =
        Pubkey::find_program_address(&[POOL_SEED, mint_a.as_ref(), mint_b.as_ref()], amm_program);

    require_keys_eq!(*pool_info.key, expected_pool, Errors::InvalidSwapAccounts);

    require_keys_eq!(*pool_info.owner, *amm_program, Errors::InvalidSwapAccounts);

    let data = pool_info.try_borrow_data()?;
    let pool = Pool::try_deserialize(&mut &data[..])?;

    require_keys_eq!(pool.mint_a, *mint_a, Errors::InvalidSwapAccounts);

    require_keys_eq!(pool.mint_b, *mint_b, Errors::InvalidSwapAccounts);

    Ok(if token_in == mint_a {
        (pool.reserve_a, pool.reserve_b)
    } else {
        (pool.reserve_b, pool.reserve_a)
    })
}

pub fn get_amounts_out(
    amm_program: &Pubkey,
    amount_in: u64,
    path: &[Pubkey],
    pool_accounts: &[AccountInfo],
) -> Result<Vec<u64>> {
    require!(path.len() >= 2, Errors::InvalidSwapPath);

    require!(
        pool_accounts.len() == path.len() - 1,
        Errors::InvalidSwapAccounts
    );

    let mut amounts = vec![0u64; path.len()];
    amounts[0] = amount_in;

    for i in 0..path.len() - 1 {
        let (reserve_in, reserve_out) =
            get_reserves(amm_program, &path[i], &path[i + 1], &pool_accounts[i])?;

        amounts[i + 1] = get_amount_out(amounts[i], reserve_in, reserve_out)?;
    }

    Ok(amounts)
}

pub fn get_amounts_in(
    amm_program: &Pubkey,
    amount_out: u64,
    path: &[Pubkey],
    pool_accounts: &[AccountInfo],
) -> Result<Vec<u64>> {
    require!(path.len() >= 2, Errors::InvalidSwapPath);

    require!(
        pool_accounts.len() == path.len() - 1,
        Errors::InvalidSwapAccounts
    );

    let mut amounts = vec![0u64; path.len()];
    amounts[path.len() - 1] = amount_out;

    for i in (0..path.len() - 1).rev() {
        let (reserve_in, reserve_out) =
            get_reserves(amm_program, &path[i], &path[i + 1], &pool_accounts[i])?;

        amounts[i] = get_amount_in(amounts[i + 1], reserve_in, reserve_out)?;
    }

    Ok(amounts)
}
