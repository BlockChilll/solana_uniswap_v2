
import * as anchor from "@coral-xyz/anchor";
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";

import type { SolanaV2Router } from "../../target/types/solana_v2_router";
import { createContext } from "./lib/context";
import { loadManifest, updateManifest } from "./lib/manifest";

async function main() {
  const { provider, connection, payer } = createContext();
  const manifest = loadManifest();

  const idl = JSON.parse(
    readFileSync("target/idl/solana_v2_router.json", "utf8"),
  ) as SolanaV2Router;

  const router = new anchor.Program<SolanaV2Router>(
    idl,
    provider,
  );

  const pool = manifest.pools.main;

  const mintA = new PublicKey(manifest.tokens.tokenA.mint);
  const mintB = new PublicKey(manifest.tokens.tokenB.mint);
  const mintLp = new PublicKey(pool.mintLp);

  // Create the wallet's LP token account.
  const lpAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mintLp,
    payer.publicKey,
  );

  const amount = new anchor.BN("100000000");

  // Deadline: 10 minutes from now.
  const deadline = new anchor.BN(
    Math.floor(Date.now() / 1000) + 600,
  );

  const signature = await router.methods
    .addLiquidity(
      amount,
      amount,
      amount,
      amount,
      deadline,
    )
    .accountsPartial({
      ammProgram: new PublicKey(manifest.programs.amm),
      ammConfig: new PublicKey(manifest.config.ammConfig),
      pool: new PublicKey(pool.pool),
      mintA,
      mintB,
      userAccountA: new PublicKey(manifest.tokens.tokenA.ata),
      userAccountB: new PublicKey(manifest.tokens.tokenB.ata),
      poolAccountA: new PublicKey(pool.poolAccountA),
      poolAccountB: new PublicKey(pool.poolAccountB),
      lockedLpAccount: new PublicKey(pool.lockedLpAccount),
      mintLp,
      feeToLpAccount: null,
      toLpAccount: lpAccount.address,
      provider: payer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([payer])
    .rpc();

  updateManifest({
    pools: {
      ...manifest.pools,
      main: {
        ...pool,
        userLpAccount: lpAccount.address.toBase58(),
      },
    },
    transactions: [
      ...manifest.transactions,
      signature,
    ],
  });

  console.log("Liquidity added successfully!");
  console.log("Amount A: 100");
  console.log("Amount B: 100");
  console.log("LP token account:", lpAccount.address.toBase58());
  console.log("Transaction:", signature);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
