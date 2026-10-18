
import * as anchor from "@coral-xyz/anchor";
import { LiteSVMProvider } from "anchor-litesvm";
import { Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createTestSvm } from "../helpers/setup";
import type { SolanaV2Amm } from "../../target/types/solana_v2_amm";

const idl = JSON.parse(
  readFileSync("target/idl/solana_v2_amm.json", "utf8"),
) as SolanaV2Amm;

describe("AMM - admin", () => {
  async function setupAdminTest() {
    const svm = createTestSvm();
    const provider = new LiteSVMProvider(svm);
    const program = new anchor.Program<SolanaV2Amm>(idl, provider);

    const payer = Keypair.fromSecretKey(
      Uint8Array.from(
        JSON.parse(
          readFileSync(
            join(homedir(), ".config/solana/id.json"),
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

    return { svm, provider, program, payer, ammConfig };
  }

  it("allows the fee setter to enable and disable protocol fees", async () => {
    const ctx = await setupAdminTest();
    const recipient = Keypair.generate();

    await ctx.program.methods
      .setFeeTo(recipient.publicKey)
      .accountsPartial({
        ammConfig: ctx.ammConfig,
        feeToSetter: ctx.payer.publicKey,
      })
      .signers([ctx.payer])
      .rpc();

    let config = await ctx.program.account.ammConfig.fetch(
      ctx.ammConfig,
    );

    expect(config.feeTo.equals(recipient.publicKey)).to.equal(true);

    ctx.svm.expireBlockhash();

    await ctx.program.methods
      .setFeeTo(PublicKey.default)
      .accountsPartial({
        ammConfig: ctx.ammConfig,
        feeToSetter: ctx.payer.publicKey,
      })
      .signers([ctx.payer])
      .rpc();

    config = await ctx.program.account.ammConfig.fetch(
      ctx.ammConfig,
    );

    expect(config.feeTo.equals(PublicKey.default)).to.equal(true);
  });

  it("rejects unauthorized changes to fee_to", async () => {
    const ctx = await setupAdminTest();
    const unauthorized = Keypair.generate();

    ctx.svm.airdrop(
      unauthorized.publicKey,
      BigInt(anchor.web3.LAMPORTS_PER_SOL),
    );

    try {
      await ctx.program.methods
        .setFeeTo(Keypair.generate().publicKey)
        .accountsPartial({
          ammConfig: ctx.ammConfig,
          feeToSetter: unauthorized.publicKey,
        })
        .signers([unauthorized])
        .rpc();

      expect.fail("Expected unauthorized update to fail");
    } catch (error) {
      expect(String(error)).to.include("Unauthorized");
    }

    const config = await ctx.program.account.ammConfig.fetch(
      ctx.ammConfig,
    );

    expect(config.feeTo.equals(PublicKey.default)).to.equal(true);
  });

  it("transfers fee setter authority to a new signer", async () => {
    const ctx = await setupAdminTest();
    const newSetter = Keypair.generate();

    ctx.svm.airdrop(
      newSetter.publicKey,
      BigInt(anchor.web3.LAMPORTS_PER_SOL),
    );

    await ctx.program.methods
      .setFeeToSetter(newSetter.publicKey)
      .accountsPartial({
        ammConfig: ctx.ammConfig,
        feeToSetter: ctx.payer.publicKey,
      })
      .signers([ctx.payer])
      .rpc();

    let config = await ctx.program.account.ammConfig.fetch(
      ctx.ammConfig,
    );

    expect(config.feeToSetter.equals(newSetter.publicKey)).to.equal(true);

    // Old authority must no longer be able to change fee_to.
    ctx.svm.expireBlockhash();

    try {
      await ctx.program.methods
        .setFeeTo(Keypair.generate().publicKey)
        .accountsPartial({
          ammConfig: ctx.ammConfig,
          feeToSetter: ctx.payer.publicKey,
        })
        .signers([ctx.payer])
        .rpc();

      expect.fail("Expected old authority to be rejected");
    } catch (error) {
      expect(String(error)).to.include("Unauthorized");
    }

    // New authority can update fee_to.
    ctx.svm.expireBlockhash();

    const recipient = Keypair.generate();

    await ctx.program.methods
      .setFeeTo(recipient.publicKey)
      .accountsPartial({
        ammConfig: ctx.ammConfig,
        feeToSetter: newSetter.publicKey,
      })
      .signers([newSetter])
      .rpc();

    config = await ctx.program.account.ammConfig.fetch(
      ctx.ammConfig,
    );

    expect(config.feeTo.equals(recipient.publicKey)).to.equal(true);
  });

  it("rejects unauthorized fee setter transfers", async () => {
    const ctx = await setupAdminTest();
    const unauthorized = Keypair.generate();

    ctx.svm.airdrop(
      unauthorized.publicKey,
      BigInt(anchor.web3.LAMPORTS_PER_SOL),
    );

    try {
      await ctx.program.methods
        .setFeeToSetter(Keypair.generate().publicKey)
        .accountsPartial({
          ammConfig: ctx.ammConfig,
          feeToSetter: unauthorized.publicKey,
        })
        .signers([unauthorized])
        .rpc();

      expect.fail("Expected unauthorized transfer to fail");
    } catch (error) {
      expect(String(error)).to.include("Unauthorized");
    }

    const config = await ctx.program.account.ammConfig.fetch(
      ctx.ammConfig,
    );

    expect(config.feeToSetter.equals(ctx.payer.publicKey)).to.equal(true);
  });
});
