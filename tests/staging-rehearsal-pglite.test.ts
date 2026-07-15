import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPgliteNeonClient } from "./helpers/pglite-neon";

const environmentNames = [
  "CLAIMGRAPH_STORAGE_DRIVER",
  "DATABASE_URL",
  "CLAIMGRAPH_DEPLOYMENT_ROLE",
  "CLAIMGRAPH_PUBLIC_ORIGIN",
  "CLAIMGRAPH_PRODUCTION_ORIGIN",
  "CLAIMGRAPH_STAGING_REHEARSAL_ENABLED",
  "CLAIMGRAPH_STAGING_REHEARSAL_EXPECTED_DATABASE_HOSTNAME",
  "CLAIMGRAPH_STAGING_REHEARSAL_EXPECTED_NEON_PROJECT_ID",
  "CLAIMGRAPH_STAGING_REHEARSAL_EXPECTED_BLOB_STORE_ID",
  "CLAIMGRAPH_STAGING_REHEARSAL_BINDING_SECRET",
  "NEON_PROJECT_ID",
  "BLOB_READ_WRITE_TOKEN",
  "VERCEL_PROJECT_PRODUCTION_URL"
] as const;
const originalEnv = Object.fromEntries(
  environmentNames.map((name) => [name, process.env[name]])
) as Record<(typeof environmentNames)[number], string | undefined>;

function restoreEnvironment() {
  for (const name of environmentNames) {
    const value = originalEnv[name];

    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

function fakeBlobToken(storeId: string) {
  return ["vercel", "blob", "rw", storeId, "test-secret"].join("_");
}

describe("hosted staging rehearsal controls on ephemeral PostgreSQL", () => {
  let database: PGlite;

  beforeEach(async () => {
    vi.resetModules();
    database = new PGlite();
    const schema = readFileSync(
      path.join(
        process.cwd(),
        "lib",
        "server",
        "storage",
        "schema",
        "neon.sql"
      ),
      "utf8"
    );
    await database.exec(schema);
    const client = createPgliteNeonClient(database);
    vi.doMock("@/lib/server/storage/neon-client", () => ({
      getNeonSql: vi.fn(async () => client),
      resetCachedNeonSqlForTests: vi.fn()
    }));
    process.env.CLAIMGRAPH_STORAGE_DRIVER = "hosted";
    process.env.DATABASE_URL =
      "postgresql://staging-rehearsal.invalid/claimgraph";
    process.env.CLAIMGRAPH_STAGING_REHEARSAL_EXPECTED_DATABASE_HOSTNAME =
      "staging-rehearsal.invalid";
    process.env.CLAIMGRAPH_DEPLOYMENT_ROLE = "staging";
    process.env.CLAIMGRAPH_PUBLIC_ORIGIN =
      "https://staging.claimgraph.example";
    process.env.CLAIMGRAPH_PRODUCTION_ORIGIN =
      "https://claim-graph.vercel.app";
    process.env.CLAIMGRAPH_STAGING_REHEARSAL_ENABLED = "1";
    process.env.CLAIMGRAPH_STAGING_REHEARSAL_EXPECTED_NEON_PROJECT_ID =
      "neon-staging-project";
    process.env.NEON_PROJECT_ID = "neon-staging-project";
    process.env.CLAIMGRAPH_STAGING_REHEARSAL_EXPECTED_BLOB_STORE_ID =
      "store_stagingStore123";
    process.env.BLOB_READ_WRITE_TOKEN = fakeBlobToken("stagingStore123");
    process.env.CLAIMGRAPH_STAGING_REHEARSAL_BINDING_SECRET =
      "pglite-staging-binding-secret-at-least-32-bytes";
    process.env.VERCEL_PROJECT_PRODUCTION_URL =
      "staging.claimgraph.example";
  });

  afterEach(async () => {
    vi.doUnmock("@/lib/server/storage/neon-client");
    vi.resetModules();
    await database.close();
    restoreEnvironment();
  });

  async function provisionBinding(secretHash: string) {
    await database.query(
      `
        INSERT INTO claimgraph_staging_rehearsal_bindings (
          id,
          secret_hash,
          created_at
        ) VALUES ($1::text, $2::text, $3::timestamptz)
      `,
      ["staging-rehearsal", secretHash, "2026-07-15T11:59:00.000Z"]
    );
  }

  it("fails closed when the database binding marker is missing", async () => {
    const { getStagingRehearsalAvailability } = await import(
      "@/lib/server/staging-rehearsal"
    );

    await expect(getStagingRehearsalAvailability()).resolves.toMatchObject({
      enabled: false,
      reason: "missing_database_binding"
    });
  });

  it("fails closed when the database binding marker does not match", async () => {
    await provisionBinding("0".repeat(64));
    const { getStagingRehearsalAvailability } = await import(
      "@/lib/server/staging-rehearsal"
    );

    await expect(getStagingRehearsalAvailability()).resolves.toMatchObject({
      enabled: false,
      reason: "database_binding_mismatch"
    });
  });

  it("executes JSONB upsert/release and lets exactly one concurrent fault consumer win", async () => {
    process.env.CLAIMGRAPH_STAGING_REHEARSAL_BINDING_SECRET =
      "  pglite-staging-binding-secret-at-least-32-bytes  ";
    const bindingSecret =
      process.env.CLAIMGRAPH_STAGING_REHEARSAL_BINDING_SECRET!;
    await provisionBinding(
      createHash("sha256").update(bindingSecret, "utf8").digest("hex")
    );
    const {
      activateStagingRehearsalAction,
      consumeStagingRehearsalFault,
      getStagingRehearsalSnapshot,
      releaseStagingRehearsalBarriers
    } = await import("@/lib/server/staging-rehearsal");
    const now = new Date("2026-07-15T12:00:00.000Z");

    await activateStagingRehearsalAction({
      action: "pause_after_evidence_persistence",
      ttlSeconds: 60,
      now
    });
    await activateStagingRehearsalAction({
      action: "pause_after_inventory_persistence",
      ttlSeconds: 60,
      now
    });
    await activateStagingRehearsalAction({
      action: "fail_next_blob_deletion",
      ttlSeconds: 60,
      now
    });

    await expect(getStagingRehearsalSnapshot(now)).resolves.toMatchObject({
      availability: { enabled: true, reason: "ready" },
      actions: {
        pause_after_evidence_persistence: expect.any(String),
        pause_after_inventory_persistence: expect.any(String),
        fail_next_blob_deletion: expect.any(String)
      }
    });
    const persisted = await database.query<{
      evidence_expires_at: string | null;
      inventory_expires_at: string | null;
      fault_expires_at: string | null;
    }>(`
      SELECT
        data ->> 'pause_after_evidence_persistence' AS evidence_expires_at,
        data ->> 'pause_after_inventory_persistence' AS inventory_expires_at,
        data ->> 'fail_next_blob_deletion' AS fault_expires_at
      FROM claimgraph_operator_controls
      WHERE id = 'staging-rehearsal'
    `);
    expect(persisted.rows[0]).toMatchObject({
      evidence_expires_at: expect.any(String),
      inventory_expires_at: expect.any(String),
      fault_expires_at: expect.any(String)
    });

    await releaseStagingRehearsalBarriers(
      new Date(now.getTime() + 1_000)
    );
    const released = await database.query<{
      evidence_active: boolean;
      inventory_active: boolean;
      fault_active: boolean;
    }>(`
      SELECT
        data ? 'pause_after_evidence_persistence' AS evidence_active,
        data ? 'pause_after_inventory_persistence' AS inventory_active,
        data ? 'fail_next_blob_deletion' AS fault_active
      FROM claimgraph_operator_controls
      WHERE id = 'staging-rehearsal'
    `);
    expect(released.rows).toEqual([{
      evidence_active: false,
      inventory_active: false,
      fault_active: true
    }]);

    const consumeAt = new Date(now.getTime() + 2_000);
    const consumers = await Promise.all([
      consumeStagingRehearsalFault("fail_next_blob_deletion", consumeAt),
      consumeStagingRehearsalFault("fail_next_blob_deletion", consumeAt)
    ]);
    expect(consumers.filter(Boolean)).toHaveLength(1);
    expect(consumers.filter((value) => !value)).toHaveLength(1);

    const consumed = await database.query<{ fault_active: boolean }>(`
      SELECT data ? 'fail_next_blob_deletion' AS fault_active
      FROM claimgraph_operator_controls
      WHERE id = 'staging-rehearsal'
    `);
    expect(consumed.rows).toEqual([{ fault_active: false }]);
  });
});
