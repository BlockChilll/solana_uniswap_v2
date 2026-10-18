use anchor_lang::prelude::*;

use crate::{constants::AMM_CONFIG_SEED, errors::Errors, state::AmmConfig};

pub fn set_fee_to_setter(ctx: Context<SetFeeToSetter>, fee_to_setter: Pubkey) -> Result<()> {
    ctx.accounts.amm_config.fee_to_setter = fee_to_setter;

    Ok(())
}

#[derive(Accounts)]
pub struct SetFeeToSetter<'info> {
    #[account(
        mut,
        seeds = [
            AMM_CONFIG_SEED
        ],
        bump,
        has_one = fee_to_setter @ Errors::Unauthorized,
    )]
    pub amm_config: Account<'info, AmmConfig>,

    #[account(mut)]
    pub fee_to_setter: Signer<'info>,
}
