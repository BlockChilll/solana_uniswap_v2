import { LiteSVMProvider } from "anchor-litesvm";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
  createInitializeMintInstruction,
} from "@solana/spl-token";
import {
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { createTestSvm } from "./setup";

export async function createMint(
  svm: ReturnType<typeof createTestSvm>,
  provider: LiteSVMProvider,
  payer: Keypair,
  decimals = 6,
): Promise<PublicKey> {
  const mint = Keypair.generate();

  const rent = svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE));

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      space: MINT_SIZE,
      lamports: Number(rent),
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(
      mint.publicKey,
      decimals,
      payer.publicKey,
      null,
    ),
  );

  await provider.sendAndConfirm(tx, [payer, mint]);

  return mint.publicKey;
}

export async function createTokenAccount(
  provider: LiteSVMProvider,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey,
): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(
    mint,
    owner,
    true,
  );

  const tx = new Transaction().add(
    createAssociatedTokenAccountInstruction(
      payer.publicKey,
      ata,
      owner,
      mint,
    ),
  );

  await provider.sendAndConfirm(tx, [payer]);

  return ata;
}

export async function mintTokens(
  provider: LiteSVMProvider,
  authority: Keypair,
  mint: PublicKey,
  destination: PublicKey,
  amount: bigint,
): Promise<void> {
  const tx = new Transaction().add(
    createMintToInstruction(
      mint,
      destination,
      authority.publicKey,
      amount,
    ),
  );

  await provider.sendAndConfirm(tx, [authority]);
}

export async function transferTokens(
  provider: LiteSVMProvider,
  owner: Keypair,
  source: PublicKey,
  destination: PublicKey,
  amount: bigint,
): Promise<void> {
  const tx = new Transaction().add(
    createTransferInstruction(
      source,
      destination,
      owner.publicKey,
      amount,
    ),
  );

  await provider.sendAndConfirm(tx, [owner]);
}
