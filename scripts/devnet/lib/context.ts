import "dotenv/config";
import * as anchor from "@coral-xyz/anchor";

export function createContext() {
  const provider = anchor.AnchorProvider.env();

  anchor.setProvider(provider);

  return {
    provider,
    connection: provider.connection,
    payer: (provider.wallet as anchor.Wallet).payer,
  };
}
