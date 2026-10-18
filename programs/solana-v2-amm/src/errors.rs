use anchor_lang::prelude::*;

#[error_code]
pub enum Errors {
    #[msg("Invalid fee_to setter")]
    InvalidFeeToSetter,
    #[msg("Invalid authorizaton")]
    Unauthorized,
    #[msg("Tokens are not ordered correctly")]
    InvalidMintOrder,
    #[msg("No fee_to account provided")]
    MissingFeeAccount,
    #[msg("No correct fee_to account provided")]
    InvalidFeeAccount,
    #[msg("Pool balance is lower than the recorded reserve")]
    InsufficientVaultBalance,
    #[msg("No enough liquidity minted")]
    InsufficientLiquidityMinted,
    #[msg("No enough liquidity burned")]
    InsufficientLiquidityBurned,
    #[msg("Invalid token recipient")]
    InvalidRecipient,
    #[msg("No enough output amount")]
    InsufficientOutputAmount,
    #[msg("No enough liquidity for a swap")]
    InsufficientLiquidity,
    #[msg("No enough input amount")]
    InsufficientInputAmount,
    #[msg("Invalid new K")]
    InvalidNewK,
    #[msg("No callback program provided")]
    MissingCallbackProgram,
}
