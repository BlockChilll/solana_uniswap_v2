import * as anchor from "@coral-xyz/anchor";
import { LiteSVMProvider } from "anchor-litesvm";
import { Clock } from "litesvm";
import { AccountMeta, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MINT_SIZE,
  MintLayout,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  unpackAccount,
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

const ammIdl = JSON.parse(readFileSync("target/idl/solana_v2_amm.json", "utf8")) as SolanaV2Amm;
const routerIdl = JSON.parse(readFileSync("target/idl/solana_v2_router.json", "utf8")) as SolanaV2Router;
const DEADLINE = 4_102_444_800;
const RESERVE = 1_000_000_000n;
const AMOUNT_OUT = 80_000_000n;

function amountIn(output: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  return (reserveIn * output * 1000n) / ((reserveOut - output) * 997n) + 1n;
}

function initializeNativeMint(svm: ReturnType<typeof createTestSvm>) {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode({
    mintAuthorityOption: 0,
    mintAuthority: PublicKey.default,
    supply: 0n,
    decimals: 9,
    isInitialized: true,
    freezeAuthorityOption: 0,
    freezeAuthority: PublicKey.default,
  }, data);
  svm.setAccount(NATIVE_MINT, {
    lamports: 1_461_600,
    data,
    owner: TOKEN_PROGRAM_ID,
    executable: false,
    rentEpoch: 0,
  });
}

type PoolFixture = {
  mintA: PublicKey;
  mintB: PublicKey;
  accounts: ReturnType<typeof derivePoolAccounts>;
};

async function setup() {
  const svm = createTestSvm();
  initializeNativeMint(svm);
  const provider = new LiteSVMProvider(svm);
  const amm = new anchor.Program<SolanaV2Amm>(ammIdl, provider);
  const router = new anchor.Program<SolanaV2Router>(routerIdl, provider);
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), ".config/solana/id.json"), "utf8"))));
  svm.airdrop(payer.publicKey, 10n * BigInt(anchor.web3.LAMPORTS_PER_SOL));

  const [ammConfig] = PublicKey.findProgramAddressSync([Buffer.from("amm_config")], amm.programId);
  await amm.methods.createAmmConfig(payer.publicKey, PublicKey.default)
    .accountsPartial({ ammConfig, payer: payer.publicKey })
    .signers([payer]).rpc();

  const tokenB = await createMint(svm, provider, payer);
  const tokenC = await createMint(svm, provider, payer);
  const userB = await createTokenAccount(provider, payer, tokenB, payer.publicKey);
  const userC = await createTokenAccount(provider, payer, tokenC, payer.publicKey);
  await mintTokens(provider, payer, tokenB, userB, 5_000_000_000n);
  await mintTokens(provider, payer, tokenC, userC, 5_000_000_000n);

  async function createPool(x: PublicKey, y: PublicKey): Promise<PoolFixture> {
    const [mintA, mintB] = x.toBuffer().compare(y.toBuffer()) < 0 ? [x, y] : [y, x];
    const accounts = derivePoolAccounts(amm.programId, mintA, mintB);
    svm.expireBlockhash();
    await amm.methods.createPool().accountsPartial({
      ...accounts, mintA, mintB, payer: payer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    }).signers([payer]).rpc();
    return { mintA, mintB, accounts };
  }

  const solPool = await createPool(NATIVE_MINT, tokenB);
  const tokenPool = await createPool(tokenB, tokenC);
  const solLp = await createTokenAccount(provider, payer, solPool.accounts.mintLp, payer.publicKey);
  const tokenLp = await createTokenAccount(provider, payer, tokenPool.accounts.mintLp, payer.publicKey);

  const initialWsol = Keypair.generate();
  svm.expireBlockhash();
  await router.methods.addLiquiditySol(
    new anchor.BN(RESERVE.toString()), new anchor.BN(0), new anchor.BN(0),
    new anchor.BN(RESERVE.toString()), new anchor.BN(DEADLINE),
  ).accountsPartial({
    ammProgram: amm.programId, ammConfig,
    pool: solPool.accounts.pool, mintA: solPool.mintA, mintB: solPool.mintB,
    mintSol: NATIVE_MINT, userTokenAccount: userB,
    poolAccountA: solPool.accounts.poolAccountA, poolAccountB: solPool.accounts.poolAccountB,
    lockedLpAccount: solPool.accounts.lockedLpAccount, mintLp: solPool.accounts.mintLp,
    feeToLpAccount: null, toLpAccount: solLp,
    temporaryWsolAccount: initialWsol.publicKey,
    provider: payer.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  }).signers([payer, initialWsol]).rpc();

  const tokenPoolAUser = tokenPool.mintA.equals(tokenB) ? userB : userC;
  const tokenPoolBUser = tokenPool.mintB.equals(tokenB) ? userB : userC;
  svm.expireBlockhash();
  await router.methods.addLiquidity(
    new anchor.BN(RESERVE.toString()), new anchor.BN(RESERVE.toString()),
    new anchor.BN(0), new anchor.BN(0), new anchor.BN(DEADLINE),
  ).accountsPartial({
    ammProgram: amm.programId, ammConfig, pool: tokenPool.accounts.pool,
    mintA: tokenPool.mintA, mintB: tokenPool.mintB,
    userAccountA: tokenPoolAUser, userAccountB: tokenPoolBUser,
    poolAccountA: tokenPool.accounts.poolAccountA, poolAccountB: tokenPool.accounts.poolAccountB,
    lockedLpAccount: tokenPool.accounts.lockedLpAccount, mintLp: tokenPool.accounts.mintLp,
    feeToLpAccount: null, toLpAccount: tokenLp,
    provider: payer.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
  }).signers([payer]).rpc();

  const solVault = solPool.mintA.equals(NATIVE_MINT)
    ? solPool.accounts.poolAccountA : solPool.accounts.poolAccountB;
  const solPoolTokenVault = solPool.mintA.equals(NATIVE_MINT)
    ? solPool.accounts.poolAccountB : solPool.accounts.poolAccountA;
  const tokenPoolInputVault = tokenPool.mintA.equals(tokenB)
    ? tokenPool.accounts.poolAccountA : tokenPool.accounts.poolAccountB;
  const tokenPoolOutputVault = tokenPool.mintA.equals(tokenC)
    ? tokenPool.accounts.poolAccountA : tokenPool.accounts.poolAccountB;

  return {
    svm, provider, amm, router, payer, tokenB, tokenC, userB, userC,
    solPool, tokenPool, solVault, solPoolTokenVault,
    tokenPoolInputVault, tokenPoolOutputVault,
  };
}

type Context = Awaited<ReturnType<typeof setup>>;

async function balance(ctx: Context, address: PublicKey): Promise<bigint> {
  const info = await ctx.provider.connection.getAccountInfo(address);
  if (!info) throw new Error(`Missing token account: ${address.toBase58()}`);
  return unpackAccount(address, info).amount;
}

function remainingAccounts(pools: PoolFixture[]): AccountMeta[] {
  return pools.flatMap(({ mintA, mintB, accounts }) => [
    { pubkey: accounts.pool, isSigner: false, isWritable: true },
    { pubkey: mintA, isSigner: false, isWritable: false },
    { pubkey: mintB, isSigner: false, isWritable: false },
    { pubkey: accounts.poolAccountA, isSigner: false, isWritable: true },
    { pubkey: accounts.poolAccountB, isSigner: false, isWritable: true },
  ]);
}

async function swap(
  ctx: Context,
  path: PublicKey[],
  output: bigint,
  maximum: bigint,
  pools: PoolFixture[],
  deadline = DEADLINE,
  metas = remainingAccounts(pools),
  recipient = ctx.userB,
) {
  const temporaryWsolAccount = Keypair.generate();
  ctx.svm.expireBlockhash();
  const signature = await ctx.router.methods.swapSolForExactTokens(
    new anchor.BN(output.toString()),
    new anchor.BN(maximum.toString()),
    path,
    new anchor.BN(deadline),
  ).accountsPartial({
    trader: ctx.payer.publicKey,
    temporaryWsolAccount: temporaryWsolAccount.publicKey,
    wsolMint: NATIVE_MINT,
    toTokenAccount: recipient,
    ammProgram: ctx.amm.programId,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  }).remainingAccounts(metas).signers([ctx.payer, temporaryWsolAccount]).rpc();
  return { signature, temporaryWsolAccount: temporaryWsolAccount.publicKey };
}

async function snapshot(ctx: Context) {
  const vaults = await Promise.all([
    ctx.solVault, ctx.solPoolTokenVault,
    ctx.tokenPoolInputVault, ctx.tokenPoolOutputVault,
  ].map(a => balance(ctx, a)));
  const users = await Promise.all([ctx.userB, ctx.userC].map(a => balance(ctx, a)));
  const reserves = await Promise.all([ctx.solPool, ctx.tokenPool].map(async p => {
    const state = await ctx.amm.account.pool.fetch(p.accounts.pool);
    return [state.reserveA.toString(), state.reserveB.toString()];
  }));
  return { vaults, users, reserves };
}

async function expectRejected(action: () => Promise<unknown>) {
  let rejected = false;
  try { await action(); } catch { rejected = true; }
  expect(rejected).to.equal(true);
}

describe("Router - swap_sol_for_exact_tokens", () => {
  it("delivers exact tokens for SOL and closes the temporary WSOL account", async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);
    const beforeSol = ctx.svm.getBalance(ctx.payer.publicKey);
    const required = amountIn(AMOUNT_OUT, RESERVE, RESERVE);
    const { temporaryWsolAccount } = await swap(ctx, [NATIVE_MINT, ctx.tokenB], AMOUNT_OUT, required, [ctx.solPool]);
    const after = await snapshot(ctx);
    const afterSol = ctx.svm.getBalance(ctx.payer.publicKey);
    expect(beforeSol - afterSol >= required).to.equal(true);
    expect(after.users[0] - before.users[0]).to.equal(AMOUNT_OUT);
    expect(after.vaults[0] - before.vaults[0]).to.equal(required);
    expect(before.vaults[1] - after.vaults[1]).to.equal(AMOUNT_OUT);
    expect(after.reserves[0]).to.deep.equal(
      ctx.solPool.mintA.equals(NATIVE_MINT)
        ? [(RESERVE + required).toString(), (RESERVE - AMOUNT_OUT).toString()]
        : [(RESERVE - AMOUNT_OUT).toString(), (RESERVE + required).toString()],
    );
    expect(ctx.svm.getAccount(temporaryWsolAccount)).to.equal(null);
  });

  it("routes SOL -> token B -> token C with exact final output", async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);
    const intermediate = amountIn(AMOUNT_OUT, RESERVE, RESERVE);
    const required = amountIn(intermediate, RESERVE, RESERVE);
    const { temporaryWsolAccount } = await swap(
      ctx, [NATIVE_MINT, ctx.tokenB, ctx.tokenC], AMOUNT_OUT, required,
      [ctx.solPool, ctx.tokenPool], DEADLINE,
      remainingAccounts([ctx.solPool, ctx.tokenPool]), ctx.userC,
    );
    const after = await snapshot(ctx);
    expect(after.users[0]).to.equal(before.users[0]);
    expect(after.users[1] - before.users[1]).to.equal(AMOUNT_OUT);
    expect(after.vaults[0] - before.vaults[0]).to.equal(required);
    expect(before.vaults[1] - after.vaults[1]).to.equal(intermediate);
    expect(after.vaults[2] - before.vaults[2]).to.equal(intermediate);
    expect(before.vaults[3] - after.vaults[3]).to.equal(AMOUNT_OUT);
    expect(ctx.svm.getAccount(temporaryWsolAccount)).to.equal(null);
  });

  it("uses only required SOL even when amount_in_max is much higher", async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);
    const required = amountIn(AMOUNT_OUT, RESERVE, RESERVE);
    const { temporaryWsolAccount } = await swap(
      ctx, [NATIVE_MINT, ctx.tokenB], AMOUNT_OUT, required + 2_000_000_000n, [ctx.solPool],
    );
    const after = await snapshot(ctx);
    expect(after.vaults[0] - before.vaults[0]).to.equal(required);
    expect(after.users[0] - before.users[0]).to.equal(AMOUNT_OUT);
    expect(ctx.svm.getAccount(temporaryWsolAccount)).to.equal(null);
  });

  it("accepts amount_in_max exactly equal to required SOL", async () => {
    const ctx = await setup();
    const required = amountIn(AMOUNT_OUT, RESERVE, RESERVE);
    const before = await balance(ctx, ctx.userB);
    await swap(ctx, [NATIVE_MINT, ctx.tokenB], AMOUNT_OUT, required, [ctx.solPool]);
    expect((await balance(ctx, ctx.userB)) - before).to.equal(AMOUNT_OUT);
  });

  it("rejects maximum SOL one lamport below required input atomically", async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);
    const required = amountIn(AMOUNT_OUT, RESERVE, RESERVE);
    await expectRejected(() => swap(ctx, [NATIVE_MINT, ctx.tokenB], AMOUNT_OUT, required - 1n, [ctx.solPool]));
    expect(await snapshot(ctx)).to.deep.equal(before);
  });

  it("rejects multi-hop input maximum below required amount atomically", async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);
    const intermediate = amountIn(AMOUNT_OUT, RESERVE, RESERVE);
    const required = amountIn(intermediate, RESERVE, RESERVE);
    await expectRejected(() => swap(
      ctx, [NATIVE_MINT, ctx.tokenB, ctx.tokenC], AMOUNT_OUT, required - 1n,
      [ctx.solPool, ctx.tokenPool], DEADLINE,
      remainingAccounts([ctx.solPool, ctx.tokenPool]), ctx.userC,
    ));
    expect(await snapshot(ctx)).to.deep.equal(before);
  });

  it("rejects output equal to pool reserves atomically", async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);
    await expectRejected(() => swap(ctx, [NATIVE_MINT, ctx.tokenB], RESERVE, 10_000_000_000n, [ctx.solPool]));
    expect(await snapshot(ctx)).to.deep.equal(before);
  });

  it("rejects expired deadline atomically", async () => {
    const ctx = await setup();
    const clock = ctx.svm.getClock();
    ctx.svm.setClock(new Clock(clock.slot, clock.epochStartTimestamp, clock.epoch, clock.leaderScheduleEpoch, 1_000n));
    const before = await snapshot(ctx);
    await expectRejected(() => swap(ctx, [NATIVE_MINT, ctx.tokenB], AMOUNT_OUT, RESERVE, [ctx.solPool], 999));
    expect(await snapshot(ctx)).to.deep.equal(before);
  });

  it("rejects paths not starting with WSOL", async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);
    await expectRejected(() => swap(ctx, [ctx.tokenB, NATIVE_MINT], AMOUNT_OUT, RESERVE, [ctx.solPool]));
    expect(await snapshot(ctx)).to.deep.equal(before);
  });

  it("rejects path containing only WSOL", async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);
    await expectRejected(() => swap(ctx, [NATIVE_MINT], AMOUNT_OUT, RESERVE, []));
    expect(await snapshot(ctx)).to.deep.equal(before);
  });

  it("rejects repeated adjacent mints", async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);
    await expectRejected(() => swap(ctx, [NATIVE_MINT, NATIVE_MINT], AMOUNT_OUT, RESERVE, [ctx.solPool]));
    expect(await snapshot(ctx)).to.deep.equal(before);
  });

  it("rejects missing remaining hop accounts", async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);
    await expectRejected(() => swap(ctx, [NATIVE_MINT, ctx.tokenB], AMOUNT_OUT, RESERVE, [ctx.solPool], DEADLINE, []));
    expect(await snapshot(ctx)).to.deep.equal(before);
  });

  it("rejects incorrect remaining hop account order", async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);
    const metas = remainingAccounts([ctx.solPool]);
    [metas[1], metas[2]] = [metas[2], metas[1]];
    await expectRejected(() => swap(ctx, [NATIVE_MINT, ctx.tokenB], AMOUNT_OUT, RESERVE, [ctx.solPool], DEADLINE, metas));
    expect(await snapshot(ctx)).to.deep.equal(before);
  });

  it("rejects destination token account with incorrect mint", async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);
    await expectRejected(() => swap(
      ctx, [NATIVE_MINT, ctx.tokenB], AMOUNT_OUT, RESERVE, [ctx.solPool], DEADLINE,
      remainingAccounts([ctx.solPool]), ctx.userC,
    ));
    expect(await snapshot(ctx)).to.deep.equal(before);
  });

  it("rejects swap when required SOL exceeds trader balance", async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);
    await expectRejected(() => swap(
      ctx, [NATIVE_MINT, ctx.tokenB], 900_000_000n, 20_000_000_000n, [ctx.solPool],
    ));
    expect(await snapshot(ctx)).to.deep.equal(before);
  });
});
