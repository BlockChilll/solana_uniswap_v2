pub const Q64: u128 = 1u128 << 64;

/// Encode a u64 into UQ64x64.
pub fn encode(value: u64) -> u128 {
    (value as u128) * Q64
}

/// Divide a UQ64x64 value by a u64.
pub fn uqdiv(value: u128, divisor: u64) -> u128 {
    value / divisor as u128
}
