import { getNeonSql } from "@/lib/server/storage/neon-client";
import { getClaimGraphNeonSchemaStatements } from "@/lib/server/storage/neon-schema";

let readyForDatabaseUrl: string | null = null;
let readinessPromise: Promise<void> | null = null;

export async function ensureHostedStorageSchema(
  env: NodeJS.ProcessEnv = process.env,
  getSql: typeof getNeonSql = getNeonSql
) {
  const databaseUrl = env.DATABASE_URL?.trim() ?? "";

  if (readyForDatabaseUrl === databaseUrl && readinessPromise) {
    await readinessPromise;
    return;
  }

  readyForDatabaseUrl = databaseUrl;
  readinessPromise = (async () => {
    const sql = await getSql(env);

    for (const statement of getClaimGraphNeonSchemaStatements()) {
      await sql.query(statement);
    }
  })();

  try {
    await readinessPromise;
  } catch (error) {
    readyForDatabaseUrl = null;
    readinessPromise = null;
    throw error;
  }
}

export async function getReadyHostedSql() {
  await ensureHostedStorageSchema();
  return getNeonSql();
}

export function resetHostedStorageSchemaForTests() {
  readyForDatabaseUrl = null;
  readinessPromise = null;
}
