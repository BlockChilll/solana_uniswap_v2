
import * as anchor from "@coral-xyz/anchor";
import { LiteSVMProvider } from "anchor-litesvm";
import {
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackAccount,
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

describe("AMM - swap", () => {
  async function setupSwapTest() {
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
            join(homedir(), ".config/solana/id.json"),
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
      .createAmmConfig(
        payer.publicKey,
        PublicKey.default,
      )
      .accountsPartial({
        ammConfig,
        payer: payer.publicKey,
      })
      .signers([payer])
      .rpc();

    const firstMint = await createMint(
      svm,
      provider,
      payer,
    );

    const secondMint = await createMint(
      svm,
      provider,
      payer,
    );

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

    // Initial liquidity: 100M A + 100M B.
    const initialLiquidity = 100_000_000n;

    await mintTokens(
      provider,
      payer,
      mintA,
      providerAccountA,
      initialLiquidity,
    );

    await mintTokens(
      provider,
      payer,
      mintB,
      providerAccountB,
      initialLiquidity,
    );

    await transferTokens(
      provider,
      payer,
      providerAccountA,
      accounts.poolAccountA,
      initialLiquidity,
    );

    await transferTokens(
      provider,
      payer,
      providerAccountB,
      accounts.poolAccountB,
      initialLiquidity,
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
        feeToLpAccount: null,
        toLpAccount: providerLpAccount,
        provider: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([payer])
      .rpc();

    return {
      svm,
      provider,
      program,
      payer,
      mintA,
      mintB,
      accounts,
      providerAccountA,
      providerAccountB,
    };
  }

  type SwapContext = Awaited<
    ReturnType<typeof setupSwapTest>
  >;

  async function getTokenAmount(
    ctx: SwapContext,
    address: PublicKey,
  ): Promise<bigint> {
    const info =
      await ctx.provider.connection.getAccountInfo(address);

    if (!info) {
      throw new Error("Token account not found");
    }

    return unpackAccount(address, info).amount;
  }

  function getAmountOut(
    amountIn: bigint,
    reserveIn: bigint,
    reserveOut: bigint,
  ): bigint {
    const amountInWithFee = amountIn * 997n;

    return (
      (amountInWithFee * reserveOut) /
      (reserveIn * 1000n + amountInWithFee)
    );
  }

  async function executeSwap(
    ctx: SwapContext,
    amountAOut: bigint,
    amountBOut: bigint,
    toAccountA: PublicKey = ctx.providerAccountA,
    toAccountB: PublicKey = ctx.providerAccountB,
  ) {
    ctx.svm.expireBlockhash();

    return ctx.program.methods
      .swap(
        new anchor.BN(amountAOut.toString()),
        new anchor.BN(amountBOut.toString()),
        Buffer.alloc(0),
      )
      .accountsPartial({
        pool: ctx.accounts.pool,
        mintA: ctx.mintA,
        mintB: ctx.mintB,
        poolAccountA: ctx.accounts.poolAccountA,
        poolAccountB: ctx.accounts.poolAccountB,
        toAccountA,
        toAccountB,
        trader: ctx.payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        callbackProgram: null,
      })
      .signers([ctx.payer])
      .rpc();
  }

  async function expectSwapFailure(
    operation: () => Promise<unknown>,
    expectedError: string,
  ) {
    try {
      await operation();
      expect.fail("Expected swap to fail");
    } catch (error) {
      expect(String(error)).to.include(expectedError);
    }
  }

  it("swaps token A for token B", async () => {
    const ctx = await setupSwapTest();

    const amountAIn = 10_000_000n;
    const amountBOut = getAmountOut(
      amountAIn,
      100_000_000n,
      100_000_000n,
    );

    await mintTokens(
      ctx.provider,
      ctx.payer,
      ctx.mintA,
      ctx.providerAccountA,
      amountAIn,
    );

    await transferTokens(
      ctx.provider,
      ctx.payer,
      ctx.providerAccountA,
      ctx.accounts.poolAccountA,
      amountAIn,
    );

    await executeSwap(ctx, 0n, amountBOut);

    expect(
      await getTokenAmount(ctx, ctx.providerAccountB),
    ).to.equal(amountBOut);

    expect(
      await getTokenAmount(ctx, ctx.accounts.poolAccountA),
    ).to.equal(100_000_000n + amountAIn);

    expect(
      await getTokenAmount(ctx, ctx.accounts.poolAccountB),
    ).to.equal(100_000_000n - amountBOut);

    const pool = await ctx.program.account.pool.fetch(
      ctx.accounts.pool,
    );

    expect(pool.reserveA.toString()).to.equal(
      (100_000_000n + amountAIn).toString(),
    );

    expect(pool.reserveB.toString()).to.equal(
      (100_000_000n - amountBOut).toString(),
    );
  });

  it("swaps token B for token A", async () => {
    const ctx = await setupSwapTest();

    const amountBIn = 20_000_000n;
    const amountAOut = getAmountOut(
      amountBIn,
      100_000_000n,
      100_000_000n,
    );

    await mintTokens(
      ctx.provider,
      ctx.payer,
      ctx.mintB,
      ctx.providerAccountB,
      amountBIn,
    );

    await transferTokens(
      ctx.provider,
      ctx.payer,
      ctx.providerAccountB,
      ctx.accounts.poolAccountB,
      amountBIn,
    );

    await executeSwap(ctx, amountAOut, 0n);

    expect(
      await getTokenAmount(ctx, ctx.providerAccountA),
    ).to.equal(amountAOut);

    expect(
      await getTokenAmount(ctx, ctx.accounts.poolAccountA),
    ).to.equal(100_000_000n - amountAOut);

    expect(
      await getTokenAmount(ctx, ctx.accounts.poolAccountB),
    ).to.equal(100_000_000n + amountBIn);

    const pool = await ctx.program.account.pool.fetch(
      ctx.accounts.pool,
    );

    expect(pool.reserveA.toString()).to.equal(
      (100_000_000n - amountAOut).toString(),
    );

    expect(pool.reserveB.toString()).to.equal(
      (100_000_000n + amountBIn).toString(),
    );
  });

  it("rejects a swap with zero output amounts", async () => {
    const ctx = await setupSwapTest();

    await expectSwapFailure(
      () => executeSwap(ctx, 0n, 0n),
      "InsufficientOutputAmount",
    );
  });

  it("rejects a swap that requests all pool liquidity", async () => {
    const ctx = await setupSwapTest();

    await expectSwapFailure(
      () => executeSwap(ctx, 100_000_000n, 0n),
      "InsufficientLiquidity",
    );
  });

  it("rejects a swap without input tokens", async () => {
    const ctx = await setupSwapTest();

    await expectSwapFailure(
      () => executeSwap(ctx, 0n, 1_000_000n),
      "InsufficientInputAmount",
    );

    // Failed transaction must not modify reserves.
    const pool = await ctx.program.account.pool.fetch(
      ctx.accounts.pool,
    );

    expect(pool.reserveA.toString()).to.equal("100000000");
    expect(pool.reserveB.toString()).to.equal("100000000");
  });

  it("rejects output exceeding the 0.3% fee-adjusted invariant", async () => {
    const ctx = await setupSwapTest();

    const amountAIn = 10_000_000n;

    await mintTokens(
      ctx.provider,
      ctx.payer,
      ctx.mintA,
      ctx.providerAccountA,
      amountAIn,
    );

    await transferTokens(
      ctx.provider,
      ctx.payer,
      ctx.providerAccountA,
      ctx.accounts.poolAccountA,
      amountAIn,
    );

    const validAmountBOut = getAmountOut(
      amountAIn,
      100_000_000n,
      100_000_000n,
    );

    await expectSwapFailure(
      () => executeSwap(ctx, 0n, validAmountBOut + 1n),
      "InvalidNewK",
    );

    // Input was transferred before the failed swap.
    // The transfer remains, but the failed swap does not.
    expect(
      await getTokenAmount(ctx, ctx.accounts.poolAccountA),
    ).to.equal(110_000_000n);

    expect(
      await getTokenAmount(ctx, ctx.accounts.poolAccountB),
    ).to.equal(100_000_000n);

    const pool = await ctx.program.account.pool.fetch(
      ctx.accounts.pool,
    );

    expect(pool.reserveA.toString()).to.equal("100000000");
    expect(pool.reserveB.toString()).to.equal("100000000");
  });

  it("rejects using the pool vault as the output recipient", async () => {
    const ctx = await setupSwapTest();

    await expectSwapFailure(
      () =>
        executeSwap(
          ctx,
          0n,
          1_000_000n,
          ctx.providerAccountA,
          ctx.accounts.poolAccountB,
        ),
      "InvalidRecipient",
    );
  });

  it("updates reserves after consecutive swaps", async () => {
    const ctx = await setupSwapTest();

    // First swap: A -> B.
    const amountAIn = 10_000_000n;

    const amountBOut = getAmountOut(
      amountAIn,
      100_000_000n,
      100_000_000n,
    );

    await mintTokens(
      ctx.provider,
      ctx.payer,
      ctx.mintA,
      ctx.providerAccountA,
      amountAIn,
    );

    await transferTokens(
      ctx.provider,
      ctx.payer,
      ctx.providerAccountA,
      ctx.accounts.poolAccountA,
      amountAIn,
    );

    await executeSwap(ctx, 0n, amountBOut);

    const reserveAAfterFirst = 100_000_000n + amountAIn;
    const reserveBAfterFirst = 100_000_000n - amountBOut;

    // Second swap: B -> A, using updated reserves.
    const amountBIn = 5_000_000n;

    const amountAOut = getAmountOut(
      amountBIn,
      reserveBAfterFirst,
      reserveAAfterFirst,
    );

    await mintTokens(
      ctx.provider,
      ctx.payer,
      ctx.mintB,
      ctx.providerAccountB,
      amountBIn,
    );

    await transferTokens(
      ctx.provider,
      ctx.payer,
      ctx.providerAccountB,
      ctx.accounts.poolAccountB,
      amountBIn,
    );

    await executeSwap(ctx, amountAOut, 0n);

    const pool = await ctx.program.account.pool.fetch(
      ctx.accounts.pool,
    );

    expect(pool.reserveA.toString()).to.equal(
      (reserveAAfterFirst - amountAOut).toString(),
    );

    expect(pool.reserveB.toString()).to.equal(
      (reserveBAfterFirst + amountBIn).toString(),
    );

    // Trading fees should increase the reserve product.
    const finalK =
      BigInt(pool.reserveA.toString()) *
      BigInt(pool.reserveB.toString());

    expect(finalK > 100_000_000n * 100_000_000n)
      .to.equal(true);
  });
});
