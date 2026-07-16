import { copyFileSync, existsSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { buildStarterDataset, DEFAULT_DEMO_QUESTION } from "@/lib/demo/graph-template";
import { computeRunMetrics } from "@/lib/graph/score";
import {
  getLegacyStoreFilePath,
  getStoreDatabaseBackupPath,
  getStoreDatabasePath
} from "@/lib/server/runtime-data";
import { CURRENT_WORKSPACE_GRAPH_RECORD_VERSION } from "@/lib/validation/persisted-artifacts";
import { DEFAULT_WORKSPACE_SETTINGS } from "@/lib/workspace/defaults";
import type {
  ClaimInventoryRecord,
  EvidencePackRecord,
  Run,
  WorkspaceAlphaAssessment,
  Workspace,
  WorkspaceFile,
  WorkspaceGraphRecord
} from "@/types/claimgraph";

type LegacyStoreSnapshot = {
  version?: number;
  workspaces?: Workspace[];
  runs?: Run[];
  workspaceRunOrder?: Array<[string, string[]]>;
  files?: WorkspaceFile[];
  evidencePacks?: EvidencePackRecord[];
  claimInventories?: ClaimInventoryRecord[];
  retrievalStates?: Array<{
    workspaceId: string;
    vectorStoreId: string;
    fileBindings: Array<{
      workspaceFileId: string;
      openAIFileId: string;
      vectorStoreFileId: string;
      syncedAt: string;
    }>;
  }>;
  graphs?: Array<[string, WorkspaceGraphRecord]>;
  workspaceAlphaAssessments?: WorkspaceAlphaAssessment[];
};

export type ClaimGraphDatabase = Database.Database;
export const CURRENT_DATABASE_SCHEMA_VERSION = 7;

const CURRENT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    question TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workspace_capabilities (
    workspace_id TEXT PRIMARY KEY,
    write_capability_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS runs (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    data TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS runs_workspace_seq_idx
    ON runs (workspace_id, seq DESC);

  CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_per_workspace_idx
    ON runs (workspace_id)
    WHERE status IN ('queued', 'ingesting', 'gathering', 'extracting', 'assembling');

  CREATE TABLE IF NOT EXISTS files (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    data TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS files_workspace_uploaded_idx
    ON files (workspace_id, uploaded_at ASC);

  CREATE TABLE IF NOT EXISTS evidence_packs (
    run_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    data TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS evidence_workspace_created_idx
    ON evidence_packs (workspace_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS claim_inventories (
    run_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    data TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS claim_inventory_workspace_created_idx
    ON claim_inventories (workspace_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS retrieval_states (
    workspace_id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS graphs (
    workspace_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    origin TEXT NOT NULL,
    run_id TEXT,
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workspace_alpha_assessments (
    workspace_id TEXT PRIMARY KEY,
    updated_at TEXT NOT NULL,
    data TEXT NOT NULL
  );
`;

type SchemaMigration = {
  version: number;
  description: string;
  apply: (db: ClaimGraphDatabase) => void;
};

const schemaMigrations: SchemaMigration[] = [
  {
    version: 1,
    description: "Create the durable ClaimGraph SQLite tables and indexes.",
    apply(db) {
      db.exec(CURRENT_SCHEMA_SQL);
    }
  },
  {
    version: 2,
    description: "Persist per-workspace alpha assessment notes for launch readiness review.",
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS workspace_alpha_assessments (
          workspace_id TEXT PRIMARY KEY,
          updated_at TEXT NOT NULL,
          data TEXT NOT NULL
        );
      `);
    }
  },
  {
    version: 3,
    description: "Enforce one active analysis run per workspace and add run CAS versions.",
    apply(db) {
      const columns = db.prepare("PRAGMA table_info(runs)").all() as Array<{
        name: string;
      }>;

      if (!columns.some((column) => column.name === "version")) {
        db.exec("ALTER TABLE runs ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
      }

      const duplicateRows = db.prepare(`
        SELECT id, data
        FROM (
          SELECT
            id,
            data,
            ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY seq DESC) AS active_rank
          FROM runs
          WHERE status IN ('queued', 'ingesting', 'gathering', 'extracting', 'assembling')
        )
        WHERE active_rank > 1
      `).all() as Array<{ id: string; data: string }>;

      const retiredAt = new Date().toISOString();
      const retire = db.prepare(`
        UPDATE runs
        SET status = 'failed', version = version + 1, data = ?
        WHERE id = ?
      `);

      for (const row of duplicateRows) {
        const run = JSON.parse(row.data) as Run;
        run.status = "failed";
        run.completedAt = run.completedAt ?? retiredAt;
        run.errorMessage =
          "This duplicate active run was superseded while enabling single-flight execution.";
        run.statusMessage =
          "Run superseded by a newer active analysis for this workspace.";
        retire.run(JSON.stringify(run), row.id);
      }

      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_per_workspace_idx
          ON runs (workspace_id)
          WHERE status IN ('queued', 'ingesting', 'gathering', 'extracting', 'assembling');
      `);
    }
  },
  {
    version: 4,
    description: "Store anonymous workspace write capabilities separately from public workspace data.",
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS workspace_capabilities (
          workspace_id TEXT PRIMARY KEY,
          write_capability_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );
      `);
    }
  },
  {
    version: 5,
    description: "Add durable public-beta resource controls and retryable retention cleanup jobs.",
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS public_beta_rate_limit_buckets (
          scope TEXT NOT NULL,
          subject_hash TEXT NOT NULL,
          window_started_at TEXT NOT NULL,
          count INTEGER NOT NULL,
          expires_at TEXT NOT NULL,
          PRIMARY KEY (scope, subject_hash, window_started_at)
        );

        CREATE INDEX IF NOT EXISTS public_beta_rate_limit_expiry_idx
          ON public_beta_rate_limit_buckets (expires_at ASC);

        CREATE TABLE IF NOT EXISTS public_beta_idempotency_keys (
          scope TEXT NOT NULL,
          key_hash TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          state TEXT NOT NULL,
          response_status INTEGER,
          response_data TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          PRIMARY KEY (scope, key_hash)
        );

        CREATE INDEX IF NOT EXISTS public_beta_idempotency_expiry_idx
          ON public_beta_idempotency_keys (expires_at ASC);

        CREATE TABLE IF NOT EXISTS public_beta_operator_controls (
          id TEXT PRIMARY KEY,
          updated_at TEXT NOT NULL,
          data TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS public_beta_provider_leases (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          acquired_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS public_beta_provider_lease_expiry_idx
          ON public_beta_provider_leases (expires_at ASC);

        CREATE TABLE IF NOT EXISTS cleanup_jobs (
          id TEXT PRIMARY KEY,
          workspace_id TEXT,
          run_id TEXT,
          job_type TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          attempted_at TEXT,
          completed_at TEXT,
          error_message TEXT,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT NOT NULL,
          lease_expires_at TEXT,
          data TEXT NOT NULL,
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS cleanup_jobs_due_idx
          ON cleanup_jobs (status, next_attempt_at ASC, created_at ASC);
      `);
    }
  },
  {
    version: 6,
    description: "Add privacy-minimal operational event buckets and notification state.",
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS operational_event_buckets (
          event_type TEXT NOT NULL,
          window_started_at TEXT NOT NULL,
          occurrence_count INTEGER NOT NULL,
          value_total INTEGER NOT NULL,
          last_seen_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          PRIMARY KEY (event_type, window_started_at)
        );

        CREATE INDEX IF NOT EXISTS operational_event_expiry_idx
          ON operational_event_buckets (expires_at ASC);

        CREATE TABLE IF NOT EXISTS operational_notification_state (
          id TEXT PRIMARY KEY,
          last_status TEXT NOT NULL,
          last_fingerprint TEXT NOT NULL,
          last_attempt_at TEXT,
          last_success_at TEXT,
          last_failure_at TEXT,
          last_failure_code TEXT
        );
      `);
    }
  },
  {
    version: 7,
    description: "Add a durable single-flight lease for operations notifications.",
    apply(db) {
      db.exec(`
        ALTER TABLE operational_notification_state
          ADD COLUMN delivery_lease_id TEXT;
        ALTER TABLE operational_notification_state
          ADD COLUMN delivery_lease_expires_at TEXT;
      `);
    }
  }
];

function stringifyJson(value: unknown) {
  return JSON.stringify(value);
}

function parseLegacyStoreSnapshot() {
  const legacyPath = getLegacyStoreFilePath();

  if (!existsSync(legacyPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(legacyPath, "utf8")) as LegacyStoreSnapshot;
  } catch {
    return null;
  }
}

function configureDatabase(db: ClaimGraphDatabase) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
  `);
}

function ensureSchemaVersionTable(db: ClaimGraphDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
}

function getCurrentSchemaVersion(db: ClaimGraphDatabase) {
  const row = db.prepare(`
    SELECT MAX(version) AS version
    FROM schema_version
  `).get() as { version: number | null } | undefined;

  return row?.version ?? 0;
}

function createPreMigrationBackup(
  db: ClaimGraphDatabase,
  input: {
    fromVersion: number;
    toVersion: number;
    databaseExistedBeforeOpen: boolean;
  }
) {
  if (!input.databaseExistedBeforeOpen) {
    return null;
  }

  db.pragma("wal_checkpoint(TRUNCATE)");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = getStoreDatabaseBackupPath(
    `claimgraph-store.schema-v${input.fromVersion}-to-v${input.toVersion}.${timestamp}.sqlite`
  );
  copyFileSync(getStoreDatabasePath(), backupPath);
  return backupPath;
}

function migrateDatabaseSchema(
  db: ClaimGraphDatabase,
  input: { databaseExistedBeforeOpen: boolean }
) {
  ensureSchemaVersionTable(db);
  const currentVersion = getCurrentSchemaVersion(db);

  if (currentVersion > CURRENT_DATABASE_SCHEMA_VERSION) {
    throw new Error(
      `The ClaimGraph SQLite store uses unsupported future schema version ${currentVersion}. This build supports up to version ${CURRENT_DATABASE_SCHEMA_VERSION}.`
    );
  }

  const pendingMigrations = schemaMigrations.filter(
    (migration) => migration.version > currentVersion
  );

  if (!pendingMigrations.length) {
    return {
      previousVersion: currentVersion,
      currentVersion,
      backupPath: null
    };
  }

  const backupPath = createPreMigrationBackup(db, {
    fromVersion: currentVersion,
    toVersion: pendingMigrations.at(-1)?.version ?? currentVersion,
    databaseExistedBeforeOpen: input.databaseExistedBeforeOpen
  });

  db.exec("BEGIN IMMEDIATE");

  try {
    for (const migration of pendingMigrations) {
      migration.apply(db);
      db.prepare(`
        INSERT INTO schema_version (version, applied_at)
        VALUES (?, ?)
      `).run(migration.version, new Date().toISOString());
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return {
    previousVersion: currentVersion,
    currentVersion: pendingMigrations.at(-1)?.version ?? currentVersion,
    backupPath
  };
}

function countRows(db: ClaimGraphDatabase, table: string) {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as
    | { count: number }
    | undefined;
  return row?.count ?? 0;
}

function insertWorkspace(db: ClaimGraphDatabase, workspace: Workspace) {
  db.prepare(`
    INSERT OR REPLACE INTO workspaces (id, question, created_at, updated_at, data)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    workspace.id,
    workspace.question,
    workspace.createdAt,
    workspace.updatedAt,
    stringifyJson(workspace)
  );
}

function insertRun(db: ClaimGraphDatabase, run: Run) {
  db.prepare(`
    INSERT OR REPLACE INTO runs (id, workspace_id, created_at, status, data)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    run.id,
    run.workspaceId,
    run.createdAt,
    run.status,
    stringifyJson(run)
  );
}

function insertFile(db: ClaimGraphDatabase, file: WorkspaceFile) {
  db.prepare(`
    INSERT OR REPLACE INTO files (id, workspace_id, uploaded_at, data)
    VALUES (?, ?, ?, ?)
  `).run(
    file.id,
    file.workspaceId,
    file.uploadedAt,
    stringifyJson(file)
  );
}

function insertEvidencePack(
  db: ClaimGraphDatabase,
  workspaceId: string,
  record: EvidencePackRecord
) {
  db.prepare(`
    INSERT OR REPLACE INTO evidence_packs (run_id, workspace_id, created_at, data)
    VALUES (?, ?, ?, ?)
  `).run(record.runId, workspaceId, record.createdAt, stringifyJson(record));
}

function insertClaimInventory(
  db: ClaimGraphDatabase,
  workspaceId: string,
  record: ClaimInventoryRecord
) {
  db.prepare(`
    INSERT OR REPLACE INTO claim_inventories (run_id, workspace_id, created_at, data)
    VALUES (?, ?, ?, ?)
  `).run(record.runId, workspaceId, record.createdAt, stringifyJson(record));
}

function insertRetrievalState(
  db: ClaimGraphDatabase,
  state: {
    workspaceId: string;
    vectorStoreId: string;
    fileBindings: Array<{
      workspaceFileId: string;
      openAIFileId: string;
      vectorStoreFileId: string;
      syncedAt: string;
    }>;
  }
) {
  db.prepare(`
    INSERT OR REPLACE INTO retrieval_states (workspace_id, data)
    VALUES (?, ?)
  `).run(state.workspaceId, stringifyJson(state));
}

function insertGraphRecord(
  db: ClaimGraphDatabase,
  workspaceId: string,
  graphRecord: WorkspaceGraphRecord
) {
  db.prepare(`
    INSERT OR REPLACE INTO graphs (workspace_id, created_at, origin, run_id, data)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    workspaceId,
    graphRecord.createdAt,
    graphRecord.origin,
    graphRecord.runId ?? null,
    stringifyJson(graphRecord)
  );
}

function insertWorkspaceAlphaAssessment(
  db: ClaimGraphDatabase,
  assessment: WorkspaceAlphaAssessment
) {
  db.prepare(`
    INSERT OR REPLACE INTO workspace_alpha_assessments (workspace_id, updated_at, data)
    VALUES (?, ?, ?)
  `).run(
    assessment.workspaceId,
    assessment.updatedAt,
    stringifyJson(assessment)
  );
}

function normalizeLegacyRunsForSingleFlight(
  runs: Run[],
  workspaceRunOrder: Array<[string, string[]]>
) {
  const orderByRunId = new Map<string, number>();

  for (const [, runIds] of workspaceRunOrder) {
    runIds.forEach((runId, index) => orderByRunId.set(runId, index));
  }

  const normalizedRuns = runs.map(
    (run) => JSON.parse(stringifyJson(run)) as Run
  );
  const activeRunsByWorkspace = new Map<string, Run[]>();

  for (const run of normalizedRuns) {
    if (
      run.status !== "queued" &&
      run.status !== "ingesting" &&
      run.status !== "gathering" &&
      run.status !== "extracting" &&
      run.status !== "assembling"
    ) {
      continue;
    }

    const workspaceRuns = activeRunsByWorkspace.get(run.workspaceId) ?? [];
    workspaceRuns.push(run);
    activeRunsByWorkspace.set(run.workspaceId, workspaceRuns);
  }

  const retiredAt = new Date().toISOString();

  for (const workspaceRuns of activeRunsByWorkspace.values()) {
    if (workspaceRuns.length < 2) {
      continue;
    }

    workspaceRuns.sort((left, right) => {
      const createdOrder = left.createdAt.localeCompare(right.createdAt);

      if (createdOrder !== 0) {
        return createdOrder;
      }

      return (
        (orderByRunId.get(left.id) ?? -1) -
        (orderByRunId.get(right.id) ?? -1)
      );
    });

    for (const run of workspaceRuns.slice(0, -1)) {
      run.status = "failed";
      run.completedAt = run.completedAt ?? retiredAt;
      run.errorMessage =
        "This duplicate active legacy run was superseded during SQLite migration.";
      run.statusMessage =
        "Run superseded by a newer active analysis for this workspace.";

      const activeStage = [...(run.observability?.stages ?? [])]
        .reverse()
        .find((stage) => !stage.completedAt);

      if (activeStage) {
        activeStage.completedAt = retiredAt;
        activeStage.durationMs = Math.max(
          0,
          new Date(retiredAt).getTime() -
            new Date(activeStage.startedAt).getTime()
        );
      }

      if (run.observability?.execution) {
        run.observability.execution.heartbeatAt = retiredAt;
        run.observability.execution.finishedAt = retiredAt;
      }
    }
  }

  return normalizedRuns;
}

function migrateLegacyJsonStoreIfNeeded(db: ClaimGraphDatabase) {
  if (countRows(db, "workspaces") > 0) {
    return;
  }

  const snapshot = parseLegacyStoreSnapshot();

  if (!snapshot) {
    return;
  }

  const normalizedRuns = normalizeLegacyRunsForSingleFlight(
    snapshot.runs ?? [],
    snapshot.workspaceRunOrder ?? []
  );
  const runsById = new Map(normalizedRuns.map((run) => [run.id, run]));
  const insertedRunIds = new Set<string>();

  db.exec("BEGIN IMMEDIATE");

  try {
    for (const workspace of snapshot.workspaces ?? []) {
      insertWorkspace(db, workspace);
    }

    for (const [workspaceId, runIds] of snapshot.workspaceRunOrder ?? []) {
      for (const runId of runIds) {
        const run = runsById.get(runId);

        if (!run || insertedRunIds.has(runId) || run.workspaceId !== workspaceId) {
          continue;
        }

        insertRun(db, run);
        insertedRunIds.add(runId);
      }
    }

    const remainingRuns = normalizedRuns
      .filter((run) => !insertedRunIds.has(run.id))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

    for (const run of remainingRuns) {
      insertRun(db, run);
    }

    for (const file of snapshot.files ?? []) {
      insertFile(db, file);
    }

    for (const record of snapshot.evidencePacks ?? []) {
      const run = runsById.get(record.runId);

      if (!run) {
        continue;
      }

      insertEvidencePack(db, run.workspaceId, record);
    }

    for (const record of snapshot.claimInventories ?? []) {
      const run = runsById.get(record.runId);

      if (!run) {
        continue;
      }

      insertClaimInventory(db, run.workspaceId, record);
    }

    for (const state of snapshot.retrievalStates ?? []) {
      insertRetrievalState(db, state);
    }

    for (const [workspaceId, graphRecord] of snapshot.graphs ?? []) {
      insertGraphRecord(db, workspaceId, graphRecord);
    }

    for (const assessment of snapshot.workspaceAlphaAssessments ?? []) {
      insertWorkspaceAlphaAssessment(db, assessment);
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function seedDemoWorkspaceIfNeeded(db: ClaimGraphDatabase) {
  const existingDemo = db.prepare(`
    SELECT 1 AS present FROM workspaces WHERE id = 'demo' LIMIT 1
  `).get() as { present: number } | undefined;

  if (existingDemo?.present) {
    return;
  }

  const now = new Date().toISOString();
  const workspace: Workspace = {
    id: "demo",
    question: DEFAULT_DEMO_QUESTION,
    createdAt: now,
    updatedAt: now,
    settings: DEFAULT_WORKSPACE_SETTINGS,
    sourceUrls: []
  };
  const dataset = buildStarterDataset(workspace.question);
  const run: Run = {
    id: "run_demo",
    workspaceId: workspace.id,
    status: "completed",
    createdAt: now,
    completedAt: now,
    statusMessage: "Curated starter graph loaded for the demo workspace.",
    metrics: computeRunMetrics(
      dataset.graph,
      dataset.sources.length,
      dataset.snippets.length
    ),
    observability: {
      stages: [],
      exportEvents: []
    }
  };
  const graphRecord: WorkspaceGraphRecord = {
    recordVersion: CURRENT_WORKSPACE_GRAPH_RECORD_VERSION,
    origin: "starter",
    mode: "demo",
    provider: "starter",
    createdAt: now,
    model: "starter-curated",
    responseId: "starter-demo",
    runId: "run_demo",
    graph: dataset.graph,
    sources: dataset.sources,
    snippets: dataset.snippets
  };

  db.exec("BEGIN IMMEDIATE");

  try {
    insertWorkspace(db, workspace);
    insertRun(db, run);
    insertGraphRecord(db, workspace.id, graphRecord);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function withClaimGraphDatabase<T>(callback: (db: ClaimGraphDatabase) => T) {
  const databasePath = getStoreDatabasePath();
  const databaseExistedBeforeOpen = existsSync(databasePath);
  const db = new Database(databasePath);

  try {
    configureDatabase(db);
    migrateDatabaseSchema(db, { databaseExistedBeforeOpen });
    migrateLegacyJsonStoreIfNeeded(db);
    seedDemoWorkspaceIfNeeded(db);
    return callback(db);
  } finally {
    db.close();
  }
}
