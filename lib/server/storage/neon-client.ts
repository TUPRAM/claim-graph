import type { NeonQueryFunction } from "@neondatabase/serverless";

type NeonSql = NeonQueryFunction<false, false>;

let cachedDatabaseUrl: string | null = null;
let cachedSql: NeonSql | null = null;

export async function getNeonSql(
  env: NodeJS.ProcessEnv = process.env
): Promise<NeonSql> {
  const databaseUrl = env.DATABASE_URL?.trim();

  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required before the hosted ClaimGraph store can connect to Neon."
    );
  }

  if (cachedSql && cachedDatabaseUrl === databaseUrl) {
    return cachedSql;
  }

  const { neon } = await import("@neondatabase/serverless");
  cachedDatabaseUrl = databaseUrl;
  cachedSql = neon(databaseUrl);
  return cachedSql;
}

export function resetCachedNeonSqlForTests() {
  cachedDatabaseUrl = null;
  cachedSql = null;
}
