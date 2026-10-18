
import * as anchor from "@coral-xyz/anchor";
import { LiteSVM } from "litesvm";
import { Keypair, Transaction } from "@solana/web3.js";
import { expect } from "chai";

export async function executeAndParseEvents(
  svm: LiteSVM,
  program: anchor.Program<any>,
  transaction: Transaction,
  signers: Keypair[],
) {
  if (signers.length === 0) {
    throw new Error("At least one signer is required");
  }

  svm.expireBlockhash();

  transaction.recentBlockhash = svm.latestBlockhash();
  transaction.feePayer = signers[0].publicKey;
  transaction.sign(...signers);

  const result = svm.sendTransaction(transaction);

  if (!("logs" in result)) {
    throw new Error(`Transaction failed: ${String(result)}`);
  }

  const parser = new anchor.EventParser(
    program.programId,
    program.coder,
  );

  return [...parser.parseLogs(result.logs())];
}

export function requireEvent(
  events: Array<{ name: string; data: any }>,
  name: string,
) {
  const normalizedName =
    name.charAt(0).toLowerCase() + name.slice(1);

  const event = events.find(
    (event) => event.name === normalizedName,
  );

  expect(event, `Expected ${name} event`).to.exist;

  return event!.data;
}
