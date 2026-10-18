use anchor_lang::prelude::*;

use crate::{
    constants::{AMM_CONFIG_SEED, INITIAL_AUTHORITY},
    errors::*,
    state::AmmConfig,
};

pub fn create_amm_config(
    ctx: Context<CreateAmmConfig>,
    fee_to_setter: Pubkey,
    fee_to: Pubkey,
) -> Result<()> {
    let amm_config = &mut ctx.accounts.amm_config;
    amm_config.fee_to = fee_to;
    amm_config.fee_to_setter = fee_to_setter;

    Ok(())
}

#[derive(Accounts)]
#[instruction(fee_to_setter: Pubkey)]
pub struct CreateAmmConfig<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + AmmConfig::INIT_SPACE,
        seeds = [
            AMM_CONFIG_SEED
        ],
        bump,
        constraint = fee_to_setter != Pubkey::default() @ Errors::InvalidFeeToSetter
    )]
    pub amm_config: Account<'info, AmmConfig>,

    #[account(mut, address = INITIAL_AUTHORITY @ Errors::Unauthorized)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}
