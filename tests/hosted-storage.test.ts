import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  getClaimGraphStorageDriver,
  getClaimGraphStorageSummary
} from "@/lib/server/storage/config";
import {
  persistWorkspaceExportArtifact,
  readWorkspaceFileObject
} from "@/lib/server/object-storage";
import { CLAIMGRAPH_NEON_SCHEMA_SQL } from "@/lib/server/storage/neon-schema";
import { localClaimGraphStore } from "@/lib/server/storage/local-store";
import { normalizeHostedTimestampForColumn } from "@/lib/server/storage/hosted-store";
import { persistWorkspaceFiles } from "@/lib/server/workspace-files";
import { resetStoreForTests } from "@/lib/server/store";

const originalDataDir = process.env.CLAIMGRAPH_DATA_DIR;
const originalStorageDriver = process.env.CLAIMGRAPH_STORAGE_DRIVER;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalBlobReadWriteToken = process.env.BLOB_READ_WRITE_TOKEN;
const testDataDir = path.join(
  process.cwd(),
  "runtime_data",
  "test_state",
  "hosted-storage"
);

function restoreEnv() {
  if (originalDataDir === undefined) {
    delete process.env.CLAIMGRAPH_DATA_DIR;
  } else {
    process.env.CLAIMGRAPH_DATA_DIR = originalDataDir;
  }

  if (originalStorageDriver === undefined) {
    delete process.env.CLAIMGRAPH_STORAGE_DRIVER;
  } else {
    process.env.CLAIMGRAPH_STORAGE_DRIVER = originalStorageDriver;
  }

  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }

  if (originalBlobReadWriteToken === undefined) {
    delete process.env.BLOB_READ_WRITE_TOKEN;
  } else {
    process.env.BLOB_READ_WRITE_TOKEN = originalBlobReadWriteToken;
  }
}

describe("hosted storage boundary", () => {
  beforeEach(() => {
    process.env.CLAIMGRAPH_DATA_DIR = testDataDir;
    delete process.env.CLAIMGRAPH_STORAGE_DRIVER;
    delete process.env.DATABASE_URL;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    rmSync(testDataDir, { recursive: true, force: true });
    resetStoreForTests();
  });

  afterAll(() => {
    rmSync(testDataDir, { recursive: true, force: true });
    resetStoreForTests();
    restoreEnv();
  });

  it("defaults to local storage and refuses hosted mode without DATABASE_URL", () => {
    expect(getClaimGraphStorageDriver()).toBe("local");
    expect(getClaimGraphStorageSummary()).toMatchObject({
      driver: "local",
      databaseConfigured: false,
      localDefault: true
    });

    process.env.CLAIMGRAPH_STORAGE_DRIVER = "hosted";

    expect(() => getClaimGraphStorageDriver()).toThrow(/DATABASE_URL/);

    process.env.DATABASE_URL = "postgres://claimgraph.example/test";

    expect(getClaimGraphStorageDriver()).toBe("hosted");
  });

  it("keeps the checked-in Neon schema aligned with the required hosted tables", () => {
    const schemaFile = readFileSync(
      path.join(process.cwd(), "lib", "server", "storage", "schema", "neon.sql"),
      "utf8"
    );
    const requiredTables = [
      "claimgraph_workspaces",
      "claimgraph_workspace_capabilities",
      "claimgraph_runs",
      "claimgraph_graph_records",
      "claimgraph_sources",
      "claimgraph_snippets",
      "claimgraph_workspace_files",
      "claimgraph_artifact_records",
      "claimgraph_cleanup_jobs"
    ];

    for (const table of requiredTables) {
      expect(CLAIMGRAPH_NEON_SCHEMA_SQL).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(schemaFile).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }

    expect(CLAIMGRAPH_NEON_SCHEMA_SQL).toContain("jsonb");
    expect(schemaFile).not.toContain("NEXT_PUBLIC");
  });

  it("keeps relative web-search date labels out of hosted timestamp columns", () => {
    expect(normalizeHostedTimestampForColumn("2026-06-19")).toBe("2026-06-19T00:00:00.000Z");
    expect(normalizeHostedTimestampForColumn("2026-06-19T05:00:00Z")).toBe(
      "2026-06-19T05:00:00.000Z"
    );
    expect(normalizeHostedTimestampForColumn("last month")).toBeNull();
    expect(normalizeHostedTimestampForColumn("3 weeks ago")).toBeNull();
    expect(normalizeHostedTimestampForColumn("1.6 years ago")).toBeNull();
    expect(normalizeHostedTimestampForColumn(undefined)).toBeNull();
  });

  it("runs the core adapter contract against the existing local store", async () => {
    const workspace = await localClaimGraphStore.createWorkspace(
      "Should cities ban cars downtown?"
    );
    const payload = await localClaimGraphStore.getWorkspaceGraphPayload(workspace.id);

    expect(payload?.workspace.id).toBe(workspace.id);
    expect(payload?.starterMode).toBe(true);
    expect(payload?.graph.question).toBe(workspace.question);
    expect(payload?.sources.length).toBeGreaterThan(0);
    expect(payload?.snippets.length).toBeGreaterThan(0);

    const run = await localClaimGraphStore.createRun(workspace.id);
    const updatedRun = await localClaimGraphStore.updateRunStatus(
      run.id,
      "ingesting",
      "Gathering source material."
    );
    const reloadedRun = await localClaimGraphStore.getRun(run.id);

    expect(updatedRun.status).toBe("ingesting");
    expect(reloadedRun?.status).toBe("ingesting");
    expect(reloadedRun?.statusMessage).toBe("Gathering source material.");
  });

  it("persists source-file bytes and export artifacts through the object storage boundary in local mode", async () => {
    const workspace = await localClaimGraphStore.createWorkspace(
      "Should cities ban cars downtown?"
    );
    const [file] = await persistWorkspaceFiles({
      workspaceId: workspace.id,
      files: [
        new File(["A city mobility memo with grounded tradeoff text."], "memo.txt", {
          type: "text/plain"
        })
      ]
    });

    expect(file.storageProvider).toBe("local");
    expect(file.blobKey).toBeUndefined();
    await expect(readWorkspaceFileObject(file)).resolves.toEqual(
      Buffer.from("A city mobility memo with grounded tradeoff text.")
    );

    const exportArtifact = await persistWorkspaceExportArtifact({
      workspaceId: workspace.id,
      format: "markdown",
      contentType: "text/markdown; charset=utf-8",
      body: "# ClaimGraph export"
    });

    expect(exportArtifact).toMatchObject({
      storageProvider: "local",
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: Buffer.byteLength("# ClaimGraph export")
    });
    expect(exportArtifact.key.endsWith(".md")).toBe(true);
  });
});
