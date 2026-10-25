import * as anchor from "@coral-xyz/anchor";
import { readFileSync } from "node:fs";
import { PublicKey, AccountMeta } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

import type { SolanaV2Amm } from "../../target/types/solana_v2_amm";
import type { SolanaV2Router } from "../../target/types/solana_v2_router";

import { createContext } from "./lib/context";
import { loadManifest, updateManifest } from "./lib/manifest";

function getAmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
): bigint {
  const amountInWithFee = amountIn * 997n;

  return (
    amountInWithFee * reserveOut
  ) / (
    reserveIn * 1000n + amountInWithFee
  );
}

async function main() {
  const { provider, payer } = createContext();
  const manifest = loadManifest();

  const ammIdl = JSON.parse(
    readFileSync("target/idl/solana_v2_amm.json", "utf8"),
  ) as SolanaV2Amm;

  const routerIdl = JSON.parse(
    readFileSync("target/idl/solana_v2_router.json", "utf8"),
  ) as SolanaV2Router;

  const amm = new anchor.Program<SolanaV2Amm>(
    ammIdl,
    provider,
  );

  const router = new anchor.Program<SolanaV2Router>(
    routerIdl,
    provider,
  );

  const mintA = new PublicKey(manifest.tokens.tokenA.mint);
  const mintB = new PublicKey(manifest.tokens.tokenB.mint);

  const pool = manifest.pools.main;
  const poolAddress = new PublicKey(pool.pool);

  // Read current reserves because they change after each swap.
  const poolState = await amm.account.pool.fetch(poolAddress);

  const reserveA = BigInt(poolState.reserveA.toString());
  const reserveB = BigInt(poolState.reserveB.toString());

  // Swap 1 Token A for Token B.
  const amountIn = 1_000_000n;

  const expectedOut = getAmountOut(
    amountIn,
    reserveA,
    reserveB,
  );

  // Allow 1% slippage.
  const minOut = expectedOut * 99n / 100n;

  const deadline = Math.floor(Date.now() / 1000) + 600;

  // Your Router expects five accounts per pool hop.
  const remainingAccounts: AccountMeta[] = [
    {
      pubkey: poolAddress,
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: mintA,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: mintB,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: new PublicKey(pool.poolAccountA),
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: new PublicKey(pool.poolAccountB),
      isSigner: false,
      isWritable: true,
    },
  ];

  const signature = await router.methods
    .swapExactTokensForTokens(
      new anchor.BN(amountIn.toString()),
      new anchor.BN(minOut.toString()),
      [mintA, mintB],
      new anchor.BN(deadline),
    )
    .accountsPartial({
      trader: payer.publicKey,
      userTokenAccount: new PublicKey(
        manifest.tokens.tokenA.ata,
      ),
      toTokenAccount: new PublicKey(
        manifest.tokens.tokenB.ata,
      ),
      ammProgram: amm.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .remainingAccounts(remainingAccounts)
    .signers([payer])
    .rpc();

  updateManifest({
    transactions: [
      ...manifest.transactions,
      signature,
    ],
  });

  console.log("Swap completed successfully!");
  console.log("Input: 1 Token A");
  console.log(
    "Expected output:",
    Number(expectedOut) / 1_000_000,
    "Token B",
  );
  console.log("Transaction:", signature);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
