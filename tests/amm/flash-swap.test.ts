
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
import type { FlashBorrower } from "../../target/types/flash_borrower";

const ammIdl = JSON.parse(
  readFileSync("target/idl/solana_v2_amm.json", "utf8"),
) as SolanaV2Amm;

const flashBorrowerIdl = JSON.parse(
  readFileSync("target/idl/flash_borrower.json", "utf8"),
) as FlashBorrower;

describe("AMM - flash swap", () => {
  async function setupFlashSwapTest() {
    const svm = createTestSvm();
    const provider = new LiteSVMProvider(svm);

    const program = new anchor.Program<SolanaV2Amm>(
      ammIdl,
      provider,
    );

    const flashBorrower = new anchor.Program<FlashBorrower>(
      flashBorrowerIdl,
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
      flashBorrower,
      payer,
      mintA,
      mintB,
      accounts,
      providerAccountA,
      providerAccountB,
    };
  }

  type FlashContext = Awaited<
    ReturnType<typeof setupFlashSwapTest>
  >;

  async function getTokenAmount(
    ctx: FlashContext,
    address: PublicKey,
  ): Promise<bigint> {
    const info =
      await ctx.provider.connection.getAccountInfo(address);

    if (!info) {
      throw new Error("Token account not found");
    }

    return unpackAccount(address, info).amount;
  }

  function minimumRepayment(
    amountBorrowed: bigint,
  ): bigint {
    // For borrowing and repaying the same token:
    // (reserve - borrowed + repayment) * 1000
    //   - repayment * 3 >= reserve * 1000
    //
    // Therefore:
    // repayment * 997 >= borrowed * 1000.
    return (
      (amountBorrowed * 1000n + 996n) / 997n
    );
  }

  function callbackData(
    ctx: FlashContext,
    repaymentAmount: bigint,
  ): Buffer {
    return ctx.flashBorrower.coder.instruction.encode(
      "flashSwapCallback",
      {
        repaymentAmount: new anchor.BN(
          repaymentAmount.toString(),
        ),
      },
    );
  }

  async function executeFlashSwap(
    ctx: FlashContext,
    amountBorrowed: bigint,
    repaymentAmount: bigint,
    callbackProgram: PublicKey | null =
      ctx.flashBorrower.programId,
  ) {
    ctx.svm.expireBlockhash();

    return ctx.program.methods
      .swap(
        new anchor.BN(amountBorrowed.toString()),
        new anchor.BN(0),
        callbackData(ctx, repaymentAmount),
      )
      .accountsPartial({
        pool: ctx.accounts.pool,
        mintA: ctx.mintA,
        mintB: ctx.mintB,
        poolAccountA: ctx.accounts.poolAccountA,
        poolAccountB: ctx.accounts.poolAccountB,
        toAccountA: ctx.providerAccountA,
        toAccountB: ctx.providerAccountB,
        trader: ctx.payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        callbackProgram,
      })
      .signers([ctx.payer])
      .rpc();
  }

  async function expectFailure(
    operation: () => Promise<unknown>,
    expectedError: string,
  ) {
    let failed = false;

    try {
      await operation();
    } catch (error) {
      failed = true;
      expect(String(error)).to.include(expectedError);
    }

    expect(failed, "Expected transaction to fail").to.equal(true);
  }

  it("borrows token A and repays principal plus fee in the callback", async () => {
    const ctx = await setupFlashSwapTest();

    const amountBorrowed = 10_000_000n;
    const repaymentAmount = minimumRepayment(
      amountBorrowed,
    );

    const fee = repaymentAmount - amountBorrowed;

    // The borrower needs enough tokens to pay the fee.
    await mintTokens(
      ctx.provider,
      ctx.payer,
      ctx.mintA,
      ctx.providerAccountA,
      fee,
    );

    await executeFlashSwap(
      ctx,
      amountBorrowed,
      repaymentAmount,
    );

    // Borrowed amount arrives before callback;
    // callback repays borrowed amount + fee.
    expect(
      await getTokenAmount(ctx, ctx.providerAccountA),
    ).to.equal(0n);

    expect(
      await getTokenAmount(
        ctx,
        ctx.accounts.poolAccountA,
      ),
    ).to.equal(100_000_000n + fee);

    expect(
      await getTokenAmount(
        ctx,
        ctx.accounts.poolAccountB,
      ),
    ).to.equal(100_000_000n);

    const pool = await ctx.program.account.pool.fetch(
      ctx.accounts.pool,
    );

    expect(pool.reserveA.toString()).to.equal(
      (100_000_000n + fee).toString(),
    );

    expect(pool.reserveB.toString()).to.equal("100000000");
  });

  it("rejects insufficient flash swap repayment and rolls back transfers", async () => {
    const ctx = await setupFlashSwapTest();

    const amountBorrowed = 10_000_000n;

    // Repay principal only, without the required fee.
    const repaymentAmount = amountBorrowed;

    const borrowerBalanceBefore = await getTokenAmount(
      ctx,
      ctx.providerAccountA,
    );

    const poolBalanceBefore = await getTokenAmount(
      ctx,
      ctx.accounts.poolAccountA,
    );

    await expectFailure(
      () =>
        executeFlashSwap(
          ctx,
          amountBorrowed,
          repaymentAmount,
        ),
      "InvalidNewK",
    );

    // The callback transfer and flash borrow must both roll back.
    expect(
      await getTokenAmount(ctx, ctx.providerAccountA),
    ).to.equal(borrowerBalanceBefore);

    expect(
      await getTokenAmount(ctx, ctx.accounts.poolAccountA),
    ).to.equal(poolBalanceBefore);

    const pool = await ctx.program.account.pool.fetch(
      ctx.accounts.pool,
    );

    expect(pool.reserveA.toString()).to.equal("100000000");
    expect(pool.reserveB.toString()).to.equal("100000000");
  });

  it("rejects callback data without a callback program", async () => {
    const ctx = await setupFlashSwapTest();

    await expectFailure(
      () =>
        executeFlashSwap(
          ctx,
          10_000_000n,
          10_030_091n,
          null,
        ),
      "MissingCallbackProgram",
    );

    expect(
      await getTokenAmount(
        ctx,
        ctx.accounts.poolAccountA,
      ),
    ).to.equal(100_000_000n);
  });

  it("rejects callback repayment exceeding the borrower's balance", async () => {
    const ctx = await setupFlashSwapTest();

    const amountBorrowed = 10_000_000n;

    // Borrower receives 10M, but tries to repay 11M.
    // No extra funds have been minted.
    await expectFailure(
      () =>
        executeFlashSwap(
          ctx,
          amountBorrowed,
          11_000_000n,
        ),
      "insufficient funds",
    );

    // Failed CPI must roll back the initial flash transfer.
    expect(
      await getTokenAmount(ctx, ctx.providerAccountA),
    ).to.equal(0n);

    expect(
      await getTokenAmount(
        ctx,
        ctx.accounts.poolAccountA,
      ),
    ).to.equal(100_000_000n);

    const pool = await ctx.program.account.pool.fetch(
      ctx.accounts.pool,
    );

    expect(pool.reserveA.toString()).to.equal("100000000");
    expect(pool.reserveB.toString()).to.equal("100000000");
  });
});
