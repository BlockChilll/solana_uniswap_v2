import * as anchor from "@coral-xyz/anchor";
import { LiteSVMProvider } from "anchor-litesvm";
import { Clock } from "litesvm";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  MintLayout,
  MINT_SIZE,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import { expect } from "chai";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createTestSvm } from "../helpers/setup";
import { createMint, createTokenAccount, mintTokens } from "../helpers/token";
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
const INITIAL_TOKEN = 200_000_000n;
const INITIAL_SOL = 100_000_000n;
const REMOVE_LP = 50_000_000n;

function initializeNativeMint(svm: ReturnType<typeof createTestSvm>) {
  const data = Buffer.alloc(MINT_SIZE);

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
    data,
  );

  svm.setAccount(NATIVE_MINT, {
    lamports: 1_461_600,
    data,
    owner: TOKEN_PROGRAM_ID,
    executable: false,
    rentEpoch: 0,
  });
}

async function setup() {
  const svm = createTestSvm();
  initializeNativeMint(svm);

  const provider = new LiteSVMProvider(svm);
  const amm = new anchor.Program<SolanaV2Amm>(ammIdl, provider);
  const router = new anchor.Program<SolanaV2Router>(routerIdl, provider);

  const payer = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        readFileSync(join(homedir(), ".config/solana/id.json"), "utf8"),
      ),
    ),
  );

  svm.airdrop(payer.publicKey, 10n * BigInt(anchor.web3.LAMPORTS_PER_SOL));

  const [ammConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("amm_config")],
    amm.programId,
  );

  await amm.methods
    .createAmmConfig(payer.publicKey, PublicKey.default)
    .accountsPartial({ ammConfig, payer: payer.publicKey })
    .signers([payer])
    .rpc();

  const tokenMint = await createMint(svm, provider, payer);

  const [mintA, mintB] =
    tokenMint.toBuffer().compare(NATIVE_MINT.toBuffer()) < 0
      ? [tokenMint, NATIVE_MINT]
      : [NATIVE_MINT, tokenMint];

  const accounts = derivePoolAccounts(amm.programId, mintA, mintB);

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

  const userLpAccount = await createTokenAccount(
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

  const temporaryWsolAccount = Keypair.generate();
  svm.expireBlockhash();

  await router.methods
    .addLiquiditySol(
      new anchor.BN(INITIAL_TOKEN.toString()),
      new anchor.BN(0),
      new anchor.BN(0),
      new anchor.BN(INITIAL_SOL.toString()),
      new anchor.BN(DEADLINE),
    )
    .accountsPartial({
      ammProgram: amm.programId,
      ammConfig,
      pool: accounts.pool,
      mintA,
      mintB,
      mintSol: NATIVE_MINT,
      userTokenAccount,
      poolAccountA: accounts.poolAccountA,
      poolAccountB: accounts.poolAccountB,
      lockedLpAccount: accounts.lockedLpAccount,
      mintLp: accounts.mintLp,
      feeToLpAccount: null,
      toLpAccount: userLpAccount,
      temporaryWsolAccount: temporaryWsolAccount.publicKey,
      provider: payer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([payer, temporaryWsolAccount])
    .rpc();

  const solRecipient = Keypair.generate();
  svm.airdrop(solRecipient.publicKey, 1_000_000n);

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
    userLpAccount,
    poolWsolAccount,
    poolTokenAccount,
    solRecipient,
  };
}

type Context = Awaited<ReturnType<typeof setup>>;

async function balance(ctx: Context, address: PublicKey): Promise<bigint> {
  const info = await ctx.provider.connection.getAccountInfo(address);
  if (!info) throw new Error(`Token account not found: ${address.toBase58()}`);
  return unpackAccount(address, info).amount;
}

async function lpSupply(ctx: Context): Promise<bigint> {
  const info = await ctx.provider.connection.getAccountInfo(ctx.accounts.mintLp);
  if (!info) throw new Error("LP mint account not found");
  return unpackMint(ctx.accounts.mintLp, info).supply;
}

async function reserves(ctx: Context) {
  const pool = await ctx.amm.account.pool.fetch(ctx.accounts.pool);
  const isSolA = ctx.mintA.equals(NATIVE_MINT);

  return {
    token: BigInt((isSolA ? pool.reserveB : pool.reserveA).toString()),
    sol: BigInt((isSolA ? pool.reserveA : pool.reserveB).toString()),
  };
}

async function snapshot(ctx: Context) {
  return {
    userToken: await balance(ctx, ctx.userTokenAccount),
    userLp: await balance(ctx, ctx.userLpAccount),
    poolToken: await balance(ctx, ctx.poolTokenAccount),
    poolWsol: await balance(ctx, ctx.poolWsolAccount),
    poolLp: await balance(ctx, ctx.accounts.poolAccountLp),
    lpSupply: await lpSupply(ctx),
    recipientSol: ctx.svm.getBalance(ctx.solRecipient.publicKey),
    reserves: await reserves(ctx),
  };
}

async function removeLiquiditySol(
  ctx: Context,
  liquidity: bigint,
  amountTokenMin = 0n,
  amountSolMin = 0n,
  deadline = DEADLINE,
) {
  const temporaryWsolAccount = Keypair.generate();
  ctx.svm.expireBlockhash();

  const signature = await ctx.router.methods
    .removeLiquiditySol(
      new anchor.BN(liquidity.toString()),
      new anchor.BN(amountTokenMin.toString()),
      new anchor.BN(amountSolMin.toString()),
      new anchor.BN(deadline),
    )
    .accountsPartial({
      ammProgram: ctx.amm.programId,
      ammConfig: ctx.ammConfig,
      pool: ctx.accounts.pool,
      mintA: ctx.mintA,
      mintB: ctx.mintB,
      mintSol: NATIVE_MINT,
      userLpAccount: ctx.userLpAccount,
      poolAccountLp: ctx.accounts.poolAccountLp,
      poolAccountA: ctx.accounts.poolAccountA,
      poolAccountB: ctx.accounts.poolAccountB,
      mintLp: ctx.accounts.mintLp,
      feeToLpAccount: null,
      toTokenAccount: ctx.userTokenAccount,
      temporaryWsolAccount: temporaryWsolAccount.publicKey,
      solRecipient: ctx.solRecipient.publicKey,
      provider: ctx.payer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([ctx.payer, temporaryWsolAccount])
    .rpc();

  return { signature, temporaryWsolAccount: temporaryWsolAccount.publicKey };
}

describe("Router - remove_liquidity_sol", () => {
  it("burns LP, unwraps WSOL, and transfers native SOL to the recipient", async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);

    // LP supply is stored on the SPL Token mint, not on the AMM Pool account.
    const expectedToken = (REMOVE_LP * before.poolToken) / before.lpSupply;
    const expectedSol = (REMOVE_LP * before.poolWsol) / before.lpSupply;

    const { temporaryWsolAccount } = await removeLiquiditySol(
      ctx,
      REMOVE_LP,
      expectedToken,
      expectedSol,
    );

    const after = await snapshot(ctx);

    expect(before.userLp - after.userLp).to.equal(REMOVE_LP);
    expect(before.lpSupply - after.lpSupply).to.equal(REMOVE_LP);
    expect(after.poolLp).to.equal(0n);
    expect(after.userToken - before.userToken).to.equal(expectedToken);
    expect(after.recipientSol - before.recipientSol).to.equal(expectedSol);
    expect(before.poolToken - after.poolToken).to.equal(expectedToken);
    expect(before.poolWsol - after.poolWsol).to.equal(expectedSol);
    expect(after.reserves).to.deep.equal({
      token: before.reserves.token - expectedToken,
      sol: before.reserves.sol - expectedSol,
    });
    expect(ctx.svm.getAccount(temporaryWsolAccount)).to.equal(null);
    expect(await balance(ctx, ctx.accounts.lockedLpAccount)).to.equal(1_000n);
  });

  it("withdraws all user-owned LP while preserving locked liquidity", async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);

    const { temporaryWsolAccount } = await removeLiquiditySol(
      ctx,
      before.userLp,
    );

    const after = await snapshot(ctx);

    expect(after.userLp).to.equal(0n);
    expect(after.poolLp).to.equal(0n);
    expect(after.lpSupply).to.equal(1_000n);
    expect(after.userToken > before.userToken).to.equal(true);
    expect(after.recipientSol > before.recipientSol).to.equal(true);
    expect(after.poolToken > 0n).to.equal(true);
    expect(after.poolWsol > 0n).to.equal(true);
    expect(await balance(ctx, ctx.accounts.lockedLpAccount)).to.equal(1_000n);
    expect(ctx.svm.getAccount(temporaryWsolAccount)).to.equal(null);
  });

  it("rejects withdrawals below minimum token output", async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);

    let rejected = false;
    try {
      await removeLiquiditySol(ctx, REMOVE_LP, INITIAL_TOKEN + 1n, 0n);
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

  it("rejects withdrawals below minimum SOL output", async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);

    let rejected = false;
    try {
      await removeLiquiditySol(ctx, REMOVE_LP, 0n, INITIAL_SOL + 1n);
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
      await removeLiquiditySol(ctx, REMOVE_LP, 0n, 0n, 999);
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
      await removeLiquiditySol(ctx, before.userLp + 1n);
    } catch {
      rejected = true;
    }

    expect(rejected).to.equal(true);
    expect(await snapshot(ctx)).to.deep.equal(before);
  });
});
