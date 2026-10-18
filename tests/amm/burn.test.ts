
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

describe("AMM - burn", () => {
  async function setupBurnTest() {
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

  type BurnContext = Awaited<
    ReturnType<typeof setupBurnTest>
  >;

  async function getTokenAmount(
    ctx: BurnContext,
    address: PublicKey,
  ): Promise<bigint> {
    const accountInfo =
      await ctx.provider.connection.getAccountInfo(address);

    if (!accountInfo) {
      throw new Error("Token account not found");
    }

    return unpackAccount(
      address,
      accountInfo,
    ).amount;
  }

  async function getLpSupply(
    ctx: BurnContext,
  ): Promise<bigint> {
    const mintInfo =
      await ctx.provider.connection.getAccountInfo(
        ctx.accounts.mintLp,
      );

    if (!mintInfo) {
      throw new Error("LP mint not found");
    }

    return unpackMint(
      ctx.accounts.mintLp,
      mintInfo,
    ).supply;
  }

  async function depositLiquidity(
    ctx: BurnContext,
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

  async function burnLiquidity(
    ctx: BurnContext,
    liquidity: bigint,
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

    // Transfer LP tokens to the pool before burning.
    await transferTokens(
      provider,
      payer,
      providerLpAccount,
      accounts.poolAccountLp,
      liquidity,
    );

    svm.expireBlockhash();

    await program.methods
      .burn()
      .accountsPartial({
        ammConfig,
        pool: accounts.pool,
        mintA,
        mintB,
        poolAccountA: accounts.poolAccountA,
        poolAccountB: accounts.poolAccountB,
        mintLp: accounts.mintLp,
        poolAccountLp: accounts.poolAccountLp,
        feeToLpAccount: null,
        toAccountA: providerAccountA,
        toAccountB: providerAccountB,
        provider: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([payer])
      .rpc();
  }

  it("burns all provider LP tokens and returns underlying tokens", async () => {
    const ctx = await setupBurnTest();

    await depositLiquidity(
      ctx,
      1_000_000n,
      4_000_000n,
    );

    // sqrt(1,000,000 * 4,000,000) = 2,000,000.
    // 1,000 LP tokens are permanently locked.
    const providerLiquidity = 1_999_000n;

    await burnLiquidity(ctx, providerLiquidity);

    const expectedA =
      (providerLiquidity * 1_000_000n) /
      2_000_000n;

    const expectedB =
      (providerLiquidity * 4_000_000n) /
      2_000_000n;

    expect(
      await getTokenAmount(ctx, ctx.providerAccountA),
    ).to.equal(expectedA);

    expect(
      await getTokenAmount(ctx, ctx.providerAccountB),
    ).to.equal(expectedB);

    expect(
      await getTokenAmount(ctx, ctx.providerLpAccount),
    ).to.equal(0n);

    expect(
      await getTokenAmount(ctx, ctx.accounts.poolAccountLp),
    ).to.equal(0n);

    expect(await getLpSupply(ctx)).to.equal(1_000n);

    expect(
      await getTokenAmount(ctx, ctx.accounts.lockedLpAccount),
    ).to.equal(1_000n);

    const pool = await ctx.program.account.pool.fetch(
      ctx.accounts.pool,
    );

    expect(pool.reserveA.toString()).to.equal(
      (1_000_000n - expectedA).toString(),
    );

    expect(pool.reserveB.toString()).to.equal(
      (4_000_000n - expectedB).toString(),
    );
  });

  it("burns a partial LP position proportionally", async () => {
    const ctx = await setupBurnTest();

    await depositLiquidity(
      ctx,
      1_000_000n,
      4_000_000n,
    );

    const liquidityToBurn = 500_000n;

    await burnLiquidity(ctx, liquidityToBurn);

    expect(
      await getTokenAmount(ctx, ctx.providerAccountA),
    ).to.equal(250_000n);

    expect(
      await getTokenAmount(ctx, ctx.providerAccountB),
    ).to.equal(1_000_000n);

    expect(
      await getTokenAmount(ctx, ctx.providerLpAccount),
    ).to.equal(1_499_000n);

    expect(await getLpSupply(ctx)).to.equal(1_500_000n);

    const pool = await ctx.program.account.pool.fetch(
      ctx.accounts.pool,
    );

    expect(pool.reserveA.toString()).to.equal("750000");
    expect(pool.reserveB.toString()).to.equal("3000000");
  });

  it("preserves permanently locked minimum liquidity", async () => {
    const ctx = await setupBurnTest();

    await depositLiquidity(
      ctx,
      1_000_000n,
      4_000_000n,
    );

    await burnLiquidity(ctx, 1_999_000n);

    expect(await getLpSupply(ctx)).to.equal(1_000n);

    expect(
      await getTokenAmount(ctx, ctx.accounts.lockedLpAccount),
    ).to.equal(1_000n);

    expect(
      await getTokenAmount(ctx, ctx.accounts.poolAccountA),
    ).to.equal(500n);

    expect(
      await getTokenAmount(ctx, ctx.accounts.poolAccountB),
    ).to.equal(2_000n);
  });

  it("rejects burning when no LP tokens were transferred", async () => {
    const ctx = await setupBurnTest();

    await depositLiquidity(
      ctx,
      1_000_000n,
      4_000_000n,
    );

    ctx.svm.expireBlockhash();

    try {
      await ctx.program.methods
        .burn()
        .accountsPartial({
          ammConfig: ctx.ammConfig,
          pool: ctx.accounts.pool,
          mintA: ctx.mintA,
          mintB: ctx.mintB,
          poolAccountA: ctx.accounts.poolAccountA,
          poolAccountB: ctx.accounts.poolAccountB,
          mintLp: ctx.accounts.mintLp,
          poolAccountLp: ctx.accounts.poolAccountLp,
          feeToLpAccount: null,
          toAccountA: ctx.providerAccountA,
          toAccountB: ctx.providerAccountB,
          provider: ctx.payer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([ctx.payer])
        .rpc();

      expect.fail("Expected burn to fail");
    } catch (error) {
      expect(String(error)).to.include(
        "InsufficientLiquidityBurned",
      );
    }

    expect(await getLpSupply(ctx)).to.equal(2_000_000n);
  });

  it("rejects burning LP tokens when output rounds to zero", async () => {
    const ctx = await setupBurnTest();

    await depositLiquidity(
      ctx,
      1_000_000n,
      4_000_000n,
    );

    // Burning 1 LP would return:
    // floor(1 * 1,000,000 / 2,000,000) = 0 token A.
    await transferTokens(
      ctx.provider,
      ctx.payer,
      ctx.providerLpAccount,
      ctx.accounts.poolAccountLp,
      1n,
    );

    ctx.svm.expireBlockhash();

    try {
      await ctx.program.methods
        .burn()
        .accountsPartial({
          ammConfig: ctx.ammConfig,
          pool: ctx.accounts.pool,
          mintA: ctx.mintA,
          mintB: ctx.mintB,
          poolAccountA: ctx.accounts.poolAccountA,
          poolAccountB: ctx.accounts.poolAccountB,
          mintLp: ctx.accounts.mintLp,
          poolAccountLp: ctx.accounts.poolAccountLp,
          feeToLpAccount: null,
          toAccountA: ctx.providerAccountA,
          toAccountB: ctx.providerAccountB,
          provider: ctx.payer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([ctx.payer])
        .rpc();

      expect.fail("Expected burn to fail");
    } catch (error) {
      expect(String(error)).to.include(
        "InsufficientLiquidityBurned",
      );
    }

    // Failed burn must not change LP supply.
    expect(await getLpSupply(ctx)).to.equal(2_000_000n);

    // LP transfer happened before burn(), so it remains in the pool.
    expect(
      await getTokenAmount(ctx, ctx.accounts.poolAccountLp),
    ).to.equal(1n);
  });

  it("keeps k_last at zero when protocol fees are disabled", async () => {
    const ctx = await setupBurnTest();

    await depositLiquidity(
      ctx,
      1_000_000n,
      4_000_000n,
    );

    await burnLiquidity(ctx, 500_000n);

    const pool = await ctx.program.account.pool.fetch(
      ctx.accounts.pool,
    );

    expect(pool.kLast.isZero()).to.equal(true);
  });


  it("mints protocol LP fees and calculates withdrawals correctly after a swap", async () => {
    const ctx = await setupBurnTest();

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

    // Initial liquidity: 100M A + 100M B.
    await depositLiquidity(ctx, 100_000_000n, 100_000_000n);

    const initialReserveA = 100_000_000n;
    const initialReserveB = 100_000_000n;
    const initialKLast = initialReserveA * initialReserveB;

    let pool = await program.account.pool.fetch(accounts.pool);

    expect(
      pool.kLast.eq(new anchor.BN(initialKLast.toString())),
    ).to.equal(true);

    // Execute a swap: 50M A -> B.
    const amountAIn = 50_000_000n;
    const amountAInWithFee = amountAIn * 997n;

    const amountBOut =
      (amountAInWithFee * initialReserveB) /
      (initialReserveA * 1000n + amountAInWithFee);

    await mintTokens(
      provider,
      payer,
      mintA,
      providerAccountA,
      amountAIn,
    );

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

    const reserveAAfterSwap = initialReserveA + amountAIn;
    const reserveBAfterSwap = initialReserveB - amountBOut;

    pool = await program.account.pool.fetch(accounts.pool);

    expect(pool.reserveA.toString()).to.equal(
      reserveAAfterSwap.toString(),
    );

    expect(pool.reserveB.toString()).to.equal(
      reserveBAfterSwap.toString(),
    );

    // Swaps do not update k_last.
    expect(
      pool.kLast.eq(new anchor.BN(initialKLast.toString())),
    ).to.equal(true);

    // Integer square root, matching Rust u128::isqrt().
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

    const rootK = sqrt(
      reserveAAfterSwap * reserveBAfterSwap,
    );
    const rootKLast = sqrt(initialKLast);

    expect(rootK > rootKLast).to.equal(true);

    const supplyBeforeBurn = await getLpSupply(ctx);

    // Same protocol-fee formula as mint_fee() in Rust.
    const expectedProtocolFee =
      (supplyBeforeBurn * (rootK - rootKLast)) /
      (rootK * 5n + rootKLast);

    expect(expectedProtocolFee > 0n).to.equal(true);

    // Burn 20M provider LP tokens.
    const liquidityToBurn = 20_000_000n;

    await transferTokens(
      provider,
      payer,
      providerLpAccount,
      accounts.poolAccountLp,
      liquidityToBurn,
    );

    // The protocol fee is minted BEFORE calculating withdrawals.
    const supplyAfterProtocolFee =
      supplyBeforeBurn + expectedProtocolFee;

    const expectedAmountA =
      (liquidityToBurn * reserveAAfterSwap) /
      supplyAfterProtocolFee;

    const expectedAmountB =
      (liquidityToBurn * reserveBAfterSwap) /
      supplyAfterProtocolFee;

    const providerABefore = await getTokenAmount(
      ctx,
      providerAccountA,
    );

    const providerBBefore = await getTokenAmount(
      ctx,
      providerAccountB,
    );

    svm.expireBlockhash();

    await program.methods
      .burn()
      .accountsPartial({
        ammConfig,
        pool: accounts.pool,
        mintA,
        mintB,
        poolAccountA: accounts.poolAccountA,
        poolAccountB: accounts.poolAccountB,
        mintLp: accounts.mintLp,
        poolAccountLp: accounts.poolAccountLp,
        feeToLpAccount,
        toAccountA: providerAccountA,
        toAccountB: providerAccountB,
        provider: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([payer])
      .rpc();

    // 1. Protocol receives the exact LP fee.
    expect(
      await getTokenAmount(ctx, feeToLpAccount),
    ).to.equal(expectedProtocolFee);

    // 2. Provider receives the correct underlying tokens.
    expect(
      await getTokenAmount(ctx, providerAccountA),
    ).to.equal(providerABefore + expectedAmountA);

    expect(
      await getTokenAmount(ctx, providerAccountB),
    ).to.equal(providerBBefore + expectedAmountB);

    // 3. Provider's LP balance decreases by burned liquidity.
    expect(
      await getTokenAmount(ctx, providerLpAccount),
    ).to.equal(99_999_000n - liquidityToBurn);

    // 4. Pool's LP account is empty after burning.
    expect(
      await getTokenAmount(ctx, accounts.poolAccountLp),
    ).to.equal(0n);

    // 5. Total LP supply accounts for protocol mint and burn.
    const expectedTotalSupply =
      supplyAfterProtocolFee - liquidityToBurn;

    expect(await getLpSupply(ctx)).to.equal(
      expectedTotalSupply,
    );

    // 6. Locked minimum liquidity remains untouched.
    expect(
      await getTokenAmount(ctx, accounts.lockedLpAccount),
    ).to.equal(1_000n);

    // 7. Reserves reflect the withdrawn amounts.
    const expectedReserveA =
      reserveAAfterSwap - expectedAmountA;

    const expectedReserveB =
      reserveBAfterSwap - expectedAmountB;

    pool = await program.account.pool.fetch(accounts.pool);

    expect(pool.reserveA.toString()).to.equal(
      expectedReserveA.toString(),
    );

    expect(pool.reserveB.toString()).to.equal(
      expectedReserveB.toString(),
    );

    // 8. k_last updates to the new reserve product.
    expect(
      pool.kLast.eq(
        new anchor.BN(
          (expectedReserveA * expectedReserveB).toString(),
        ),
      ),
    ).to.equal(true);
  });


  it("resets k_last when protocol fees are disabled before burning", async () => {
    const ctx = await setupBurnTest();

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

    // Initial liquidity establishes k_last.
    await depositLiquidity(ctx, 1_000_000n, 4_000_000n);

    const initialKLast = 4_000_000_000_000n;

    let pool = await ctx.program.account.pool.fetch(
      ctx.accounts.pool,
    );

    expect(
      pool.kLast.eq(new anchor.BN(initialKLast.toString())),
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

    // k_last remains unchanged until the next mint or burn.
    pool = await ctx.program.account.pool.fetch(
      ctx.accounts.pool,
    );

    expect(
      pool.kLast.eq(new anchor.BN(initialKLast.toString())),
    ).to.equal(true);

    // Burn 500,000 LP tokens.
    await burnLiquidity(ctx, 500_000n);

    // Protocol fees are disabled, so k_last must reset.
    pool = await ctx.program.account.pool.fetch(
      ctx.accounts.pool,
    );

    expect(pool.kLast.isZero()).to.equal(true);

    // No protocol LP tokens were minted.
    expect(await getLpSupply(ctx)).to.equal(1_500_000n);

    // Provider received proportional withdrawals.
    expect(
      await getTokenAmount(ctx, ctx.providerAccountA),
    ).to.equal(250_000n);

    expect(
      await getTokenAmount(ctx, ctx.providerAccountB),
    ).to.equal(1_000_000n);

    expect(pool.reserveA.toString()).to.equal("750000");
    expect(pool.reserveB.toString()).to.equal("3000000");
  });
});
