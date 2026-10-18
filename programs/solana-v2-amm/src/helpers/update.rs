use anchor_lang::prelude::*;

use crate::{
    events::Sync,
    math::{uq64x64, U256},
    state::Pool,
};

pub(crate) fn update(
    pool: &mut Pool,
    pool_key: Pubkey,
    balance_a: u64,
    balance_b: u64,
    reserve_a: u64,
    reserve_b: u64,
) -> Result<()> {
    let block_timestamp = Clock::get()?.unix_timestamp as u32;
    let time_elapsed = block_timestamp.wrapping_sub(pool.block_timestamp_last);

    if time_elapsed > 0 && reserve_a != 0 && reserve_b != 0 {
        let price_a = uq64x64::uqdiv(uq64x64::encode(reserve_b), reserve_a);
        let price_b = uq64x64::uqdiv(uq64x64::encode(reserve_a), reserve_b);

        let cumulative_a = U256(pool.price_a_cumulative_last);
        let cumulative_b = U256(pool.price_b_cumulative_last);

        // Accumulate price * elapsed seconds
        let increment_a = U256::from(price_a) * U256::from(time_elapsed);
        let increment_b = U256::from(price_b) * U256::from(time_elapsed);

        let (new_cumulative_a, _) = cumulative_a.overflowing_add(increment_a);
        let (new_cumulative_b, _) = cumulative_b.overflowing_add(increment_b);

        pool.price_a_cumulative_last = new_cumulative_a.0;
        pool.price_b_cumulative_last = new_cumulative_b.0;
    }

    pool.reserve_a = balance_a;
    pool.reserve_b = balance_b;

    pool.block_timestamp_last = block_timestamp;

    emit!(Sync {
        pool: pool_key,
        reserve_a: balance_a,
        reserve_b: balance_b,
    });

    Ok(())
}
