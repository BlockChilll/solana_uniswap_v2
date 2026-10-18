
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

describe("AMM - skim & sync", () => {
  async function setupTest() {
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

    const initialLiquidity = 1_000_000n;

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

  type TestContext = Awaited<ReturnType<typeof setupTest>>;

  async function balance(
    ctx: TestContext,
    address: PublicKey,
  ): Promise<bigint> {
    const info =
      await ctx.provider.connection.getAccountInfo(address);

    if (!info) {
      throw new Error("Token account not found");
    }

    return unpackAccount(address, info).amount;
  }

  async function donate(
    ctx: TestContext,
    amountA: bigint,
    amountB: bigint,
  ) {
    if (amountA > 0n) {
      await mintTokens(
        ctx.provider,
        ctx.payer,
        ctx.mintA,
        ctx.providerAccountA,
        amountA,
      );

      await transferTokens(
        ctx.provider,
        ctx.payer,
        ctx.providerAccountA,
        ctx.accounts.poolAccountA,
        amountA,
      );
    }

    if (amountB > 0n) {
      await mintTokens(
        ctx.provider,
        ctx.payer,
        ctx.mintB,
        ctx.providerAccountB,
        amountB,
      );

      await transferTokens(
        ctx.provider,
        ctx.payer,
        ctx.providerAccountB,
        ctx.accounts.poolAccountB,
        amountB,
      );
    }
  }

  async function skim(ctx: TestContext) {
    ctx.svm.expireBlockhash();

    await ctx.program.methods
      .skim()
      .accountsPartial({
        pool: ctx.accounts.pool,
        mintA: ctx.mintA,
        mintB: ctx.mintB,
        poolAccountA: ctx.accounts.poolAccountA,
        poolAccountB: ctx.accounts.poolAccountB,
        toAccountA: ctx.providerAccountA,
        toAccountB: ctx.providerAccountB,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
  }

  async function sync(ctx: TestContext) {
    ctx.svm.expireBlockhash();

    await ctx.program.methods
      .sync()
      .accountsPartial({
        pool: ctx.accounts.pool,
        mintA: ctx.mintA,
        mintB: ctx.mintB,
        poolAccountA: ctx.accounts.poolAccountA,
        poolAccountB: ctx.accounts.poolAccountB,
      })
      .rpc();
  }

  it("skim transfers excess tokens without changing reserves", async () => {
    const ctx = await setupTest();

    await donate(ctx, 100_000n, 200_000n);

    await skim(ctx);

    expect(
      await balance(ctx, ctx.providerAccountA),
    ).to.equal(100_000n);

    expect(
      await balance(ctx, ctx.providerAccountB),
    ).to.equal(200_000n);

    expect(
      await balance(ctx, ctx.accounts.poolAccountA),
    ).to.equal(1_000_000n);

    expect(
      await balance(ctx, ctx.accounts.poolAccountB),
    ).to.equal(1_000_000n);

    const pool = await ctx.program.account.pool.fetch(
      ctx.accounts.pool,
    );

    expect(pool.reserveA.toString()).to.equal("1000000");
    expect(pool.reserveB.toString()).to.equal("1000000");
  });

  it("skim succeeds when there are no excess tokens", async () => {
    const ctx = await setupTest();

    await skim(ctx);

    expect(
      await balance(ctx, ctx.accounts.poolAccountA),
    ).to.equal(1_000_000n);

    expect(
      await balance(ctx, ctx.accounts.poolAccountB),
    ).to.equal(1_000_000n);
  });

  it("skim rejects using a pool vault as its recipient", async () => {
    const ctx = await setupTest();

    ctx.svm.expireBlockhash();

    try {
      await ctx.program.methods
        .skim()
        .accountsPartial({
          pool: ctx.accounts.pool,
          mintA: ctx.mintA,
          mintB: ctx.mintB,
          poolAccountA: ctx.accounts.poolAccountA,
          poolAccountB: ctx.accounts.poolAccountB,
          toAccountA: ctx.accounts.poolAccountA,
          toAccountB: ctx.providerAccountB,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      expect.fail("Expected skim to reject invalid recipient");
    } catch (error) {
      expect(String(error)).to.include("InvalidRecipient");
    }
  });

  it("sync updates reserves to match donated vault balances", async () => {
    const ctx = await setupTest();

    await donate(ctx, 100_000n, 200_000n);

    await sync(ctx);

    const pool = await ctx.program.account.pool.fetch(
      ctx.accounts.pool,
    );

    expect(pool.reserveA.toString()).to.equal("1100000");
    expect(pool.reserveB.toString()).to.equal("1200000");

    expect(
      await balance(ctx, ctx.accounts.poolAccountA),
    ).to.equal(1_100_000n);

    expect(
      await balance(ctx, ctx.accounts.poolAccountB),
    ).to.equal(1_200_000n);
  });

  it("sync succeeds when reserves already match balances", async () => {
    const ctx = await setupTest();

    await sync(ctx);

    const pool = await ctx.program.account.pool.fetch(
      ctx.accounts.pool,
    );

    expect(pool.reserveA.toString()).to.equal("1000000");
    expect(pool.reserveB.toString()).to.equal("1000000");
  });

  it("skim after sync cannot recover already-synchronized donations", async () => {
    const ctx = await setupTest();

    await donate(ctx, 100_000n, 200_000n);

    await sync(ctx);
    await skim(ctx);

    expect(
      await balance(ctx, ctx.providerAccountA),
    ).to.equal(0n);

    expect(
      await balance(ctx, ctx.providerAccountB),
    ).to.equal(0n);

    expect(
      await balance(ctx, ctx.accounts.poolAccountA),
    ).to.equal(1_100_000n);

    expect(
      await balance(ctx, ctx.accounts.poolAccountB),
    ).to.equal(1_200_000n);
  });
});
