import * as anchor from "@coral-xyz/anchor";
import { LiteSVMProvider } from "anchor-litesvm";
import { Clock } from "litesvm";
import { AccountMeta, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
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
const AMOUNT_OUT = 100_000_000n;

// Matches the 0.3% fee used by the passing exact-input swap tests.
function amountIn(amountOut: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountOut <= 0n || amountOut >= reserveOut) throw new Error("Invalid output amount");
  return (reserveIn * amountOut * 1000n) / ((reserveOut - amountOut) * 997n) + 1n;
}

type PoolFixture = {
  mintA: PublicKey;
  mintB: PublicKey;
  accounts: ReturnType<typeof derivePoolAccounts>;
};

async function setup() {
  const svm = createTestSvm();
  const provider = new LiteSVMProvider(svm);
  const amm = new anchor.Program<SolanaV2Amm>(ammIdl, provider);
  const router = new anchor.Program<SolanaV2Router>(routerIdl, provider);
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), ".config/solana/id.json"), "utf8"))));
  svm.airdrop(payer.publicKey, 10n * BigInt(anchor.web3.LAMPORTS_PER_SOL));

  const [ammConfig] = PublicKey.findProgramAddressSync([Buffer.from("amm_config")], amm.programId);
  await amm.methods.createAmmConfig(payer.publicKey, PublicKey.default)
    .accountsPartial({ ammConfig, payer: payer.publicKey })
    .signers([payer]).rpc();

  const unsorted = await Promise.all([
    createMint(svm, provider, payer),
    createMint(svm, provider, payer),
    createMint(svm, provider, payer),
  ]);
  const [mintA, mintB, mintC] = unsorted.sort((a, b) => a.toBuffer().compare(b.toBuffer()));

  const userAccounts = new Map<string, PublicKey>();
  for (const mint of [mintA, mintB, mintC]) {
    const account = await createTokenAccount(provider, payer, mint, payer.publicKey);
    userAccounts.set(mint.toBase58(), account);
    await mintTokens(provider, payer, mint, account, 5_000_000_000n);
  }

  const pools: PoolFixture[] = [];
  for (const [a, b] of [[mintA, mintB], [mintB, mintC]] as [PublicKey, PublicKey][]) {
    const accounts = derivePoolAccounts(amm.programId, a, b);
    svm.expireBlockhash();
    await amm.methods.createPool().accountsPartial({
      ...accounts,
      mintA: a,
      mintB: b,
      payer: payer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    }).signers([payer]).rpc();

    const lpAccount = await createTokenAccount(provider, payer, accounts.mintLp, payer.publicKey);
    svm.expireBlockhash();
    await router.methods.addLiquidity(
      new anchor.BN(RESERVE.toString()), new anchor.BN(RESERVE.toString()),
      new anchor.BN(0), new anchor.BN(0), new anchor.BN(DEADLINE),
    ).accountsPartial({
      ammProgram: amm.programId,
      ammConfig,
      pool: accounts.pool,
      mintA: a,
      mintB: b,
      userAccountA: userAccounts.get(a.toBase58())!,
      userAccountB: userAccounts.get(b.toBase58())!,
      poolAccountA: accounts.poolAccountA,
      poolAccountB: accounts.poolAccountB,
      lockedLpAccount: accounts.lockedLpAccount,
      mintLp: accounts.mintLp,
      feeToLpAccount: null,
      toLpAccount: lpAccount,
      provider: payer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    }).signers([payer]).rpc();
    pools.push({ mintA: a, mintB: b, accounts });
  }
  return { svm, provider, amm, router, payer, mintA, mintB, mintC, pools, userAccounts };
}

type Context = Awaited<ReturnType<typeof setup>>;

function userAccount(ctx: Context, mint: PublicKey): PublicKey {
  const account = ctx.userAccounts.get(mint.toBase58());
  if (!account) throw new Error("Missing user token account");
  return account;
}

async function balance(ctx: Context, address: PublicKey): Promise<bigint> {
  const info = await ctx.provider.connection.getAccountInfo(address);
  if (!info) throw new Error(`Missing token account ${address.toBase58()}`);
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
  amountOut: bigint,
  maxIn: bigint,
  hops: PoolFixture[],
  deadline = DEADLINE,
  metas = remainingAccounts(hops),
  inputAccount = userAccount(ctx, path[0]),
  outputAccount = userAccount(ctx, path[path.length - 1]),
) {
  ctx.svm.expireBlockhash();
  return ctx.router.methods.swapTokensForExactTokens(
    new anchor.BN(amountOut.toString()),
    new anchor.BN(maxIn.toString()),
    path,
    new anchor.BN(deadline),
  ).accountsPartial({
    trader: ctx.payer.publicKey,
    userTokenAccount: inputAccount,
    toTokenAccount: outputAccount,
    ammProgram: ctx.amm.programId,
    tokenProgram: TOKEN_PROGRAM_ID,
  }).remainingAccounts(metas).signers([ctx.payer]).rpc();
}

async function snapshot(ctx: Context) {
  const users = await Promise.all([ctx.mintA, ctx.mintB, ctx.mintC].map(m => balance(ctx, userAccount(ctx, m))));
  const vaults = await Promise.all(ctx.pools.flatMap(p => [p.accounts.poolAccountA, p.accounts.poolAccountB]).map(a => balance(ctx, a)));
  const reserves = await Promise.all(ctx.pools.map(async p => {
    const pool = await ctx.amm.account.pool.fetch(p.accounts.pool);
    return [pool.reserveA.toString(), pool.reserveB.toString()];
  }));
  return { users, vaults, reserves };
}

async function expectRejected(action: () => Promise<unknown>) {
  let rejected = false;
  try { await action(); } catch { rejected = true; }
  expect(rejected).to.equal(true);
}

describe("Router - swap_tokens_for_exact_tokens", () => {
  it("swaps A -> B for an exact output and spends only the required input", async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);
    const required = amountIn(AMOUNT_OUT, RESERVE, RESERVE);
    await swap(ctx, [ctx.mintA, ctx.mintB], AMOUNT_OUT, required + 1_000_000n, [ctx.pools[0]]);
    const after = await snapshot(ctx);
    expect(before.users[0] - after.users[0]).to.equal(required);
    expect(after.users[1] - before.users[1]).to.equal(AMOUNT_OUT);
    expect(after.vaults[0] - before.vaults[0]).to.equal(required);
    expect(before.vaults[1] - after.vaults[1]).to.equal(AMOUNT_OUT);
    expect(after.reserves[0]).to.deep.equal([(RESERVE + required).toString(), (RESERVE - AMOUNT_OUT).toString()]);
  });

  it("swaps B -> A using the reverse path", async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);
    const required = amountIn(AMOUNT_OUT, RESERVE, RESERVE);
    await swap(ctx, [ctx.mintB, ctx.mintA], AMOUNT_OUT, required, [ctx.pools[0]]);
    const after = await snapshot(ctx);
    expect(before.users[1] - after.users[1]).to.equal(required);
    expect(after.users[0] - before.users[0]).to.equal(AMOUNT_OUT);
    expect(after.vaults[1] - before.vaults[1]).to.equal(required);
    expect(before.vaults[0] - after.vaults[0]).to.equal(AMOUNT_OUT);
  });

  it("routes A -> B -> C and delivers the exact final output", async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);
    const intermediate = amountIn(AMOUNT_OUT, RESERVE, RESERVE);
    const required = amountIn(intermediate, RESERVE, RESERVE);
    await swap(ctx, [ctx.mintA, ctx.mintB, ctx.mintC], AMOUNT_OUT, required, ctx.pools);
    const after = await snapshot(ctx);
    expect(before.users[0] - after.users[0]).to.equal(required);
    expect(after.users[1]).to.equal(before.users[1]);
    expect(after.users[2] - before.users[2]).to.equal(AMOUNT_OUT);
    expect(after.vaults[0] - before.vaults[0]).to.equal(required);
    expect(before.vaults[1] - after.vaults[1]).to.equal(intermediate);
    expect(after.vaults[2] - before.vaults[2]).to.equal(intermediate);
    expect(before.vaults[3] - after.vaults[3]).to.equal(AMOUNT_OUT);
  });

  it("accepts amount_in_max equal to the required input", async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);
    const required = amountIn(AMOUNT_OUT, RESERVE, RESERVE);
    await swap(ctx, [ctx.mintA, ctx.mintB], AMOUNT_OUT, required, [ctx.pools[0]]);
    const after = await snapshot(ctx);
    expect(before.users[0] - after.users[0]).to.equal(required);
    expect(after.users[1] - before.users[1]).to.equal(AMOUNT_OUT);
  });

  it("rejects amount_in_max one unit below required input atomically", async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);
    const required = amountIn(AMOUNT_OUT, RESERVE, RESERVE);
    await expectRejected(() => swap(ctx, [ctx.mintA, ctx.mintB], AMOUNT_OUT, required - 1n, [ctx.pools[0]]));
    expect(await snapshot(ctx)).to.deep.equal(before);
  });

  it("rejects output equal to pool reserves atomically", async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);
    await expectRejected(() => swap(ctx, [ctx.mintA, ctx.mintB], RESERVE, 10_000_000_000n, [ctx.pools[0]]));
    expect(await snapshot(ctx)).to.deep.equal(before);
  });

  it("rejects expired deadline atomically", async () => {
    const ctx = await setup();
    const clock = ctx.svm.getClock();
    ctx.svm.setClock(new Clock(clock.slot, clock.epochStartTimestamp, clock.epoch, clock.leaderScheduleEpoch, 1_000n));
    const before = await snapshot(ctx);
    await expectRejected(() => swap(ctx, [ctx.mintA, ctx.mintB], AMOUNT_OUT, 1_000_000_000n, [ctx.pools[0]], 999));
    expect(await snapshot(ctx)).to.deep.equal(before);
  });

  it("rejects paths shorter than two mints", async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);
    await expectRejected(() => swap(ctx, [ctx.mintA], AMOUNT_OUT, 1_000_000_000n, [], DEADLINE, [], userAccount(ctx, ctx.mintA), userAccount(ctx, ctx.mintA)));
    expect(await snapshot(ctx)).to.deep.equal(before);
  });

  it("rejects identical consecutive mints", async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);
    await expectRejected(() => swap(ctx, [ctx.mintA, ctx.mintA], AMOUNT_OUT, 1_000_000_000n, [ctx.pools[0]]));
    expect(await snapshot(ctx)).to.deep.equal(before);
  });

  it("rejects missing remaining accounts", async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);
    await expectRejected(() => swap(ctx, [ctx.mintA, ctx.mintB], AMOUNT_OUT, 1_000_000_000n, [ctx.pools[0]], DEADLINE, []));
    expect(await snapshot(ctx)).to.deep.equal(before);
  });

  it("rejects incorrect remaining account ordering", async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);
    const metas = remainingAccounts([ctx.pools[0]]);
    [metas[1], metas[2]] = [metas[2], metas[1]];
    await expectRejected(() => swap(ctx, [ctx.mintA, ctx.mintB], AMOUNT_OUT, 1_000_000_000n, [ctx.pools[0]], DEADLINE, metas));
    expect(await snapshot(ctx)).to.deep.equal(before);
  });

  it("rejects an input account with a different mint", async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);
    await expectRejected(() => swap(ctx, [ctx.mintA, ctx.mintB], AMOUNT_OUT, 1_000_000_000n, [ctx.pools[0]], DEADLINE, remainingAccounts([ctx.pools[0]]), userAccount(ctx, ctx.mintC)));
    expect(await snapshot(ctx)).to.deep.equal(before);
  });

  it("rejects an output account with a different mint", async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);
    await expectRejected(() => swap(ctx, [ctx.mintA, ctx.mintB], AMOUNT_OUT, 1_000_000_000n, [ctx.pools[0]], DEADLINE, remainingAccounts([ctx.pools[0]]), userAccount(ctx, ctx.mintA), userAccount(ctx, ctx.mintC)));
    expect(await snapshot(ctx)).to.deep.equal(before);
  });

  it("rejects when the required input exceeds the trader's balance", async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);
    // 900M output needs > 5B input with 1B/1B reserves.
    await expectRejected(() => swap(ctx, [ctx.mintA, ctx.mintB], 900_000_000n, 20_000_000_000n, [ctx.pools[0]]));
    expect(await snapshot(ctx)).to.deep.equal(before);
  });
});
