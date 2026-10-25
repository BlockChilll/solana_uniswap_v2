
import * as anchor from "@coral-xyz/anchor";
import { readFileSync } from "node:fs";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, SystemProgram } from "@solana/web3.js";

import type { SolanaV2Amm } from "../../target/types/solana_v2_amm";
import { derivePoolAccounts } from "../../tests/helpers/pool";
import { createContext } from "./lib/context";
import { loadManifest, updateManifest } from "./lib/manifest";

async function main() {
  const { provider, payer } = createContext();
  const manifest = loadManifest();

  const idl = JSON.parse(
    readFileSync("target/idl/solana_v2_amm.json", "utf8"),
  ) as SolanaV2Amm;

  const amm = new anchor.Program<SolanaV2Amm>(
    idl,
    provider,
  );

  const mintA = new PublicKey(manifest.tokens.tokenA.mint);
  const mintB = new PublicKey(manifest.tokens.tokenB.mint);

  const accounts = derivePoolAccounts(
    amm.programId,
    mintA,
    mintB,
  );

  const signature = await amm.methods
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

  updateManifest({
    pools: {
      ...manifest.pools,
      main: Object.fromEntries(
        Object.entries(accounts).map(([key, value]) => [
          key,
          value.toBase58(),
        ]),
      ),
    },
    transactions: [
      ...manifest.transactions,
      signature,
    ],
  });

  console.log("Pool created successfully!");
  console.log("Pool PDA:", accounts.pool.toBase58());
  console.log("LP Mint:", accounts.mintLp.toBase58());
  console.log("Transaction:", signature);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
