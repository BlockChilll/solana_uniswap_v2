
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
import {
  executeAndParseEvents,
  requireEvent,
} from "../helpers/events";

import type { SolanaV2Amm } from "../../target/types/solana_v2_amm";

const idl = JSON.parse(
  readFileSync("target/idl/solana_v2_amm.json", "utf8"),
) as SolanaV2Amm;

async function setupEventsTest() {
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
          join(homedir(), ".config", "solana", "id.json"),
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
    program.programId,
    mintA,
    mintB,
  );

  const createPoolTx = await program.methods
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
    .transaction();

  const poolEvents = await executeAndParseEvents(
    svm,
    program,
    createPoolTx,
    [payer],
  );

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
    poolEvents,
  };
}

type TestContext = Awaited<ReturnType<typeof setupEventsTest>>;

async function depositTokens(
  ctx: TestContext,
  amountA: bigint,
  amountB: bigint,
) {
  await mintTokens(
    ctx.provider,
    ctx.payer,
    ctx.mintA,
    ctx.providerAccountA,
    amountA,
  );

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
    ctx.providerAccountA,
    ctx.accounts.poolAccountA,
    amountA,
  );

  await transferTokens(
    ctx.provider,
    ctx.payer,
    ctx.providerAccountB,
    ctx.accounts.poolAccountB,
    amountB,
  );
}

async function executeMint(ctx: TestContext) {
  const tx = await ctx.program.methods
    .mint()
    .accountsPartial({
      ammConfig: ctx.ammConfig,
      pool: ctx.accounts.pool,
      mintA: ctx.mintA,
      mintB: ctx.mintB,
      poolAccountA: ctx.accounts.poolAccountA,
      poolAccountB: ctx.accounts.poolAccountB,
      lockedLpAccount: ctx.accounts.lockedLpAccount,
      mintLp: ctx.accounts.mintLp,
      feeToLpAccount: null,
      toLpAccount: ctx.providerLpAccount,
      provider: ctx.payer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .transaction();

  return executeAndParseEvents(
    ctx.svm,
    ctx.program,
    tx,
    [ctx.payer],
  );
}

async function initializeLiquidity(
  ctx: TestContext,
  amount = 100_000_000n,
) {
  await depositTokens(ctx, amount, amount);
  return executeMint(ctx);
}

function eventNames(
  events: Array<{ name: string; data: any }>,
) {
  return events.map((event) => event.name);
}

describe("AMM - events", () => {
  it("emits PoolCreated with correct account addresses", async () => {
    const ctx = await setupEventsTest();

    const event = requireEvent(
      ctx.poolEvents,
      "PoolCreated",
    );

    expect(event.pool.equals(ctx.accounts.pool)).to.equal(true);
    expect(event.mintA.equals(ctx.mintA)).to.equal(true);
    expect(event.mintB.equals(ctx.mintB)).to.equal(true);
    expect(event.mintLp.equals(ctx.accounts.mintLp)).to.equal(true);

    expect(eventNames(ctx.poolEvents)).to.deep.equal([
      "poolCreated",
    ]);
  });

  it("emits MintLiquidity with correct provider, amounts and liquidity", async () => {
    const ctx = await setupEventsTest();

    const amountA = 100_000_000n;
    const amountB = 100_000_000n;
    const minimumLiquidity = 1_000n;

    await depositTokens(ctx, amountA, amountB);

    const events = await executeMint(ctx);
    const event = requireEvent(events, "MintLiquidity");

    expect(event.pool.equals(ctx.accounts.pool)).to.equal(true);
    expect(event.provider.equals(ctx.payer.publicKey)).to.equal(true);
    expect(event.amountA.toString()).to.equal(amountA.toString());
    expect(event.amountB.toString()).to.equal(amountB.toString());

    expect(event.liquidity.toString()).to.equal(
      (amountA - minimumLiquidity).toString(),
    );

    // update() emits Sync before MintLiquidity.
    expect(eventNames(events)).to.deep.equal([
      "sync",
      "mintLiquidity",
    ]);

    const sync = requireEvent(events, "Sync");

    expect(sync.pool.equals(ctx.accounts.pool)).to.equal(true);
    expect(sync.reserveA.toString()).to.equal(amountA.toString());
    expect(sync.reserveB.toString()).to.equal(amountB.toString());
  });

  it("emits BurnLiquidity with correct withdrawn amounts and LP burned", async () => {
    const ctx = await setupEventsTest();

    const initialLiquidity = 100_000_000n;
    const minimumLiquidity = 1_000n;
    const lpToBurn = initialLiquidity - minimumLiquidity;

    await initializeLiquidity(ctx, initialLiquidity);

    // The AMM burns LP tokens held in its LP token vault.
    await transferTokens(
      ctx.provider,
      ctx.payer,
      ctx.providerLpAccount,
      ctx.accounts.poolAccountLp,
      lpToBurn,
    );

    const tx = await ctx.program.methods
      .burn()
      .accountsPartial({
        ammConfig: ctx.ammConfig,
        pool: ctx.accounts.pool,
        mintA: ctx.mintA,
        mintB: ctx.mintB,
        poolAccountA: ctx.accounts.poolAccountA,
        poolAccountB: ctx.accounts.poolAccountB,
        poolAccountLp: ctx.accounts.poolAccountLp,
        mintLp: ctx.accounts.mintLp,
        feeToLpAccount: null,
        toAccountA: ctx.providerAccountA,
        toAccountB: ctx.providerAccountB,
        provider: ctx.payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .transaction();

    const events = await executeAndParseEvents(
      ctx.svm,
      ctx.program,
      tx,
      [ctx.payer],
    );

    const burn = requireEvent(events, "BurnLiquidity");

    expect(burn.pool.equals(ctx.accounts.pool)).to.equal(true);
    expect(burn.provider.equals(ctx.payer.publicKey)).to.equal(true);
    expect(burn.liquidity.toString()).to.equal(lpToBurn.toString());

    // Initial supply is 100,000,000 LP, including 1,000 locked.
    // Burning 99,999,000 LP withdraws the same amount of each token.
    const expectedWithdrawal = initialLiquidity - minimumLiquidity;

    expect(burn.amountA.toString()).to.equal(
      expectedWithdrawal.toString(),
    );
    expect(burn.amountB.toString()).to.equal(
      expectedWithdrawal.toString(),
    );

    expect(eventNames(events)).to.deep.equal([
      "sync",
      "burnLiquidity",
    ]);

    const sync = requireEvent(events, "Sync");

    expect(sync.pool.equals(ctx.accounts.pool)).to.equal(true);
    expect(sync.reserveA.toString()).to.equal(
      minimumLiquidity.toString(),
    );
    expect(sync.reserveB.toString()).to.equal(
      minimumLiquidity.toString(),
    );
  });

  it("emits Swap with correct input and output amounts", async () => {
    const ctx = await setupEventsTest();

    const initialLiquidity = 100_000_000n;
    await initializeLiquidity(ctx, initialLiquidity);

    const amountAIn = 10_000_000n;

    const amountAInWithFee = amountAIn * 997n;
    const amountBOut =
      (amountAInWithFee * initialLiquidity) /
      (initialLiquidity * 1000n + amountAInWithFee);

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

    const tx = await ctx.program.methods
      .swap(
        new anchor.BN(0),
        new anchor.BN(amountBOut.toString()),
        Buffer.alloc(0),
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
        callbackProgram: null,
      })
      .transaction();

    const events = await executeAndParseEvents(
      ctx.svm,
      ctx.program,
      tx,
      [ctx.payer],
    );

    const swap = requireEvent(events, "Swap");

    expect(swap.pool.equals(ctx.accounts.pool)).to.equal(true);
    expect(swap.trader.equals(ctx.payer.publicKey)).to.equal(true);

    expect(swap.amountAIn.toString()).to.equal(amountAIn.toString());
    expect(swap.amountBIn.toString()).to.equal("0");
    expect(swap.amountAOut.toString()).to.equal("0");
    expect(swap.amountBOut.toString()).to.equal(amountBOut.toString());

    expect(eventNames(events)).to.deep.equal([
      "sync",
      "swap",
    ]);

    const sync = requireEvent(events, "Sync");

    expect(sync.pool.equals(ctx.accounts.pool)).to.equal(true);
    expect(sync.reserveA.toString()).to.equal(
      (initialLiquidity + amountAIn).toString(),
    );
    expect(sync.reserveB.toString()).to.equal(
      (initialLiquidity - amountBOut).toString(),
    );
  });

  it("emits Sync with updated reserves after direct token transfers", async () => {
    const ctx = await setupEventsTest();

    const initialLiquidity = 100_000_000n;
    await initializeLiquidity(ctx, initialLiquidity);

    const extraA = 5_000_000n;
    const extraB = 3_000_000n;

    await mintTokens(
      ctx.provider,
      ctx.payer,
      ctx.mintA,
      ctx.providerAccountA,
      extraA,
    );

    await mintTokens(
      ctx.provider,
      ctx.payer,
      ctx.mintB,
      ctx.providerAccountB,
      extraB,
    );

    await transferTokens(
      ctx.provider,
      ctx.payer,
      ctx.providerAccountA,
      ctx.accounts.poolAccountA,
      extraA,
    );

    await transferTokens(
      ctx.provider,
      ctx.payer,
      ctx.providerAccountB,
      ctx.accounts.poolAccountB,
      extraB,
    );

    const tx = await ctx.program.methods
      .sync()
      .accountsPartial({
        pool: ctx.accounts.pool,
        mintA: ctx.mintA,
        mintB: ctx.mintB,
        poolAccountA: ctx.accounts.poolAccountA,
        poolAccountB: ctx.accounts.poolAccountB,
      })
      .transaction();

    // Sync is permissionless: payer signs the transaction
    // for fees, not as an instruction account.
    const events = await executeAndParseEvents(
      ctx.svm,
      ctx.program,
      tx,
      [ctx.payer],
    );

    const sync = requireEvent(events, "Sync");

    expect(sync.pool.equals(ctx.accounts.pool)).to.equal(true);
    expect(sync.reserveA.toString()).to.equal(
      (initialLiquidity + extraA).toString(),
    );
    expect(sync.reserveB.toString()).to.equal(
      (initialLiquidity + extraB).toString(),
    );

    expect(eventNames(events)).to.deep.equal(["sync"]);

    const poolState = await ctx.program.account.pool.fetch(
      ctx.accounts.pool,
    );

    expect(poolState.reserveA.toString()).to.equal(
      sync.reserveA.toString(),
    );
    expect(poolState.reserveB.toString()).to.equal(
      sync.reserveB.toString(),
    );
  });
});
