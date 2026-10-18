use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
mod events;
mod helpers;
mod instructions;
mod math;
pub mod state;

use instructions::*;

declare_id!("HwVgAGBTdPvyXCyN5gRE2pun9BccbskyiRCnMboyeyns");

#[program]
pub mod solana_v2_amm {
    use super::*;

    pub fn create_amm_config(
        ctx: Context<CreateAmmConfig>,
        fee_to_setter: Pubkey,
        fee_to: Pubkey,
    ) -> Result<()> {
        instructions::create_amm_config(ctx, fee_to_setter, fee_to)
    }

    pub fn create_pool(ctx: Context<CreatePool>) -> Result<()> {
        instructions::create_pool(ctx)
    }

    pub fn set_fee_to(ctx: Context<SetFeeTo>, fee_to: Pubkey) -> Result<()> {
        instructions::set_fee_to(ctx, fee_to)
    }

    pub fn set_fee_to_setter(ctx: Context<SetFeeToSetter>, fee_to_setter: Pubkey) -> Result<()> {
        instructions::set_fee_to_setter(ctx, fee_to_setter)
    }

    pub fn mint(ctx: Context<MintLp>) -> Result<()> {
        instructions::mint(ctx)
    }

    pub fn burn(ctx: Context<BurnLp>) -> Result<()> {
        instructions::burn(ctx)
    }

    pub fn swap<'info>(
        ctx: Context<'_, '_, '_, 'info, SwapAccounts<'info>>,
        amount_a_out: u64,
        amount_b_out: u64,
        callback_data: Vec<u8>,
    ) -> Result<()> {
        instructions::swap(ctx, amount_a_out, amount_b_out, callback_data)
    }

    pub fn skim(ctx: Context<Skim>) -> Result<()> {
        instructions::skim(ctx)
    }

    pub fn sync(ctx: Context<Sync>) -> Result<()> {
        instructions::sync(ctx)
    }
}
