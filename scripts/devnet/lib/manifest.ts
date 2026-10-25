
import fs from "node:fs";
import path from "node:path";

const manifestPath = path.resolve(
  process.cwd(),
  "scripts/data/devnet.json",
);

export interface DevnetManifest {
  cluster: "devnet";
  wallet: string;
  programs: {
    amm: string;
    router: string;
  };
  tokens: Record<
    string,
    {
      mint: string;
      ata: string;
      decimals: number;
    }
  >;
  config: Record<string, string>;
  pools: Record<string, Record<string, string>>;
  transactions: string[];
}

export function loadManifest(): DevnetManifest {
  return JSON.parse(
    fs.readFileSync(manifestPath, "utf8"),
  ) as DevnetManifest;
}

export function saveManifest(data: DevnetManifest): void {
  fs.mkdirSync(path.dirname(manifestPath), {
    recursive: true,
  });

  const temporaryPath = `${manifestPath}.tmp`;

  fs.writeFileSync(
    temporaryPath,
    JSON.stringify(data, null, 2) + "\n",
  );

  fs.renameSync(temporaryPath, manifestPath);
}

export function updateManifest(
  updates: Partial<DevnetManifest>,
): void {
  const current = loadManifest();

  saveManifest({
    ...current,
    ...updates,
  });
}
