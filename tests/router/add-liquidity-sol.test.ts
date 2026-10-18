
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
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  MintLayout,
  MINT_SIZE,
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
const TOKEN_AMOUNT = 100_000_000n;
const SOL_AMOUNT = 100_000_000n;

function initializeNativeMint(svm: ReturnType<typeof createTestSvm>) {
  const mintData = Buffer.alloc(MINT_SIZE);

  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 0n,
      decimals: 9,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    mintData,
  );

  svm.setAccount(NATIVE_MINT, {
    lamports: 1_461_600,
    data: mintData,
    owner: TOKEN_PROGRAM_ID,
    executable: false,
    rentEpoch: 0,
  });
}

async function setup() {
  const svm = createTestSvm();

  // LiteSVM does not automatically provide the native WSOL mint.
  initializeNativeMint(svm);

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

  const tokenMint = await createMint(
    svm,
    provider,
    payer,
  );

  // Canonical ascending mint order.
  const [mintA, mintB] =
    tokenMint.toBuffer().compare(NATIVE_MINT.toBuffer()) < 0
      ? [tokenMint, NATIVE_MINT]
      : [NATIVE_MINT, tokenMint];

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

  const userTokenAccount = await createTokenAccount(
    provider,
    payer,
    tokenMint,
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
    tokenMint,
    userTokenAccount,
    1_000_000_000n,
  );

  const poolWsolAccount = mintA.equals(NATIVE_MINT)
    ? accounts.poolAccountA
    : accounts.poolAccountB;

  const poolTokenAccount = mintA.equals(NATIVE_MINT)
    ? accounts.poolAccountB
    : accounts.poolAccountA;

  return {
    svm,
    provider,
    amm,
    router,
    payer,
    ammConfig,
    tokenMint,
    mintA,
    mintB,
    accounts,
    userTokenAccount,
    toLpAccount,
    poolWsolAccount,
    poolTokenAccount,
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

async function addLiquiditySol(
  ctx: Context,
  amountTokenDesired: bigint,
  amountTokenMin: bigint,
  amountSolMin: bigint,
  maxSol: bigint,
  deadline = DEADLINE,
) {
  const temporaryWsolAccount = Keypair.generate();

  ctx.svm.expireBlockhash();

  const signature = await ctx.router.methods
    .addLiquiditySol(
      new anchor.BN(amountTokenDesired.toString()),
      new anchor.BN(amountTokenMin.toString()),
      new anchor.BN(amountSolMin.toString()),
      new anchor.BN(maxSol.toString()),
      new anchor.BN(deadline),
    )
    .accountsPartial({
      ammProgram: ctx.amm.programId,
      ammConfig: ctx.ammConfig,
      pool: ctx.accounts.pool,
      mintA: ctx.mintA,
      mintB: ctx.mintB,
      mintSol: NATIVE_MINT,
      userTokenAccount: ctx.userTokenAccount,
      poolAccountA: ctx.accounts.poolAccountA,
      poolAccountB: ctx.accounts.poolAccountB,
      lockedLpAccount: ctx.accounts.lockedLpAccount,
      mintLp: ctx.accounts.mintLp,
      feeToLpAccount: null,
      toLpAccount: ctx.toLpAccount,
      temporaryWsolAccount: temporaryWsolAccount.publicKey,
      provider: ctx.payer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([ctx.payer, temporaryWsolAccount])
    .rpc();

  return {
    signature,
    temporaryWsolAccount: temporaryWsolAccount.publicKey,
  };
}

async function reserves(ctx: Context) {
  const pool = await ctx.amm.account.pool.fetch(
    ctx.accounts.pool,
  );

  const sol = ctx.mintA.equals(NATIVE_MINT)
    ? BigInt(pool.reserveA.toString())
    : BigInt(pool.reserveB.toString());

  const token = ctx.mintA.equals(NATIVE_MINT)
    ? BigInt(pool.reserveB.toString())
    : BigInt(pool.reserveA.toString());

  return { sol, token };
}

describe("Router - add_liquidity_sol", () => {
  it("adds initial SOL/token liquidity and mints LP tokens", async () => {
    const ctx = await setup();

    const beforeToken = await balance(
      ctx,
      ctx.userTokenAccount,
    );

    const beforeSol = ctx.svm.getBalance(
      ctx.payer.publicKey,
    );

    const { temporaryWsolAccount } = await addLiquiditySol(
      ctx,
      TOKEN_AMOUNT,
      TOKEN_AMOUNT,
      SOL_AMOUNT,
      SOL_AMOUNT,
    );

    const pool = await ctx.amm.account.pool.fetch(
      ctx.accounts.pool,
    );

    const poolReserves = await reserves(ctx);

    // Verify actual pool vault balances.
    expect(
      await balance(ctx, ctx.poolWsolAccount),
    ).to.equal(SOL_AMOUNT);

    expect(
      await balance(ctx, ctx.poolTokenAccount),
    ).to.equal(TOKEN_AMOUNT);

    // Verify AMM reserves match the token vaults.
    expect(BigInt(pool.reserveA.toString())).to.equal(
      await balance(ctx, ctx.accounts.poolAccountA),
    );

    expect(BigInt(pool.reserveB.toString())).to.equal(
      await balance(ctx, ctx.accounts.poolAccountB),
    );

    expect(poolReserves.sol).to.equal(SOL_AMOUNT);
    expect(poolReserves.token).to.equal(TOKEN_AMOUNT);

    // Verify LP minting.
    expect(
      await balance(ctx, ctx.toLpAccount),
    ).to.equal(99_999_000n);

    expect(
      await balance(ctx, ctx.accounts.lockedLpAccount),
    ).to.equal(1_000n);

    // Verify token expenditure.
    const afterToken = await balance(
      ctx,
      ctx.userTokenAccount,
    );

    expect(beforeToken - afterToken).to.equal(TOKEN_AMOUNT);

    // Verify native SOL expenditure.
    const afterSol = ctx.svm.getBalance(
      ctx.payer.publicKey,
    );

    expect(beforeSol - afterSol >= SOL_AMOUNT).to.equal(true);

    // Temporary WSOL account must be closed.
    expect(
      ctx.svm.getAccount(temporaryWsolAccount),
    ).to.equal(null);
  });

  it("adds liquidity at the existing SOL/token reserve ratio", async () => {
    const ctx = await setup();

    await addLiquiditySol(
      ctx,
      200_000_000n,
      0n,
      0n,
      100_000_000n,
    );

    const beforeToken = await balance(
      ctx,
      ctx.userTokenAccount,
    );

    const beforeLp = await balance(
      ctx,
      ctx.toLpAccount,
    );

    const beforeSol = ctx.svm.getBalance(
      ctx.payer.publicKey,
    );

    // Existing ratio: 2 tokens per SOL.
    // Desired: 60 tokens and 20 SOL.
    // Actual: 40 tokens and 20 SOL.
    const { temporaryWsolAccount } = await addLiquiditySol(
      ctx,
      60_000_000n,
      0n,
      0n,
      20_000_000n,
    );

    const afterToken = await balance(
      ctx,
      ctx.userTokenAccount,
    );

    const afterLp = await balance(
      ctx,
      ctx.toLpAccount,
    );

    const afterSol = ctx.svm.getBalance(
      ctx.payer.publicKey,
    );

    expect(beforeToken - afterToken).to.equal(40_000_000n);
    expect(afterLp - beforeLp > 0n).to.equal(true);

    expect(
      beforeSol - afterSol >= 20_000_000n,
    ).to.equal(true);

    const poolReserves = await reserves(ctx);

    expect(poolReserves.token).to.equal(240_000_000n);
    expect(poolReserves.sol).to.equal(120_000_000n);

    expect(
      await balance(ctx, ctx.poolTokenAccount),
    ).to.equal(240_000_000n);

    expect(
      await balance(ctx, ctx.poolWsolAccount),
    ).to.equal(120_000_000n);

    expect(
      ctx.svm.getAccount(temporaryWsolAccount),
    ).to.equal(null);
  });

  it("rejects deposits when minimum token amount cannot be met", async () => {
    const ctx = await setup();

    await addLiquiditySol(
      ctx,
      200_000_000n,
      0n,
      0n,
      100_000_000n,
    );

    const beforeToken = await balance(
      ctx,
      ctx.userTokenAccount,
    );

    const beforeReserves = await reserves(ctx);

    let rejected = false;

    try {
      await addLiquiditySol(
        ctx,
        60_000_000n,
        50_000_000n,
        0n,
        20_000_000n,
      );
    } catch {
      rejected = true;
    }

    expect(rejected).to.equal(true);

    expect(
      await balance(ctx, ctx.userTokenAccount),
    ).to.equal(beforeToken);

    expect(await reserves(ctx)).to.deep.equal(beforeReserves);
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

    const beforeToken = await balance(
      ctx,
      ctx.userTokenAccount,
    );

    const beforeReserves = await reserves(ctx);

    let rejected = false;

    try {
      await addLiquiditySol(
        ctx,
        TOKEN_AMOUNT,
        0n,
        0n,
        SOL_AMOUNT,
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

    expect(
      await balance(ctx, ctx.userTokenAccount),
    ).to.equal(beforeToken);

    expect(await reserves(ctx)).to.deep.equal(beforeReserves);
  });

  it("rejects insufficient SOL without changing pool reserves", async () => {
    const ctx = await setup();

    const beforeReserves = await reserves(ctx);

    const beforeToken = await balance(
      ctx,
      ctx.userTokenAccount,
    );

    let rejected = false;

    try {
      await addLiquiditySol(
        ctx,
        TOKEN_AMOUNT,
        0n,
        0n,
        20_000_000_000n,
      );
    } catch {
      rejected = true;
    }

    expect(rejected).to.equal(true);

    expect(await reserves(ctx)).to.deep.equal(beforeReserves);

    expect(
      await balance(ctx, ctx.userTokenAccount),
    ).to.equal(beforeToken);

    expect(
      await balance(ctx, ctx.poolWsolAccount),
    ).to.equal(0n);

    expect(
      await balance(ctx, ctx.poolTokenAccount),
    ).to.equal(0n);
  });
});
