# Solana Uniswap V2

An educational implementation of a **Uniswap V2–style automated market maker (AMM)** and **swap router** on Solana, built with **Rust** and **Anchor**.

The project explores how a constant-product DEX can be implemented using Solana's account model, program-derived addresses (PDAs), SPL Token accounts, and cross-program invocations (CPIs).

## Features

### AMM
- Token-pair liquidity pools with a constant-product pricing model (`x * y = k`)
- Liquidity deposits and withdrawals with LP token minting and burning
- Exact-input and exact-output swap calculations
- Pool reserve accounting and a **0.30% swap fee**
- PDA-controlled pool accounts and token vaults

### Router
- Single-hop and multi-hop token swaps
- Exact-input and exact-output swap modes
- Native SOL ↔ SPL token swaps using temporary wrapped SOL (WSOL) accounts
- Slippage bounds and transaction deadlines
- Liquidity operations, including SOL-based liquidity flows
- Account and swap-path validation

## Architecture

The implementation separates **pool-level accounting** from **user-facing routing**.

```text
                         Trader / Client
                               |
                               v
                     +------------------+
                     |      Router      |
                     | paths, limits,   |
                     | SOL / WSOL flows |
                     +------------------+
                               |
                          CPI calls
                               |
                               v
                     +------------------+
                     |       AMM        |
                     | pool operations, |
                     | reserves, LPs    |
                     +------------------+
                               |
                   +-----------+-----------+
                   |                       |
                   v                       v
             +-----------+           +-----------+
             |  Pool A/B |   ...     |  Pool B/C |
             | vault A/B |           | vault B/C |
             | LP mint   |           | LP mint   |
             +-----------+           +-----------+
```

**AMM:** Owns the pool logic and enforces the rules for liquidity and swaps.

**Router:** Coordinates one or more AMM operations, validates swap paths, and handles native SOL wrapping/unwrapping. For multi-hop swaps, intermediate output is routed to the next pool.

**SPL Token program:** Performs token transfers, minting, burning, and WSOL account operations.

## Swap API

The router implements six swap variants:

| Instruction | Input | Output | Mode |
| --- | --- | --- | --- |
| `swap_tokens_for_exact_tokens` | SPL token | SPL token | Exact output |
| `swap_exact_tokens_for_tokens` | SPL token | SPL token | Exact input |
| `swap_exact_sol_for_tokens` | SOL | SPL token | Exact input |
| `swap_sol_for_exact_tokens` | SOL | SPL token | Exact output |
| `swap_exact_tokens_for_sol` | SPL token | SOL | Exact input |
| `swap_tokens_for_exact_sol` | SPL token | SOL | Exact output |

### Constant-product pricing

For reserves `reserve_in` and `reserve_out`, the implementation uses the Uniswap V2 fee-adjusted calculations (0.30% fee):

**Exact input:**

```text
amount_in_with_fee = amount_in * 997

amount_out =
    (amount_in_with_fee * reserve_out)
    / (reserve_in * 1000 + amount_in_with_fee)
```

**Exact output:**

```text
amount_in =
    floor((reserve_in * amount_out * 1000)
          / ((reserve_out - amount_out) * 997)) + 1
```

Integer arithmetic and rounding matter: exact-input swaps round output down, while exact-output swaps round required input up.

### Native SOL support

SPL Token programs work with **WSOL**, not native SOL directly. The router handles the conversion within a transaction:

- **SOL → tokens:** create a temporary WSOL token account, fund it with the required lamports, call `SyncNative`, execute the swap, and close the temporary account.
- **Tokens → SOL:** receive WSOL into a temporary token account, close it to unwrap the SOL, and forward the swap proceeds to the specified recipient.

## Technology

- **Rust** and **Anchor 0.32.1**
- **Solana** and the **SPL Token** program
- **TypeScript**, **Mocha**, and **Chai**
- **LiteSVM** / `anchor-litesvm` for local integration testing

## Getting started

### Prerequisites

Install the Solana CLI, Anchor CLI, Rust toolchain, Node.js, and Yarn. Use a toolchain compatible with Anchor 0.32.1.

### Install and build

```bash
git clone https://github.com/BlockChilll/solana_uniswap_v2.git
cd solana_uniswap_v2

yarn install
anchor build
```

### Run tests

```bash
yarn test
```

The integration tests use **LiteSVM** for an in-process Solana execution environment. They exercise the actual programs and token-account state transitions rather than mocking swap results.

Some test fixtures initialize the native WSOL mint explicitly for LiteSVM.

## Testing

**160 integration tests passing** at the time this README was prepared:

| Component | Passing tests |
| --- | ---: |
| AMM | 54 |
| Router | 106 |
| **Total** | **160** |

Coverage includes:

- Pool creation and liquidity operations
- LP minting/burning and reserve updates
- Token-to-token, SOL-to-token, and token-to-SOL swaps
- Exact-input and exact-output modes
- Single-hop and multi-hop routing
- Swap math, fee calculations, and slippage bounds
- Deadlines, invalid paths, and incorrect accounts
- Insufficient funds and transaction rollback
- Temporary WSOL account lifecycle and rent recovery

These tests validate the scenarios they cover; they are **not a substitute for a security audit**.

## Design considerations

- **Deterministic addresses:** PDAs identify program-owned pool state and authorities.
- **Account validation:** Swap paths must match the supplied pools, mints, and vaults.
- **Atomicity:** A failed transaction rolls back all intermediate token transfers and state changes.
- **Explicit slippage limits:** Users provide minimum output or maximum input constraints.
- **Separation of concerns:** The AMM manages pool rules; the router handles orchestration and user-facing swap flows.
- **Integer precision:** Swap formulas are implemented with integer arithmetic and deliberate rounding.
