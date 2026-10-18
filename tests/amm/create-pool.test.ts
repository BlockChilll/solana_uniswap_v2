import * as anchor from "@coral-xyz/anchor";
import { LiteSVMProvider } from "anchor-litesvm";
import { Keypair, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  unpackMint,
  unpackAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createTestSvm } from "../helpers/setup";
import { createMint } from "../helpers/token";
import { derivePoolAccounts } from "../helpers/pool";
import type { SolanaV2Amm } from "../../target/types/solana_v2_amm";
import { SendTransactionError } from "@solana/web3.js";

const idl = JSON.parse(
  readFileSync("target/idl/solana_v2_amm.json", "utf8"),
) as SolanaV2Amm;

describe("AMM - create_pool", () => {
  it("creates a pool with correct initial state", async () => {
    const svm = createTestSvm();
    const provider = new LiteSVMProvider(svm);
    const program = new anchor.Program<SolanaV2Amm>(idl, provider);

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

    // Create and sort the two token mints.
    const firstMint = await createMint(svm, provider, payer);
    const secondMint = await createMint(svm, provider, payer);

    const [mintA, mintB] =
      firstMint.toBuffer().compare(secondMint.toBuffer()) < 0
        ? [firstMint, secondMint]
        : [secondMint, firstMint];

    // Derive all pool accounts.
    const accounts = derivePoolAccounts(
      program.programId,
      mintA,
      mintB,
    );

    const {
      pool,
      mintLp,
      poolAccountA,
      poolAccountB,
      poolAccountLp,
      lockedLpAccount,
    } = accounts;

    // Create the pool.
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

    // Verify the pool state.
    const poolState = await program.account.pool.fetch(pool);

    expect(poolState.mintA.equals(mintA)).to.equal(true);
    expect(poolState.mintB.equals(mintB)).to.equal(true);

    expect(poolState.reserveA.toString()).to.equal("0");
    expect(poolState.reserveB.toString()).to.equal("0");
    expect(poolState.kLast.toString()).to.equal("0");

    expect(
      poolState.priceACumulativeLast.map((value) => value.toString()),
    ).to.deep.equal(["0", "0", "0", "0"]);

    expect(
      poolState.priceBCumulativeLast.map((value) => value.toString()),
    ).to.deep.equal(["0", "0", "0", "0"]);

    const [, poolBump] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("pool"),
        mintA.toBuffer(),
        mintB.toBuffer(),
      ],
      program.programId,
    );

    expect(poolState.bump).to.equal(poolBump);

    // Fetch initialized SPL accounts.
    const lpMintAccount = await provider.connection.getAccountInfo(mintLp);
    const tokenAAccount = await provider.connection.getAccountInfo(poolAccountA);
    const tokenBAccount = await provider.connection.getAccountInfo(poolAccountB);
    const lpAccount = await provider.connection.getAccountInfo(poolAccountLp);
    const lockedAccount = await provider.connection.getAccountInfo(lockedLpAccount);

    expect(lpMintAccount).to.not.equal(null);
    expect(tokenAAccount).to.not.equal(null);
    expect(tokenBAccount).to.not.equal(null);
    expect(lpAccount).to.not.equal(null);
    expect(lockedAccount).to.not.equal(null);

    // Verify LP mint configuration.
    const lpMint = unpackMint(mintLp, lpMintAccount!, TOKEN_PROGRAM_ID);

    expect(lpMint.decimals).to.equal(6);
    expect(lpMint.mintAuthority?.equals(pool)).to.equal(true);
    expect(lpMint.supply).to.equal(0n);

    // Verify token account mints, authorities, and balances.
    for (const [address, accountInfo, expectedMint] of [
      [poolAccountA, tokenAAccount, mintA],
      [poolAccountB, tokenBAccount, mintB],
      [poolAccountLp, lpAccount, mintLp],
      [lockedLpAccount, lockedAccount, mintLp],
    ] as const) {
      const tokenAccount = unpackAccount(
        address,
        accountInfo!,
        TOKEN_PROGRAM_ID,
      );

      expect(tokenAccount.mint.equals(expectedMint)).to.equal(true);
      expect(tokenAccount.owner.equals(pool)).to.equal(true);
      expect(tokenAccount.amount).to.equal(0n);
    }
  });

  it("rejects reversed mint ordering", async () => {
    const svm = createTestSvm();
    const provider = new LiteSVMProvider(svm);
    const program = new anchor.Program<SolanaV2Amm>(idl, provider);

    const payer = Keypair.generate();

    svm.airdrop(
      payer.publicKey,
      BigInt(10 * anchor.web3.LAMPORTS_PER_SOL),
    );

    const firstMint = await createMint(svm, provider, payer);
    const secondMint = await createMint(svm, provider, payer);

    // Deliberately sort in descending order.
    const [mintA, mintB] =
      firstMint.toBuffer().compare(secondMint.toBuffer()) > 0
        ? [firstMint, secondMint]
        : [secondMint, firstMint];

    const accounts = derivePoolAccounts(program.programId, mintA, mintB);

    try {
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

      expect.fail("Expected InvalidMintOrder");
    } catch (error) {
      if (error instanceof anchor.AnchorError) {
        expect(error.error.errorCode.code).to.equal("InvalidMintOrder");
      } else {
        throw error;
      }
    }
  });

  it("rejects duplicate pool initialization", async () => {
    const svm = createTestSvm();
    const provider = new LiteSVMProvider(svm);
    const program = new anchor.Program<SolanaV2Amm>(idl, provider);

    const payer = Keypair.generate();

    svm.airdrop(
      payer.publicKey,
      BigInt(10 * anchor.web3.LAMPORTS_PER_SOL),
    );

    const firstMint = await createMint(svm, provider, payer);
    const secondMint = await createMint(svm, provider, payer);

    // Correct ascending order.
    const [mintA, mintB] =
      firstMint.toBuffer().compare(secondMint.toBuffer()) < 0
        ? [firstMint, secondMint]
        : [secondMint, firstMint];

    const accounts = derivePoolAccounts(program.programId, mintA, mintB);

    const createPool = () =>
      program.methods
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

    // First initialization succeeds.
    await createPool();

    // Second initialization must fail.
    let rejected = false;

    try {
      await createPool();
    } catch (error) {
      if (error instanceof SendTransactionError) {
        rejected = true;
      } else {
        throw error;
      }
    }

    expect(rejected).to.equal(true, "Duplicate pool initialization must fail");

    // The original pool must remain unchanged.
    const poolState = await program.account.pool.fetch(accounts.pool);

    expect(poolState.mintA.equals(mintA)).to.equal(true);
    expect(poolState.mintB.equals(mintB)).to.equal(true);

    expect(poolState.reserveA.toString()).to.equal("0");
    expect(poolState.reserveB.toString()).to.equal("0");
    expect(poolState.kLast.toString()).to.equal("0");
  });

  it("rejects identical token mints", async () => {
    const svm = createTestSvm();
    const provider = new LiteSVMProvider(svm);
    const program = new anchor.Program<SolanaV2Amm>(idl, provider);

    const payer = Keypair.generate();

    svm.airdrop(
      payer.publicKey,
      BigInt(10 * anchor.web3.LAMPORTS_PER_SOL),
    );

    const mint = await createMint(svm, provider, payer);

    const accounts = derivePoolAccounts(
      program.programId,
      mint,
      mint,
    );

    try {
      await program.methods
        .createPool()
        .accountsPartial({
          ...accounts,
          mintA: mint,
          mintB: mint,
          payer: payer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([payer])
        .rpc();

      expect.fail("Expected identical token mints to be rejected");
    } catch (error) {
      if (error instanceof anchor.AnchorError) {
        expect(error.error.errorCode.code).to.equal("InvalidMintOrder");
      } else if (error instanceof SendTransactionError) {
        expect(error.message).to.include("IllegalOwner");
      } else {
        throw error;
      }
    }

    // Failed initialization must not leave a pool account behind.
    const poolAccount = svm.getAccount(accounts.pool);

    expect(poolAccount).to.equal(null);

    expect(poolAccount).to.equal(null);
  });
});
