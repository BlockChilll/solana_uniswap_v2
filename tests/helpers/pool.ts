import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

export function derivePoolAccounts(
  programId: PublicKey,
  mintA: PublicKey,
  mintB: PublicKey,
) {
  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), mintA.toBuffer(), mintB.toBuffer()],
    programId,
  );

  const [mintLp] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_mint"), pool.toBuffer()],
    programId,
  );

  const [lockedLpAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("lock"), pool.toBuffer()],
    programId,
  );

  return {
    pool,
    mintLp,
    lockedLpAccount,
    poolAccountA: getAssociatedTokenAddressSync(mintA, pool, true),
    poolAccountB: getAssociatedTokenAddressSync(mintB, pool, true),
    poolAccountLp: getAssociatedTokenAddressSync(mintLp, pool, true),
  };
}
