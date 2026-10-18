use anchor_lang::prelude::*;

#[error_code]
pub enum Errors {
    #[msg("Not enough amount")]
    InsufficientAmount,
    #[msg("Not enough liquidity")]
    InsufficientLiquidity,
    #[msg("Not enough token a amount")]
    InsufficientAmountA,
    #[msg("Not enough token b amount")]
    InsufficientAmountB,
    #[msg("Transaction deadline expired")]
    Expired,
    #[msg("Invalid SOL mint")]
    InvalidSolMint,
    #[msg("Invalid token mint")]
    InvalidTokenMint,
    #[msg("Invalid swap path")]
    InvalidSwapPath,
    #[msg("Invalid swap accounts")]
    InvalidSwapAccounts,
    #[msg("Insufficient output amount")]
    InsufficientOutputAmount,
    #[msg("Excessive input amount")]
    ExcessiveInputAmount,
}
