
import * as anchor from "@coral-xyz/anchor";
import { LiteSVMProvider } from "anchor-litesvm";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
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
} from "../helpers/token";
import { derivePoolAccounts } from "../helpers/pool";
import { Clock } from "litesvm";

import type { SolanaV2Amm } from "../../target/types/solana_v2_amm";
import type { SolanaV2Router } from "../../target/types/solana_v2_router";

const ammIdl = JSON.parse(
  readFileSync("target/idl/solana_v2_amm.json", "utf8"),
) as SolanaV2Amm;

const routerIdl = JSON.parse(
  readFileSync("target/idl/solana_v2_router.json", "utf8"),
) as SolanaV2Router;

const DEADLINE = 4_102_444_800; // 2100-01-01 UTC

async function setup() {
  const svm = createTestSvm();
  const provider = new LiteSVMProvider(svm);

  const amm = new anchor.Program<SolanaV2Amm>(
    ammIdl,
    provider,
  );

  const router = new anchor.Program<SolanaV2Router>(
    routerIdl,
    provider,
  );

  // AMM config initialization requires the authorized payer.
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
    amm.programId,
  );

  await amm.methods
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
    amm.programId,
    mintA,
    mintB,
  );

  await amm.methods
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

  const userAccountA = await createTokenAccount(
    provider,
    payer,
    mintA,
    payer.publicKey,
  );

  const userAccountB = await createTokenAccount(
    provider,
    payer,
    mintB,
    payer.publicKey,
  );

  const toLpAccount = await createTokenAccount(
    provider,
    payer,
    accounts.mintLp,
    payer.publicKey,
  );

  await mintTokens(
    provider,
    payer,
    mintA,
    userAccountA,
    1_000_000_000n,
  );

  await mintTokens(
    provider,
    payer,
    mintB,
    userAccountB,
    1_000_000_000n,
  );

  return {
    svm,
    provider,
    amm,
    router,
    payer,
    ammConfig,
    mintA,
    mintB,
    accounts,
    userAccountA,
    userAccountB,
    toLpAccount,
  };
}

type Context = Awaited<ReturnType<typeof setup>>;

async function balance(ctx: Context, address: PublicKey) {
  const info = await ctx.provider.connection.getAccountInfo(address);

  if (!info) {
    throw new Error(`Token account not found: ${address.toBase58()}`);
  }

  return unpackAccount(address, info).amount;
}

async function addLiquidity(
  ctx: Context,
  amountADesired: bigint,
  amountBDesired: bigint,
  amountAMin = 0n,
  amountBMin = 0n,
  deadline = DEADLINE,
) {
  ctx.svm.expireBlockhash();

  return ctx.router.methods
    .addLiquidity(
      new anchor.BN(amountADesired.toString()),
      new anchor.BN(amountBDesired.toString()),
      new anchor.BN(amountAMin.toString()),
      new anchor.BN(amountBMin.toString()),
      new anchor.BN(deadline),
    )
    .accountsPartial({
      ammProgram: ctx.amm.programId,
      ammConfig: ctx.ammConfig,
      pool: ctx.accounts.pool,
      mintA: ctx.mintA,
      mintB: ctx.mintB,
      userAccountA: ctx.userAccountA,
      userAccountB: ctx.userAccountB,
      poolAccountA: ctx.accounts.poolAccountA,
      poolAccountB: ctx.accounts.poolAccountB,
      lockedLpAccount: ctx.accounts.lockedLpAccount,
      mintLp: ctx.accounts.mintLp,
      feeToLpAccount: null,
      toLpAccount: ctx.toLpAccount,
      provider: ctx.payer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([ctx.payer])
    .rpc();
}

describe("Router - add_liquidity", () => {
  it("adds initial liquidity and mints LP tokens", async () => {
    const ctx = await setup();

    await addLiquidity(
      ctx,
      100_000_000n,
      100_000_000n,
      100_000_000n,
      100_000_000n,
    );

    const pool = await ctx.amm.account.pool.fetch(
      ctx.accounts.pool,
    );

    expect(pool.reserveA.toString()).to.equal("100000000");
    expect(pool.reserveB.toString()).to.equal("100000000");

    expect(await balance(ctx, ctx.toLpAccount)).to.equal(
      99_999_000n,
    );

    expect(
      await balance(ctx, ctx.accounts.lockedLpAccount),
    ).to.equal(1_000n);

    expect(await balance(ctx, ctx.userAccountA)).to.equal(
      900_000_000n,
    );

    expect(await balance(ctx, ctx.userAccountB)).to.equal(
      900_000_000n,
    );
  });

  it("adds liquidity at the existing pool ratio", async () => {
    const ctx = await setup();

    // Establish a 2:1 A/B reserve ratio.
    await addLiquidity(
      ctx,
      200_000_000n,
      100_000_000n,
    );

    const beforeA = await balance(ctx, ctx.userAccountA);
    const beforeB = await balance(ctx, ctx.userAccountB);
    const beforeLp = await balance(ctx, ctx.toLpAccount);

    // Desired ratio is 3:1, but the pool requires 2:1.
    await addLiquidity(
      ctx,
      60_000_000n,
      20_000_000n,
    );

    const afterA = await balance(ctx, ctx.userAccountA);
    const afterB = await balance(ctx, ctx.userAccountB);
    const afterLp = await balance(ctx, ctx.toLpAccount);

    // Router uses 40 A and 20 B, leaving 20 A untouched.
    expect(beforeA - afterA).to.equal(40_000_000n);
    expect(beforeB - afterB).to.equal(20_000_000n);

    expect(afterLp - beforeLp > 0n).to.equal(true);

    const pool = await ctx.amm.account.pool.fetch(
      ctx.accounts.pool,
    );

    expect(pool.reserveA.toString()).to.equal("240000000");
    expect(pool.reserveB.toString()).to.equal("120000000");
  });

  it("rejects liquidity when minimum amounts cannot be met", async () => {
    const ctx = await setup();

    await addLiquidity(
      ctx,
      200_000_000n,
      100_000_000n,
    );

    const beforeA = await balance(ctx, ctx.userAccountA);
    const beforeB = await balance(ctx, ctx.userAccountB);

    let rejected = false;

    try {
      // Pool ratio requires 40 A / 20 B,
      // but minimum A is 50.
      await addLiquidity(
        ctx,
        60_000_000n,
        20_000_000n,
        50_000_000n,
        20_000_000n,
      );
    } catch {
      rejected = true;
    }

    expect(rejected).to.equal(true);

    // Failed transactions must not transfer tokens.
    expect(await balance(ctx, ctx.userAccountA)).to.equal(beforeA);
    expect(await balance(ctx, ctx.userAccountB)).to.equal(beforeB);
  });

  it("rejects expired deadlines", async () => {
    const ctx = await setup();

    const clock = ctx.svm.getClock();

    ctx.svm.setClock(
      new Clock(
        clock.slot,
        clock.epochStartTimestamp,
        clock.epoch,
        clock.leaderScheduleEpoch,
        1_000n,
      ),
    );

    const beforeA = await balance(ctx, ctx.userAccountA);
    const beforeB = await balance(ctx, ctx.userAccountB);

    let rejected = false;

    try {
      await addLiquidity(
        ctx,
        100_000_000n,
        100_000_000n,
        0n,
        0n,
        999,
      );
    } catch (error) {
      if (
        error instanceof anchor.AnchorError &&
        error.error.errorCode.code === "Expired"
      ) {
        rejected = true;
      } else {
        throw error;
      }
    }

    expect(rejected).to.equal(true);

    expect(await balance(ctx, ctx.userAccountA)).to.equal(beforeA);
    expect(await balance(ctx, ctx.userAccountB)).to.equal(beforeB);
  });

  it("rejects deposits exceeding the user's token balance", async () => {
    const ctx = await setup();

    const beforeA = await balance(ctx, ctx.userAccountA);
    const beforeB = await balance(ctx, ctx.userAccountB);

    let rejected = false;

    try {
      await addLiquidity(
        ctx,
        2_000_000_000n,
        2_000_000_000n,
      );
    } catch {
      rejected = true;
    }

    expect(rejected).to.equal(true);

    expect(await balance(ctx, ctx.userAccountA)).to.equal(beforeA);
    expect(await balance(ctx, ctx.userAccountB)).to.equal(beforeB);
  });
});
