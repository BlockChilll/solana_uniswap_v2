import { createContext } from "./lib/context";

import * as anchor from "@coral-xyz/anchor";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";

import {
  loadManifest,
  updateManifest,
} from "./lib/manifest";

async function main() {
  const { connection, payer } = createContext();

  const manifest = loadManifest();

  if (payer.publicKey.toBase58() !== manifest.wallet) {
    throw new Error("Wallet does not match Devnet manifest");
  }

  // Create two SPL token mints.
  const firstMint = await createMint(
    connection,
    payer,
    payer.publicKey,
    null,
    6,
  );

  const secondMint = await createMint(
    connection,
    payer,
    payer.publicKey,
    null,
    6,
  );

  // Your AMM requires ascending mint order.
  const [mintA, mintB] =
    firstMint.toBuffer().compare(secondMint.toBuffer()) < 0
      ? [firstMint, secondMint]
      : [secondMint, firstMint];

  // Create associated token accounts.
  const accountA = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mintA,
    payer.publicKey,
  );

  const accountB = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mintB,
    payer.publicKey,
  );

  // 1,000 tokens with 6 decimals.
  const amount = 1_000_000_000n;

  await mintTo(
    connection,
    payer,
    mintA,
    accountA.address,
    payer,
    amount,
  );

  await mintTo(
    connection,
    payer,
    mintB,
    accountB.address,
    payer,
    amount,
  );

  // Save public addresses automatically.
  updateManifest({
    tokens: {
      ...manifest.tokens,
      tokenA: {
        mint: mintA.toBase58(),
        ata: accountA.address.toBase58(),
        decimals: 6,
      },
      tokenB: {
        mint: mintB.toBase58(),
        ata: accountB.address.toBase58(),
        decimals: 6,
      },
    },
  });

  console.log("Devnet tokens created successfully!");
  console.log("Token A:", mintA.toBase58());
  console.log("Token B:", mintB.toBase58());
  console.log("Token A ATA:", accountA.address.toBase58());
  console.log("Token B ATA:", accountB.address.toBase58());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
