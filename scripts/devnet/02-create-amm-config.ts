
import * as anchor from "@coral-xyz/anchor";

import { readFileSync } from "node:fs";
import type { SolanaV2Amm } from "../../target/types/solana_v2_amm";

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

  if (amm.programId.toBase58() !== manifest.programs.amm) {
    throw new Error("AMM program ID does not match manifest");
  }

  const [ammConfig] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("amm_config")],
    amm.programId,
  );

  const signature = await amm.methods
    .createAmmConfig(payer.publicKey, anchor.web3.PublicKey.default)
    .accountsPartial({
      ammConfig,
      payer: payer.publicKey,
    })
    .signers([payer])
    .rpc();

  updateManifest({
    config: {
      ...manifest.config,
      ammConfig: ammConfig.toBase58(),
    },
    transactions: [
      ...manifest.transactions,
      signature,
    ],
  });

  console.log("AMM config created!");
  console.log("Config PDA:", ammConfig.toBase58());
  console.log("Transaction:", signature);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
