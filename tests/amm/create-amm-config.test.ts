
import * as anchor from "@coral-xyz/anchor";
import { LiteSVMProvider } from "anchor-litesvm";
import { Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createTestSvm } from "../helpers/setup";
import type { SolanaV2Amm } from "../../target/types/solana_v2_amm";
import idl from "../../target/idl/solana_v2_amm.json";


describe("AMM - create_amm_config", () => {
  it("creates the AMM configuration", async () => {
    const svm = createTestSvm();

    const provider = new LiteSVMProvider(svm);
    anchor.setProvider(provider);

    const program = new anchor.Program<SolanaV2Amm>(
      idl as SolanaV2Amm,
      provider,
    );

    // Load the development wallet that matches INITIAL_AUTHORITY.
    const walletPath = join(
      homedir(),
      ".config",
      "solana",
      "id.json",
    );

    const payer = Keypair.fromSecretKey(
      Uint8Array.from(
        JSON.parse(readFileSync(walletPath, "utf8")),
      ),
    );

    // Fund the payer in LiteSVM.
    svm.airdrop(
      payer.publicKey,
      BigInt(10 * anchor.web3.LAMPORTS_PER_SOL),
    );

    // Derive the AMM configuration PDA.
    const [ammConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("amm_config")],
      program.programId,
    );

    const feeToSetter = Keypair.generate().publicKey;
    const feeTo = Keypair.generate().publicKey;

    // Initialize the configuration.
    await program.methods
      .createAmmConfig(feeToSetter, feeTo)
      .accountsPartial({
        ammConfig,
        payer: payer.publicKey,
      })
      .signers([payer])
      .rpc();

    // Fetch and verify the initialized account.
    const config = await program.account.ammConfig.fetch(
      ammConfig,
    );

    expect(
      config.feeToSetter.equals(feeToSetter),
    ).to.equal(true);

    expect(
      config.feeTo.equals(feeTo),
    ).to.equal(true);
  });

  it("rejects a default fee_to_setter", async () => {
    const svm = createTestSvm();
    const provider = new LiteSVMProvider(svm);
    anchor.setProvider(provider);

    const program = new anchor.Program<SolanaV2Amm>(
      idl as SolanaV2Amm,
      provider,
    );

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

    const [ammConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("amm_config")],
      program.programId,
    );

    try {
      await program.methods
        .createAmmConfig(
          PublicKey.default,
          Keypair.generate().publicKey,
        )
        .accountsPartial({
          ammConfig,
          payer: payer.publicKey,
        })
        .signers([payer])
        .rpc();

      expect.fail("Expected InvalidFeeToSetter");
    } catch (error) {
      if (error instanceof anchor.AnchorError) {
        expect(error.error.errorCode.code).to.equal("InvalidFeeToSetter");
      } else {
        throw error;
      }
    }
  });

  it("rejects an unauthorized payer", async () => {
    const svm = createTestSvm();
    const provider = new LiteSVMProvider(svm);

    const program = new anchor.Program<SolanaV2Amm>(idl, provider);

    const unauthorizedPayer = Keypair.generate();

    svm.airdrop(
      unauthorizedPayer.publicKey,
      BigInt(10 * anchor.web3.LAMPORTS_PER_SOL),
    );

    const [ammConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("amm_config")],
      program.programId,
    );

    try {
      await program.methods
        .createAmmConfig(
          Keypair.generate().publicKey,
          Keypair.generate().publicKey,
        )
        .accountsPartial({
          ammConfig,
          payer: unauthorizedPayer.publicKey,
        })
        .signers([unauthorizedPayer])
        .rpc();

      expect.fail("Expected Unauthorized");
    } catch (error) {
      if (error instanceof anchor.AnchorError) {
        expect(error.error.errorCode.code).to.equal("Unauthorized");
      } else {
        throw error;
      }
    }
  });

  it("rejects duplicate AMM configuration initialization", async () => {
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

    const [ammConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("amm_config")],
      program.programId,
    );

    const feeToSetter = Keypair.generate().publicKey;
    const feeTo = Keypair.generate().publicKey;

    await program.methods
      .createAmmConfig(feeToSetter, feeTo)
      .accountsPartial({
        ammConfig,
        payer: payer.publicKey,
      })
      .signers([payer])
      .rpc();

    try {
      await program.methods
        .createAmmConfig(
          Keypair.generate().publicKey,
          Keypair.generate().publicKey,
        )
        .accountsPartial({
          ammConfig,
          payer: payer.publicKey,
        })
        .signers([payer])
        .rpc();

      expect.fail("Expected duplicate initialization to fail");
    } catch (error) {
      if (error instanceof Error && error.message === "Expected duplicate initialization to fail") {
        throw error;
      }

      expect(String(error)).to.include("already in use");
    }

    // The original configuration must remain unchanged.
    const config = await program.account.ammConfig.fetch(ammConfig);

    expect(config.feeToSetter.equals(feeToSetter)).to.equal(true);
    expect(config.feeTo.equals(feeTo)).to.equal(true);
  });

  it("allows a default fee_to address", async () => {
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

    const [ammConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("amm_config")],
      program.programId,
    );

    const feeToSetter = Keypair.generate().publicKey;

    await program.methods
      .createAmmConfig(feeToSetter, PublicKey.default)
      .accountsPartial({
        ammConfig,
        payer: payer.publicKey,
      })
      .signers([payer])
      .rpc();

    const config = await program.account.ammConfig.fetch(ammConfig);

    expect(config.feeToSetter.equals(feeToSetter)).to.equal(true);
    expect(config.feeTo.equals(PublicKey.default)).to.equal(true);
  });
});
