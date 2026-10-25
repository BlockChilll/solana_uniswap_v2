import * as anchor from "@coral-xyz/anchor";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const payer = (provider.wallet as anchor.Wallet).payer;

  const mintA = await createMint(
    provider.connection,
    payer,
    payer.publicKey,
    null,
    6,
  );

  const mintB = await createMint(
    provider.connection,
    payer,
    payer.publicKey,
    null,
    6,
  );

  const tokenA = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    payer,
    mintA,
    payer.publicKey,
  );

  const tokenB = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    payer,
    mintB,
    payer.publicKey,
  );

  await mintTo(
    provider.connection,
    payer,
    mintA,
    tokenA.address,
    payer,
    1_000_000_000n,
  );

  await mintTo(
    provider.connection,
    payer,
    mintB,
    tokenB.address,
    payer,
    1_000_000_000n,
  );

  console.log("Token A:", mintA.toBase58());
  console.log("Token B:", mintB.toBase58());
  console.log("Token A ATA:", tokenA.address.toBase58());
  console.log("Token B ATA:", tokenB.address.toBase58());
}

main().catch(console.error);
