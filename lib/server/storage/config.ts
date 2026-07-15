export type ClaimGraphStorageDriver = "local" | "hosted";

function normalizeStorageDriver(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();

  if (!normalized) {
    return "local" satisfies ClaimGraphStorageDriver;
  }

  if (normalized === "local" || normalized === "hosted") {
    return normalized satisfies ClaimGraphStorageDriver;
  }

  throw new Error(
    `Unsupported CLAIMGRAPH_STORAGE_DRIVER value "${value}". Use "local" or "hosted".`
  );
}

export function getClaimGraphStorageDriver(
  env: NodeJS.ProcessEnv = process.env
): ClaimGraphStorageDriver {
  const driver = normalizeStorageDriver(env.CLAIMGRAPH_STORAGE_DRIVER);

  if (driver === "hosted" && !env.DATABASE_URL?.trim()) {
    throw new Error(
      "CLAIMGRAPH_STORAGE_DRIVER=hosted requires DATABASE_URL to point at the Neon Postgres database."
    );
  }

  return driver;
}

export function isHostedStorageDriverSelected(
  env: NodeJS.ProcessEnv = process.env
) {
  return getClaimGraphStorageDriver(env) === "hosted";
}

export function getClaimGraphStorageSummary(
  env: NodeJS.ProcessEnv = process.env
) {
  const driver = getClaimGraphStorageDriver(env);

  return {
    driver,
    databaseConfigured: Boolean(env.DATABASE_URL?.trim()),
    localDefault: driver === "local"
  };
}
