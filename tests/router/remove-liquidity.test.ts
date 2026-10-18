
import * as anchor from "@coral-xyz/anchor";
import { LiteSVMProvider } from "anchor-litesvm";
import { Clock } from "litesvm";
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
} from "../helpers/token";
import { derivePoolAccounts } from "../helpers/pool";

import type { SolanaV2Amm } from "../../target/types/solana_v2_amm";
import type { SolanaV2Router } from "../../target/types/solana_v2_router";

const ammIdl = JSON.parse(
  readFileSync("target/idl/solana_v2_amm.json", "utf8"),
) as SolanaV2Amm;

const routerIdl = JSON.parse(
  readFileSync("target/idl/solana_v2_router.json", "utf8"),
) as SolanaV2Router;

const DEADLINE = 4_102_444_800;
const INITIAL_LIQUIDITY = 100_000_000n;
const REMOVE_LIQUIDITY = 50_000_000n;

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
    10n * BigInt(anchor.web3.LAMPORTS_PER_SOL),
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

  const userLpAccount = await createTokenAccount(
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

  svm.expireBlockhash();

  await router.methods
    .addLiquidity(
      new anchor.BN(INITIAL_LIQUIDITY.toString()),
      new anchor.BN(INITIAL_LIQUIDITY.toString()),
      new anchor.BN(0),
      new anchor.BN(0),
      new anchor.BN(DEADLINE),
    )
    .accountsPartial({
      ammProgram: amm.programId,
      ammConfig,
      pool: accounts.pool,
      mintA,
      mintB,
      userAccountA,
      userAccountB,
      poolAccountA: accounts.poolAccountA,
      poolAccountB: accounts.poolAccountB,
      lockedLpAccount: accounts.lockedLpAccount,
      mintLp: accounts.mintLp,
      feeToLpAccount: null,
      toLpAccount: userLpAccount,
      provider: payer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([payer])
    .rpc();

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
    userLpAccount,
  };
}

type Context = Awaited<ReturnType<typeof setup>>;

async function balance(
  ctx: Context,
  address: PublicKey,
): Promise<bigint> {
  const info = await ctx.provider.connection.getAccountInfo(address);

  if (!info) {
    throw new Error(`Token account not found: ${address.toBase58()}`);
  }

  return unpackAccount(address, info).amount;
}

async function reserves(ctx: Context) {
  const pool = await ctx.amm.account.pool.fetch(
    ctx.accounts.pool,
  );

  return {
    a: BigInt(pool.reserveA.toString()),
    b: BigInt(pool.reserveB.toString()),
  };
}

async function snapshot(ctx: Context) {
  return {
    userA: await balance(ctx, ctx.userAccountA),
    userB: await balance(ctx, ctx.userAccountB),
    userLp: await balance(ctx, ctx.userLpAccount),
    poolA: await balance(ctx, ctx.accounts.poolAccountA),
    poolB: await balance(ctx, ctx.accounts.poolAccountB),
    poolLp: await balance(ctx, ctx.accounts.poolAccountLp),
    reserves: await reserves(ctx),
  };
}

async function removeLiquidity(
  ctx: Context,
  liquidity: bigint,
  amountAMin = 0n,
  amountBMin = 0n,
  deadline = DEADLINE,
) {
  ctx.svm.expireBlockhash();

  return ctx.router.methods
    .removeLiquidity(
      new anchor.BN(liquidity.toString()),
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
      userLpAccount: ctx.userLpAccount,
      poolAccountLp: ctx.accounts.poolAccountLp,
      poolAccountA: ctx.accounts.poolAccountA,
      poolAccountB: ctx.accounts.poolAccountB,
      mintLp: ctx.accounts.mintLp,
      feeToLpAccount: null,
      toAccountA: ctx.userAccountA,
      toAccountB: ctx.userAccountB,
      provider: ctx.payer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([ctx.payer])
    .rpc();
}

describe("Router - remove_liquidity", () => {
  it("burns LP tokens and withdraws proportional token amounts", async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);

    await removeLiquidity(ctx, REMOVE_LIQUIDITY);

    const after = await snapshot(ctx);

    expect(before.userLp - after.userLp).to.equal(
      REMOVE_LIQUIDITY,
    );

    expect(after.userA - before.userA).to.equal(
      REMOVE_LIQUIDITY,
    );

    expect(after.userB - before.userB).to.equal(
      REMOVE_LIQUIDITY,
    );

    expect(before.poolA - after.poolA).to.equal(
      REMOVE_LIQUIDITY,
    );

    expect(before.poolB - after.poolB).to.equal(
      REMOVE_LIQUIDITY,
    );

    expect(after.reserves).to.deep.equal({
      a: 50_000_000n,
      b: 50_000_000n,
    });

    expect(after.poolLp).to.equal(0n);

    expect(
      await balance(ctx, ctx.accounts.lockedLpAccount),
    ).to.equal(1_000n);
  });

  it("allows withdrawing all user-owned LP liquidity", async () => {
    const ctx = await setup();

    const liquidity = await balance(
      ctx,
      ctx.userLpAccount,
    );

    expect(liquidity).to.equal(99_999_000n);

    await removeLiquidity(ctx, liquidity);

    const after = await snapshot(ctx);

    expect(after.userLp).to.equal(0n);
    expect(after.poolLp).to.equal(0n);

    // Minimum locked liquidity remains in the pool.
    expect(after.reserves).to.deep.equal({
      a: 1_000n,
      b: 1_000n,
    });

    expect(after.poolA).to.equal(1_000n);
    expect(after.poolB).to.equal(1_000n);

    expect(
      await balance(ctx, ctx.accounts.lockedLpAccount),
    ).to.equal(1_000n);
  });

  it("rejects withdrawals below minimum amount A", async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);

    let rejected = false;

    try {
      await removeLiquidity(
        ctx,
        REMOVE_LIQUIDITY,
        REMOVE_LIQUIDITY + 1n,
        0n,
      );
    } catch (error) {
      if (
        error instanceof anchor.AnchorError &&
        error.error.errorCode.code === "InsufficientAmountA"
      ) {
        rejected = true;
      } else {
        throw error;
      }
    }

    expect(rejected).to.equal(true);
    expect(await snapshot(ctx)).to.deep.equal(before);
  });

  it("rejects withdrawals below minimum amount B", async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);

    let rejected = false;

    try {
      await removeLiquidity(
        ctx,
        REMOVE_LIQUIDITY,
        0n,
        REMOVE_LIQUIDITY + 1n,
      );
    } catch (error) {
      if (
        error instanceof anchor.AnchorError &&
        error.error.errorCode.code === "InsufficientAmountB"
      ) {
        rejected = true;
      } else {
        throw error;
      }
    }

    expect(rejected).to.equal(true);
    expect(await snapshot(ctx)).to.deep.equal(before);
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

    const before = await snapshot(ctx);

    let rejected = false;

    try {
      await removeLiquidity(
        ctx,
        REMOVE_LIQUIDITY,
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
    expect(await snapshot(ctx)).to.deep.equal(before);
  });

  it("rejects withdrawals exceeding the user's LP balance", async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);

    let rejected = false;

    try {
      await removeLiquidity(
        ctx,
        before.userLp + 1n,
      );
    } catch {
      rejected = true;
    }

    expect(rejected).to.equal(true);
    expect(await snapshot(ctx)).to.deep.equal(before);
  });
});
