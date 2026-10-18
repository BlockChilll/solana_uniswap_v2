
import * as anchor from "@coral-xyz/anchor";
import { LiteSVMProvider } from "anchor-litesvm";
import {
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import { expect } from "chai";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createTestSvm } from "../helpers/setup";
import {
  createMint,
  createTokenAccount,
  mintTokens,
  transferTokens,
} from "../helpers/token";
import { derivePoolAccounts } from "../helpers/pool";
import type { SolanaV2Amm } from "../../target/types/solana_v2_amm";

const idl = JSON.parse(
  readFileSync("target/idl/solana_v2_amm.json", "utf8"),
) as SolanaV2Amm;

describe("AMM - mint", () => {
  async function setupMintTest() {
    const svm = createTestSvm();
    const provider = new LiteSVMProvider(svm);
    const program = new anchor.Program<SolanaV2Amm>(
      idl,
      provider,
    );

    const payer = Keypair.fromSecretKey(
      Uint8Array.from(
        JSON.parse(
          readFileSync(
            join(homedir(), ".config", "solana", "id.json"),
            "utf8",
          ),
        ),
      ),
    );

    svm.airdrop(
      payer.publicKey,
      BigInt(10 * anchor.web3.LAMPORTS_PER_SOL),
    );

    const [ammConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("amm_config")],
      program.programId,
    );

    await program.methods
      .createAmmConfig(payer.publicKey, PublicKey.default)
      .accountsPartial({
        ammConfig,
        payer: payer.publicKey,
      })
      .signers([payer])
      .rpc();

    const firstMint = await createMint(svm, provider, payer);
    const secondMint = await createMint(svm, provider, payer);

    const [mintA, mintB] =
      firstMint.toBuffer().compare(secondMint.toBuffer()) < 0
        ? [firstMint, secondMint]
        : [secondMint, firstMint];

    const accounts = derivePoolAccounts(
      program.programId,
      mintA,
      mintB,
    );

    await program.methods
      .createPool()
      .accountsPartial({
        ...accounts,
        mintA,
        mintB,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([payer])
      .rpc();

    const providerAccountA = await createTokenAccount(
      provider,
      payer,
      mintA,
      payer.publicKey,
    );

    const providerAccountB = await createTokenAccount(
      provider,
      payer,
      mintB,
      payer.publicKey,
    );

    const providerLpAccount = await createTokenAccount(
      provider,
      payer,
      accounts.mintLp,
      payer.publicKey,
    );

    return {
      svm,
      provider,
      program,
      payer,
      ammConfig,
      mintA,
      mintB,
      accounts,
      providerAccountA,
      providerAccountB,
      providerLpAccount,
    };
  }

  async function depositLiquidity(
    ctx: Awaited<ReturnType<typeof setupMintTest>>,
    amountA: bigint,
    amountB: bigint,
  ) {
    const {
      svm,
      provider,
      program,
      payer,
      ammConfig,
      mintA,
      mintB,
      accounts,
      providerAccountA,
      providerAccountB,
      providerLpAccount,
    } = ctx;

    await mintTokens(
      provider,
      payer,
      mintA,
      providerAccountA,
      amountA,
    );

    await mintTokens(
      provider,
      payer,
      mintB,
      providerAccountB,
      amountB,
    );

    await transferTokens(
      provider,
      payer,
      providerAccountA,
      accounts.poolAccountA,
      amountA,
    );

    await transferTokens(
      provider,
      payer,
      providerAccountB,
      accounts.poolAccountB,
      amountB,
    );

    // Refresh LiteSVM's blockhash before another AMM mint.
    svm.expireBlockhash();

    await program.methods
      .mint()
      .accountsPartial({
        ammConfig,
        pool: accounts.pool,
        mintA,
        mintB,
        poolAccountA: accounts.poolAccountA,
        poolAccountB: accounts.poolAccountB,
        lockedLpAccount: accounts.lockedLpAccount,
        mintLp: accounts.mintLp,
        feeToLpAccount: null,
        toLpAccount: providerLpAccount,
        provider: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([payer])
      .rpc();
  }

  async function getTokenAmount(
    ctx: Awaited<ReturnType<typeof setupMintTest>>,
    address: PublicKey,
  ): Promise<bigint> {
    const info = await ctx.provider.connection.getAccountInfo(
      address,
    );

    if (!info) {
      throw new Error(`Token account not found: ${address.toBase58()}`);
    }

    return unpackAccount(
      address,
      info,
      TOKEN_PROGRAM_ID,
    ).amount;
  }

  async function getLpSupply(
    ctx: Awaited<ReturnType<typeof setupMintTest>>,
  ): Promise<bigint> {
    const info = await ctx.provider.connection.getAccountInfo(
      ctx.accounts.mintLp,
    );

    if (!info) {
      throw new Error("LP mint not found");
    }

    return unpackMint(
      ctx.accounts.mintLp,
      info,
      TOKEN_PROGRAM_ID,
    ).supply;
  }

  it("mints initial liquidity and locks MINIMUM_LIQUIDITY", async () => {
    const ctx = await setupMintTest();

    const amountA = 1_000_000n;
    const amountB = 4_000_000n;

    await depositLiquidity(ctx, amountA, amountB);

    expect(await getLpSupply(ctx)).to.equal(2_000_000n);

    expect(
      await getTokenAmount(ctx, ctx.providerLpAccount),
    ).to.equal(1_999_000n);

    expect(
      await getTokenAmount(ctx, ctx.accounts.lockedLpAccount),
    ).to.equal(1_000n);

    const poolState = await ctx.program.account.pool.fetch(
      ctx.accounts.pool,
    );

    expect(poolState.reserveA.toString()).to.equal(
      amountA.toString(),
    );

    expect(poolState.reserveB.toString()).to.equal(
      amountB.toString(),
    );

    expect(poolState.kLast.toString()).to.equal("0");
  });

  it("mints proportional LP tokens for subsequent deposits", async () => {
    const ctx = await setupMintTest();

    // Initial liquidity:
    // sqrt(1_000_000 * 4_000_000) = 2_000_000 LP
    await depositLiquidity(
      ctx,
      1_000_000n,
      4_000_000n,
    );

    expect(await getLpSupply(ctx)).to.equal(2_000_000n);

    // Second deposit at the same ratio:
    //
    // min(
    //   500_000 * 2_000_000 / 1_000_000,
    //   2_000_000 * 2_000_000 / 4_000_000
    // ) = 1_000_000 LP

    await depositLiquidity(
      ctx,
      500_000n,
      2_000_000n,
    );

    expect(await getLpSupply(ctx)).to.equal(3_000_000n);

    expect(
      await getTokenAmount(ctx, ctx.providerLpAccount),
    ).to.equal(2_999_000n);

    expect(
      await getTokenAmount(ctx, ctx.accounts.lockedLpAccount),
    ).to.equal(1_000n);

    const poolState = await ctx.program.account.pool.fetch(
      ctx.accounts.pool,
    );

    expect(poolState.reserveA.toString()).to.equal("1500000");
    expect(poolState.reserveB.toString()).to.equal("6000000");
    expect(poolState.kLast.toString()).to.equal("0");

    // Verify actual vault balances match reserves.
    expect(
      await getTokenAmount(ctx, ctx.accounts.poolAccountA),
    ).to.equal(1_500_000n);

    expect(
      await getTokenAmount(ctx, ctx.accounts.poolAccountB),
    ).to.equal(6_000_000n);
  });

  it("uses the limiting token when minting imbalanced liquidity", async () => {
    const ctx = await setupMintTest();

    await depositLiquidity(ctx, 1_000_000n, 4_000_000n);
    await depositLiquidity(ctx, 500_000n, 1_000_000n);

    expect(await getLpSupply(ctx)).to.equal(2_500_000n);

    expect(
      await getTokenAmount(ctx, ctx.providerLpAccount),
    ).to.equal(2_499_000n);

    expect(
      await getTokenAmount(ctx, ctx.accounts.lockedLpAccount),
    ).to.equal(1_000n);

    const pool = await ctx.program.account.pool.fetch(ctx.accounts.pool);

    expect(pool.reserveA.toString()).to.equal("1500000");
    expect(pool.reserveB.toString()).to.equal("5000000");
  });

  it("rejects initial liquidity equal to MINIMUM_LIQUIDITY", async () => {
    const ctx = await setupMintTest();

    await mintTokens(
      ctx.provider,
      ctx.payer,
      ctx.mintA,
      ctx.providerAccountA,
      1_000n,
    );

    await mintTokens(
      ctx.provider,
      ctx.payer,
      ctx.mintB,
      ctx.providerAccountB,
      1_000n,
    );

    await transferTokens(
      ctx.provider,
      ctx.payer,
      ctx.providerAccountA,
      ctx.accounts.poolAccountA,
      1_000n,
    );

    await transferTokens(
      ctx.provider,
      ctx.payer,
      ctx.providerAccountB,
      ctx.accounts.poolAccountB,
      1_000n,
    );

    try {
      await ctx.program.methods
        .mint()
        .accountsPartial({
          ammConfig: ctx.ammConfig,
          pool: ctx.accounts.pool,
          mintA: ctx.mintA,
          mintB: ctx.mintB,
          poolAccountA: ctx.accounts.poolAccountA,
          poolAccountB: ctx.accounts.poolAccountB,
          lockedLpAccount: ctx.accounts.lockedLpAccount,
          mintLp: ctx.accounts.mintLp,
          feeToLpAccount: null,
          toLpAccount: ctx.providerLpAccount,
          provider: ctx.payer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([ctx.payer])
        .rpc();

      expect.fail("Expected InsufficientLiquidityMinted");
    } catch (error) {
      if (error instanceof anchor.AnchorError) {
        expect(error.error.errorCode.code).to.equal(
          "InsufficientLiquidityMinted",
        );
      } else {
        throw error;
      }
    }

    expect(await getLpSupply(ctx)).to.equal(0n);

    expect(
      await getTokenAmount(ctx, ctx.accounts.lockedLpAccount),
    ).to.equal(0n);

    const pool = await ctx.program.account.pool.fetch(ctx.accounts.pool);

    expect(pool.reserveA.toString()).to.equal("0");
    expect(pool.reserveB.toString()).to.equal("0");
  });

  it("rejects minting when no new tokens were deposited", async () => {
    const ctx = await setupMintTest();

    await depositLiquidity(ctx, 1_000_000n, 4_000_000n);

    ctx.svm.expireBlockhash();

    try {
      await ctx.program.methods
        .mint()
        .accountsPartial({
          ammConfig: ctx.ammConfig,
          pool: ctx.accounts.pool,
          mintA: ctx.mintA,
          mintB: ctx.mintB,
          poolAccountA: ctx.accounts.poolAccountA,
          poolAccountB: ctx.accounts.poolAccountB,
          lockedLpAccount: ctx.accounts.lockedLpAccount,
          mintLp: ctx.accounts.mintLp,
          feeToLpAccount: null,
          toLpAccount: ctx.providerLpAccount,
          provider: ctx.payer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([ctx.payer])
        .rpc();

      expect.fail("Expected InsufficientLiquidityMinted");
    } catch (error) {
      if (error instanceof anchor.AnchorError) {
        expect(error.error.errorCode.code).to.equal(
          "InsufficientLiquidityMinted",
        );
      } else {
        throw error;
      }
    }

    expect(await getLpSupply(ctx)).to.equal(2_000_000n);

    const pool = await ctx.program.account.pool.fetch(ctx.accounts.pool);

    expect(pool.reserveA.toString()).to.equal("1000000");
    expect(pool.reserveB.toString()).to.equal("4000000");
  });

  it("rejects a one-sided liquidity deposit", async () => {
    const ctx = await setupMintTest();

    await depositLiquidity(ctx, 1_000_000n, 4_000_000n);

    await mintTokens(
      ctx.provider,
      ctx.payer,
      ctx.mintA,
      ctx.providerAccountA,
      500_000n,
    );

    await transferTokens(
      ctx.provider,
      ctx.payer,
      ctx.providerAccountA,
      ctx.accounts.poolAccountA,
      500_000n,
    );

    ctx.svm.expireBlockhash();

    try {
      await ctx.program.methods
        .mint()
        .accountsPartial({
          ammConfig: ctx.ammConfig,
          pool: ctx.accounts.pool,
          mintA: ctx.mintA,
          mintB: ctx.mintB,
          poolAccountA: ctx.accounts.poolAccountA,
          poolAccountB: ctx.accounts.poolAccountB,
          lockedLpAccount: ctx.accounts.lockedLpAccount,
          mintLp: ctx.accounts.mintLp,
          feeToLpAccount: null,
          toLpAccount: ctx.providerLpAccount,
          provider: ctx.payer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([ctx.payer])
        .rpc();

      expect.fail("Expected InsufficientLiquidityMinted");
    } catch (error) {
      if (error instanceof anchor.AnchorError) {
        expect(error.error.errorCode.code).to.equal(
          "InsufficientLiquidityMinted",
        );
      } else {
        throw error;
      }
    }

    expect(await getLpSupply(ctx)).to.equal(2_000_000n);

    const pool = await ctx.program.account.pool.fetch(ctx.accounts.pool);

    expect(pool.reserveA.toString()).to.equal("1000000");
    expect(pool.reserveB.toString()).to.equal("4000000");

    // The separate SPL transfer succeeded before the failed mint.
    expect(
      await getTokenAmount(ctx, ctx.accounts.poolAccountA),
    ).to.equal(1_500_000n);
  });

  it("sets k_last on initial mint when protocol fees are enabled", async () => {
    const ctx = await setupMintTest();

    const feeRecipient = Keypair.generate();

    await ctx.program.methods
      .setFeeTo(feeRecipient.publicKey)
      .accountsPartial({
        ammConfig: ctx.ammConfig,
        feeToSetter: ctx.payer.publicKey,
      })
      .signers([ctx.payer])
      .rpc();

    await depositLiquidity(ctx, 1_000_000n, 4_000_000n);

    const pool = await ctx.program.account.pool.fetch(ctx.accounts.pool);

    expect(pool.kLast.eq(new anchor.BN("4000000000000"))).to.equal(true);
  });

  it("resets k_last when protocol fees are disabled", async () => {
    const ctx = await setupMintTest();

    const feeRecipient = Keypair.generate();

    // Enable protocol fees.
    await ctx.program.methods
      .setFeeTo(feeRecipient.publicKey)
      .accountsPartial({
        ammConfig: ctx.ammConfig,
        feeToSetter: ctx.payer.publicKey,
      })
      .signers([ctx.payer])
      .rpc();

    // Initial liquidity with fees enabled.
    await depositLiquidity(ctx, 1_000_000n, 4_000_000n);

    let pool = await ctx.program.account.pool.fetch(ctx.accounts.pool);

    expect(
      pool.kLast.eq(new anchor.BN("4000000000000")),
    ).to.equal(true);

    // Disable protocol fees.
    ctx.svm.expireBlockhash();

    await ctx.program.methods
      .setFeeTo(PublicKey.default)
      .accountsPartial({
        ammConfig: ctx.ammConfig,
        feeToSetter: ctx.payer.publicKey,
      })
      .signers([ctx.payer])
      .rpc();

    // Disabling fees does not immediately reset k_last.
    pool = await ctx.program.account.pool.fetch(ctx.accounts.pool);

    expect(
      pool.kLast.eq(new anchor.BN("4000000000000")),
    ).to.equal(true);

    // Next liquidity operation triggers mint_fee().
    await depositLiquidity(ctx, 500_000n, 2_000_000n);

    pool = await ctx.program.account.pool.fetch(ctx.accounts.pool);

    expect(pool.kLast.isZero()).to.equal(true);

    // No protocol fees minted.
    expect(await getLpSupply(ctx)).to.equal(3_000_000n);

    expect(
      await getTokenAmount(ctx, ctx.providerLpAccount),
    ).to.equal(2_999_000n);

    expect(
      await getTokenAmount(ctx, ctx.accounts.lockedLpAccount),
    ).to.equal(1_000n);

    expect(pool.reserveA.toString()).to.equal("1500000");
    expect(pool.reserveB.toString()).to.equal("6000000");
  });


  it("mints protocol LP fees after swap increases k", async () => {
    const ctx = await setupMintTest();

    const {
      svm,
      provider,
      program,
      payer,
      ammConfig,
      mintA,
      mintB,
      accounts,
      providerAccountA,
      providerAccountB,
      providerLpAccount,
    } = ctx;

    const feeRecipient = Keypair.generate();

    // Create the fee recipient's LP token account.
    const feeToLpAccount = await createTokenAccount(
      provider,
      payer,
      accounts.mintLp,
      feeRecipient.publicKey,
    );

    // Enable protocol fees.
    await program.methods
      .setFeeTo(feeRecipient.publicKey)
      .accountsPartial({
        ammConfig,
        feeToSetter: payer.publicKey,
      })
      .signers([payer])
      .rpc();

    // Initial liquidity.
    await depositLiquidity(ctx, 100_000_000n, 100_000_000n);

    let pool = await program.account.pool.fetch(accounts.pool);

    const initialKLast = 100_000_000n * 100_000_000n;

    expect(
      pool.kLast.eq(new anchor.BN(initialKLast.toString())),
    ).to.equal(true);

    // Swap A -> B.
    const amountAIn = 50_000_000n;

    // Uniswap V2 getAmountOut formula with 0.3% fee.
    const amountAInWithFee = amountAIn * 997n;

    const amountBOut =
      (amountAInWithFee * 100_000_000n) /
      (100_000_000n * 1000n + amountAInWithFee);

    // Fund trader with token A.
    await mintTokens(
      provider,
      payer,
      mintA,
      providerAccountA,
      amountAIn,
    );

    // Transfer swap input to pool before calling swap().
    await transferTokens(
      provider,
      payer,
      providerAccountA,
      accounts.poolAccountA,
      amountAIn,
    );

    svm.expireBlockhash();

    await program.methods
      .swap(
        new anchor.BN(0),
        new anchor.BN(amountBOut.toString()),
        Buffer.alloc(0),
      )
      .accountsPartial({
        pool: accounts.pool,
        mintA,
        mintB,
        poolAccountA: accounts.poolAccountA,
        poolAccountB: accounts.poolAccountB,
        toAccountA: providerAccountA,
        toAccountB: providerAccountB,
        trader: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        callbackProgram: null,
      })
      .signers([payer])
      .rpc();

    pool = await program.account.pool.fetch(accounts.pool);

    const reserveAAfterSwap = 150_000_000n;
    const reserveBAfterSwap = 100_000_000n - amountBOut;

    expect(pool.reserveA.toString()).to.equal(
      reserveAAfterSwap.toString(),
    );

    expect(pool.reserveB.toString()).to.equal(
      reserveBAfterSwap.toString(),
    );

    // k_last is NOT updated by swap().
    expect(
      pool.kLast.eq(new anchor.BN(initialKLast.toString())),
    ).to.equal(true);

    // Calculate expected protocol LP fee.
    const sqrt = (n: bigint): bigint => {
      if (n < 0n) throw new Error("Negative square root");
      if (n < 2n) return n;

      let x = n;
      let y = (x + 1n) / 2n;

      while (y < x) {
        x = y;
        y = (x + n / x) / 2n;
      }

      return x;
    };

    const rootK = sqrt(reserveAAfterSwap * reserveBAfterSwap);
    const rootKLast = sqrt(initialKLast);

    expect(rootK > rootKLast).to.equal(true);

    const supplyBefore = await getLpSupply(ctx);

    const expectedProtocolFee =
      (supplyBefore * (rootK - rootKLast)) /
      (rootK * 5n + rootKLast);

    expect(expectedProtocolFee > 0n).to.equal(true);

    // Add liquidity at the new reserve ratio.
    // We cannot use depositLiquidity() unchanged here because
    // it always passes feeToLpAccount: null.
    const amountA = 15_000_000n;
    const amountB =
      (amountA * reserveBAfterSwap) / reserveAAfterSwap;

    await mintTokens(
      provider,
      payer,
      mintA,
      providerAccountA,
      amountA,
    );

    await mintTokens(
      provider,
      payer,
      mintB,
      providerAccountB,
      amountB,
    );

    await transferTokens(
      provider,
      payer,
      providerAccountA,
      accounts.poolAccountA,
      amountA,
    );

    await transferTokens(
      provider,
      payer,
      providerAccountB,
      accounts.poolAccountB,
      amountB,
    );

    svm.expireBlockhash();

    await program.methods
      .mint()
      .accountsPartial({
        ammConfig,
        pool: accounts.pool,
        mintA,
        mintB,
        poolAccountA: accounts.poolAccountA,
        poolAccountB: accounts.poolAccountB,
        lockedLpAccount: accounts.lockedLpAccount,
        mintLp: accounts.mintLp,
        feeToLpAccount,
        toLpAccount: providerLpAccount,
        provider: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([payer])
      .rpc();

    // Verify protocol fee recipient received the expected LP tokens.
    expect(
      await getTokenAmount(ctx, feeToLpAccount),
    ).to.equal(expectedProtocolFee);

    // Verify provider LP minting accounts for the newly minted protocol fee.
    const supplyWithFee = supplyBefore + expectedProtocolFee;

    const expectedProviderLiquidity =
      (amountA * supplyWithFee) / reserveAAfterSwap <
      (amountB * supplyWithFee) / reserveBAfterSwap
        ? (amountA * supplyWithFee) / reserveAAfterSwap
        : (amountB * supplyWithFee) / reserveBAfterSwap;

    expect(
      await getTokenAmount(ctx, providerLpAccount),
    ).to.equal(
      supplyBefore - 1_000n + expectedProviderLiquidity,
    );

    expect(await getLpSupply(ctx)).to.equal(
      supplyWithFee + expectedProviderLiquidity,
    );

    // Verify k_last was updated after liquidity minting.
    pool = await program.account.pool.fetch(accounts.pool);

    const expectedReserveA = reserveAAfterSwap + amountA;
    const expectedReserveB = reserveBAfterSwap + amountB;

    expect(pool.reserveA.toString()).to.equal(
      expectedReserveA.toString(),
    );

    expect(pool.reserveB.toString()).to.equal(
      expectedReserveB.toString(),
    );

    expect(
      pool.kLast.eq(
        new anchor.BN(
          (expectedReserveA * expectedReserveB).toString(),
        ),
      ),
    ).to.equal(true);
  });
});
