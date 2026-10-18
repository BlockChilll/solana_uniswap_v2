use anchor_lang::prelude::*;

use crate::{
    constants::POOL_SEED,
    errors::Errors,
    state::{AmmConfig, Pool},
};
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};

pub(crate) fn mint_fee<'info>(
    pool: &mut Account<'info, Pool>,
    config: &AmmConfig,
    mint_lp: &Account<'info, Mint>,
    fee_to_lp_account: Option<&Account<'info, TokenAccount>>,
    token_program: &Program<'info, Token>,
) -> Result<bool> {
    let is_fee_on = config.fee_to != Pubkey::default();
    let k_last = pool.k_last;

    if is_fee_on {
        if k_last != 0 {
            let k = (pool.reserve_a as u128) * (pool.reserve_b as u128);
            let root_k = k.isqrt();
            let root_k_last = k_last.isqrt();

            if root_k > root_k_last {
                let numerator = (mint_lp.supply as u128) * (root_k - root_k_last);
                let denominator = (root_k * 5) + root_k_last;
                let liquidity = numerator / denominator;

                if liquidity > 0 {
                    let fee_account = fee_to_lp_account.ok_or(Errors::MissingFeeAccount)?;

                    require_keys_eq!(fee_account.owner, config.fee_to, Errors::InvalidFeeAccount);
                    require_keys_eq!(fee_account.mint, mint_lp.key(), Errors::InvalidFeeAccount);

                    let liquidity =
                        u64::try_from(liquidity).map_err(|_| ProgramError::ArithmeticOverflow)?;

                    let bump = [pool.bump];

                    let signer_seeds: &[&[u8]] =
                        &[POOL_SEED, pool.mint_a.as_ref(), pool.mint_b.as_ref(), &bump];
                    let signer = &[signer_seeds];

                    let cpi_accounts = MintTo {
                        mint: mint_lp.to_account_info(),
                        to: fee_account.to_account_info(),
                        authority: pool.to_account_info(),
                    };
                    let cpi_ctx = CpiContext::new_with_signer(
                        token_program.to_account_info(),
                        cpi_accounts,
                        signer,
                    );

                    token::mint_to(cpi_ctx, liquidity)?;
                }
            }
        }
    } else if k_last != 0 {
        pool.k_last = 0;
    }

    Ok(is_fee_on)
}
