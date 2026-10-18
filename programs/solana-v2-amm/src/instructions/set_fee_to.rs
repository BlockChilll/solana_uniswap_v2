use anchor_lang::prelude::*;

use crate::{constants::AMM_CONFIG_SEED, errors::Errors, state::AmmConfig};

pub fn set_fee_to(ctx: Context<SetFeeTo>, fee_to: Pubkey) -> Result<()> {
    ctx.accounts.amm_config.fee_to = fee_to;

    Ok(())
}

#[derive(Accounts)]
pub struct SetFeeTo<'info> {
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
