import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  CURRENT_DATABASE_SCHEMA_VERSION,
  withClaimGraphDatabase
} from "@/lib/server/database";
import {
  getStoreDatabaseBackupsDir,
  getStoreDatabasePath
} from "@/lib/server/runtime-data";
import { getWorkspaceGraphPayload, resetStoreForTests } from "@/lib/server/store";
import { CURRENT_WORKSPACE_GRAPH_RECORD_VERSION } from "@/lib/validation/persisted-artifacts";

const originalDataDir = process.env.CLAIMGRAPH_DATA_DIR;
const testDataDir = path.join(process.cwd(), "runtime_data", "test_state", "database-schema");

const UNVERSIONED_CURRENT_SCHEMA_SQL = `
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    question TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    data TEXT NOT NULL
  );

  CREATE TABLE runs (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL,
    data TEXT NOT NULL
  );

  CREATE INDEX runs_workspace_seq_idx
    ON runs (workspace_id, seq DESC);

  CREATE TABLE files (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    data TEXT NOT NULL
  );

  CREATE INDEX files_workspace_uploaded_idx
    ON files (workspace_id, uploaded_at ASC);

  CREATE TABLE evidence_packs (
    run_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    data TEXT NOT NULL
  );

  CREATE INDEX evidence_workspace_created_idx
    ON evidence_packs (workspace_id, created_at DESC);

  CREATE TABLE claim_inventories (
    run_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    data TEXT NOT NULL
  );

  CREATE INDEX claim_inventory_workspace_created_idx
    ON claim_inventories (workspace_id, created_at DESC);

  CREATE TABLE retrieval_states (
    workspace_id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );

  CREATE TABLE graphs (
    workspace_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    origin TEXT NOT NULL,
    run_id TEXT,
    data TEXT NOT NULL
  );
`;

describe("database schema versioning", () => {
  beforeEach(() => {
    process.env.CLAIMGRAPH_DATA_DIR = testDataDir;
    rmSync(testDataDir, { recursive: true, force: true });
    resetStoreForTests();
  });

  afterAll(() => {
    rmSync(testDataDir, { recursive: true, force: true });
    resetStoreForTests();

    if (originalDataDir === undefined) {
      delete process.env.CLAIMGRAPH_DATA_DIR;
    } else {
      process.env.CLAIMGRAPH_DATA_DIR = originalDataDir;
    }
  });

  it("reopens a current-schema database without creating duplicate version rows or backups", () => {
    withClaimGraphDatabase(() => undefined);

    const initialDb = new Database(getStoreDatabasePath(), { readonly: true });
    const initialVersionRow = initialDb.prepare(`
      SELECT MAX(version) AS version, COUNT(*) AS count
      FROM schema_version
    `).get() as { version: number; count: number };
    initialDb.close();

    expect(initialVersionRow).toMatchObject({
      version: CURRENT_DATABASE_SCHEMA_VERSION,
      count: CURRENT_DATABASE_SCHEMA_VERSION
    });

    withClaimGraphDatabase(() => undefined);

    const reopenedDb = new Database(getStoreDatabasePath(), { readonly: true });
    const reopenedVersionRow = reopenedDb.prepare(`
      SELECT MAX(version) AS version, COUNT(*) AS count
      FROM schema_version
    `).get() as { version: number; count: number };
    reopenedDb.close();

    expect(reopenedVersionRow).toMatchObject({
      version: CURRENT_DATABASE_SCHEMA_VERSION,
      count: CURRENT_DATABASE_SCHEMA_VERSION
    });

    const backupsDir = getStoreDatabaseBackupsDir();
    expect(readdirSync(backupsDir)).toEqual([]);
  });

  it("upgrades an existing unversioned SQLite store and creates a pre-migration backup", () => {
    const db = new Database(getStoreDatabasePath());
    db.exec(UNVERSIONED_CURRENT_SCHEMA_SQL);

    const workspace = {
      id: "workspace_unversioned",
      question: "Should cities ban cars downtown?",
      createdAt: "2026-04-10T10:00:00.000Z",
      updatedAt: "2026-04-10T10:00:00.000Z",
      settings: {
        maxWebSources: 8,
        maxFiles: 5,
        freshnessBias: "high",
        preferPrimarySources: true,
        includeOpposingEvidence: true
      }
    };
    const graphRecord = {
      recordVersion: CURRENT_WORKSPACE_GRAPH_RECORD_VERSION,
      origin: "live" as const,
      createdAt: "2026-04-10T10:01:00.000Z",
      model: "gpt-5.4",
      responseId: "resp_graph_unversioned",
      graph: {
        question: workspace.question,
        graphSummary: "Unversioned graph summary.",
        nodes: [
          {
            id: "question_root",
            kind: "question",
            title: workspace.question,
            summary: "question",
            sourceIds: [],
            snippetIds: []
          }
        ],
        edges: [],
        disagreementClusters: []
      },
      sources: [],
      snippets: []
    };

    db.prepare(`
      INSERT INTO workspaces (id, question, created_at, updated_at, data)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      workspace.id,
      workspace.question,
      workspace.createdAt,
      workspace.updatedAt,
      JSON.stringify(workspace)
    );
    db.prepare(`
      INSERT INTO graphs (workspace_id, created_at, origin, run_id, data)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      workspace.id,
      graphRecord.createdAt,
      graphRecord.origin,
      null,
      JSON.stringify(graphRecord)
    );
    db.close();

    const payload = getWorkspaceGraphPayload(workspace.id);

    expect(payload?.starterMode).toBe(false);
    expect(payload?.graph.graphSummary).toBe("Unversioned graph summary.");

    const migratedDb = new Database(getStoreDatabasePath(), { readonly: true });
    const versionRow = migratedDb.prepare(`
      SELECT MAX(version) AS version, COUNT(*) AS count
      FROM schema_version
    `).get() as { version: number; count: number };
    migratedDb.close();

    expect(versionRow).toMatchObject({
      version: CURRENT_DATABASE_SCHEMA_VERSION,
      count: CURRENT_DATABASE_SCHEMA_VERSION
    });

    const backupsDir = getStoreDatabaseBackupsDir();
    const backupFiles = readdirSync(backupsDir);

    expect(backupFiles.length).toBe(1);
    expect(backupFiles[0]).toContain(
      `schema-v0-to-v${CURRENT_DATABASE_SCHEMA_VERSION}`
    );
    expect(existsSync(path.join(backupsDir, backupFiles[0]!))).toBe(true);
  });

  it("fails safely when the SQLite store advertises a future unsupported schema version", () => {
    const db = new Database(getStoreDatabasePath());
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    db.prepare(`
      INSERT INTO schema_version (version, applied_at)
      VALUES (?, ?)
    `).run(CURRENT_DATABASE_SCHEMA_VERSION + 1, "2026-04-10T10:00:00.000Z");
    db.close();

    expect(() => withClaimGraphDatabase(() => undefined)).toThrow(
      /unsupported future schema version/i
    );
  });
});
