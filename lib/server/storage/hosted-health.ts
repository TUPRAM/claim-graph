import { getNeonSql } from "@/lib/server/storage/neon-client";
import { getClaimGraphNeonSchemaStatements } from "@/lib/server/storage/neon-schema";

const REQUIRED_HOSTED_TABLES = [
  "claimgraph_workspaces",
  "claimgraph_runs",
  "claimgraph_graph_records",
  "claimgraph_sources",
  "claimgraph_snippets",
  "claimgraph_workspace_files",
  "claimgraph_artifact_records",
  "claimgraph_cleanup_jobs",
  "claimgraph_rate_limit_buckets",
  "claimgraph_idempotency_keys",
  "claimgraph_operator_controls",
  "claimgraph_provider_leases",
  "claimgraph_operational_event_buckets",
  "claimgraph_operational_notification_state"
] as const;

interface InformationSchemaTableRow {
  table_name: string;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown hosted storage health error.";
}

export async function checkHostedStorageHealth() {
  const sql = await getNeonSql();

  await sql.query("SELECT 1 AS ok");

  try {
    for (const statement of getClaimGraphNeonSchemaStatements()) {
      await sql.query(statement);
    }
  } catch (error) {
    return {
      databaseReachable: true,
      schemaInitialized: false,
      requiredTables: [...REQUIRED_HOSTED_TABLES],
      missingTables: [...REQUIRED_HOSTED_TABLES],
      error: errorMessage(error)
    };
  }

  const rows = (await sql.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN (
        'claimgraph_workspaces',
        'claimgraph_runs',
        'claimgraph_graph_records',
        'claimgraph_sources',
        'claimgraph_snippets',
        'claimgraph_workspace_files',
        'claimgraph_artifact_records',
        'claimgraph_cleanup_jobs',
        'claimgraph_rate_limit_buckets',
        'claimgraph_idempotency_keys',
        'claimgraph_operator_controls',
        'claimgraph_provider_leases',
        'claimgraph_operational_event_buckets',
        'claimgraph_operational_notification_state'
      )
  `)) as InformationSchemaTableRow[];
  const presentTables = new Set(rows.map((row) => row.table_name));
  const missingTables = REQUIRED_HOSTED_TABLES.filter(
    (table) => !presentTables.has(table)
  );

  return {
    databaseReachable: true,
    schemaInitialized: missingTables.length === 0,
    requiredTables: [...REQUIRED_HOSTED_TABLES],
    missingTables
  };
}
