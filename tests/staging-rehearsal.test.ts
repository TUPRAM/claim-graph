import { rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  GET as getStagingRehearsal,
  PUT as updateStagingRehearsal
} from "@/app/api/dev/staging-rehearsal/route";
import { withClaimGraphDatabase } from "@/lib/server/database";
import {
  getStagingRehearsalAvailability,
  parseBlobStoreIdFromReadWriteToken
} from "@/lib/server/staging-rehearsal";
import { resetStoreForTests } from "@/lib/server/store";
import {
  resetDevAuthForTest,
  withDevSession
} from "./helpers/dev-auth";

const testDataDir = path.join(
  process.cwd(),
  "runtime_data",
  "test_state",
  "staging-rehearsal"
);
const environmentNames = [
  "CLAIMGRAPH_DATA_DIR",
  "CLAIMGRAPH_STORAGE_DRIVER",
  "CLAIMGRAPH_DEPLOYMENT_ROLE",
  "CLAIMGRAPH_PUBLIC_ORIGIN",
  "CLAIMGRAPH_PRODUCTION_ORIGIN",
  "CLAIMGRAPH_STAGING_REHEARSAL_ENABLED",
  "CLAIMGRAPH_STAGING_REHEARSAL_EXPECTED_DATABASE_HOSTNAME",
  "CLAIMGRAPH_STAGING_REHEARSAL_EXPECTED_NEON_PROJECT_ID",
  "CLAIMGRAPH_STAGING_REHEARSAL_EXPECTED_BLOB_STORE_ID",
  "CLAIMGRAPH_STAGING_REHEARSAL_BINDING_SECRET",
  "DATABASE_URL",
  "NEON_PROJECT_ID",
  "BLOB_READ_WRITE_TOKEN",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "DEV_MODE_PASSWORD_HASH",
  "DEV_MODE_SESSION_SECRET"
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

function fakeBlobToken(storeId: string, suffix = "test-secret") {
  return ["vercel", "blob", "rw", storeId, suffix].join("_");
}

function configureStaging() {
  process.env.CLAIMGRAPH_STORAGE_DRIVER = "hosted";
  process.env.DATABASE_URL =
    "postgresql://staging-db.example/claimgraph";
  process.env.CLAIMGRAPH_DEPLOYMENT_ROLE = "staging";
  process.env.CLAIMGRAPH_PUBLIC_ORIGIN = "https://staging.claimgraph.example";
  process.env.CLAIMGRAPH_PRODUCTION_ORIGIN = "https://claim-graph.vercel.app";
  process.env.CLAIMGRAPH_STAGING_REHEARSAL_ENABLED = "1";
  process.env.CLAIMGRAPH_STAGING_REHEARSAL_EXPECTED_DATABASE_HOSTNAME =
    "staging-db.example";
  process.env.CLAIMGRAPH_STAGING_REHEARSAL_EXPECTED_NEON_PROJECT_ID =
    "neon-staging-project";
  process.env.NEON_PROJECT_ID = "neon-staging-project";
  process.env.CLAIMGRAPH_STAGING_REHEARSAL_EXPECTED_BLOB_STORE_ID =
    "store_stagingStore123";
  process.env.BLOB_READ_WRITE_TOKEN = fakeBlobToken("stagingStore123");
  process.env.CLAIMGRAPH_STAGING_REHEARSAL_BINDING_SECRET =
    "staging-rehearsal-binding-secret-32-bytes";
  process.env.VERCEL_PROJECT_PRODUCTION_URL = "staging.claimgraph.example";
}

function rehearsalRequest(body: unknown) {
  return withDevSession(
    new Request("https://staging.claimgraph.example/api/dev/staging-rehearsal", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://staging.claimgraph.example"
      },
      body: JSON.stringify(body)
    })
  );
}

describe("staging rehearsal controls", () => {
  beforeEach(() => {
    restoreEnvironment();
    process.env.CLAIMGRAPH_DATA_DIR = testDataDir;
    process.env.CLAIMGRAPH_STORAGE_DRIVER = "local";
    delete process.env.CLAIMGRAPH_DEPLOYMENT_ROLE;
    delete process.env.CLAIMGRAPH_PUBLIC_ORIGIN;
    delete process.env.CLAIMGRAPH_PRODUCTION_ORIGIN;
    delete process.env.CLAIMGRAPH_STAGING_REHEARSAL_ENABLED;
    delete process.env.CLAIMGRAPH_STAGING_REHEARSAL_EXPECTED_DATABASE_HOSTNAME;
    delete process.env.CLAIMGRAPH_STAGING_REHEARSAL_EXPECTED_NEON_PROJECT_ID;
    delete process.env.CLAIMGRAPH_STAGING_REHEARSAL_EXPECTED_BLOB_STORE_ID;
    delete process.env.CLAIMGRAPH_STAGING_REHEARSAL_BINDING_SECRET;
    delete process.env.DATABASE_URL;
    delete process.env.NEON_PROJECT_ID;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    rmSync(testDataDir, { recursive: true, force: true });
    resetStoreForTests();
    resetDevAuthForTest({
      passwordHash: originalEnv.DEV_MODE_PASSWORD_HASH,
      sessionSecret: originalEnv.DEV_MODE_SESSION_SECRET
    });
  });

  afterAll(() => {
    rmSync(testDataDir, { recursive: true, force: true });
    resetStoreForTests();
    restoreEnvironment();
  });

  it("is disabled by default and requires the existing developer session", async () => {
    await expect(getStagingRehearsalAvailability()).resolves.toMatchObject({
      enabled: false,
      reason: "disabled"
    });

    const response = await getStagingRehearsal(
      new Request("https://staging.claimgraph.example/api/dev/staging-rehearsal")
    );
    expect(response.status).toBe(401);
  });

  it("refuses activation on the public production origin even with a staging role", async () => {
    process.env.CLAIMGRAPH_DEPLOYMENT_ROLE = "staging";
    process.env.CLAIMGRAPH_PUBLIC_ORIGIN = "https://claim-graph.vercel.app";
    process.env.CLAIMGRAPH_PRODUCTION_ORIGIN = "https://claim-graph.vercel.app";
    process.env.CLAIMGRAPH_STAGING_REHEARSAL_ENABLED = "1";

    await expect(getStagingRehearsalAvailability()).resolves.toMatchObject({
      enabled: false,
      reason: "production_origin"
    });

    const response = await updateStagingRehearsal(
      withDevSession(
        new Request("https://claim-graph.vercel.app/api/dev/staging-rehearsal", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://claim-graph.vercel.app"
          },
          body: JSON.stringify({
            action: "pause_after_evidence_persistence",
            ttlSeconds: 30
          })
        })
      )
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      reason: "production_origin"
    });
    const persisted = withClaimGraphDatabase((db) =>
      db.prepare(
        "SELECT count(*) AS count FROM public_beta_operator_controls WHERE id = ?"
      ).get("staging-rehearsal") as { count: number }
    );
    expect(persisted.count).toBe(0);
  });

  it("requires the explicit staging role and rejects arbitrary action fields", async () => {
    process.env.CLAIMGRAPH_DEPLOYMENT_ROLE = "production";
    process.env.CLAIMGRAPH_PUBLIC_ORIGIN = "https://staging.claimgraph.example";
    process.env.CLAIMGRAPH_STAGING_REHEARSAL_ENABLED = "1";

    const wrongRole = await updateStagingRehearsal(
      rehearsalRequest({
        action: "pause_after_evidence_persistence",
        ttlSeconds: 30
      })
    );
    expect(wrongRole.status).toBe(403);
    await expect(wrongRole.json()).resolves.toMatchObject({ reason: "not_staging" });

    configureStaging();
    const arbitrary = await updateStagingRehearsal(
      rehearsalRequest({ action: "execute_sql", sql: "select 1" })
    );
    const extraPath = await updateStagingRehearsal(
      rehearsalRequest({
        action: "fail_next_blob_deletion",
        ttlSeconds: 30,
        path: "workspaces/arbitrary"
      })
    );

    expect(arbitrary.status).toBe(400);
    expect(extraPath.status).toBe(400);
  });

  it("requires hosted storage and the exact declared database hostname", async () => {
    configureStaging();
    process.env.CLAIMGRAPH_STORAGE_DRIVER = "local";
    await expect(getStagingRehearsalAvailability()).resolves.toMatchObject({
      enabled: false,
      reason: "not_hosted_storage"
    });

    configureStaging();
    process.env.CLAIMGRAPH_STAGING_REHEARSAL_EXPECTED_DATABASE_HOSTNAME =
      "production-db.example";
    await expect(getStagingRehearsalAvailability()).resolves.toMatchObject({
      enabled: false,
      reason: "database_hostname_mismatch"
    });

    configureStaging();
    process.env.DATABASE_URL = "https://staging-db.example/claimgraph";
    await expect(getStagingRehearsalAvailability()).resolves.toMatchObject({
      enabled: false,
      reason: "invalid_database_url"
    });
  });

  it("fails closed when the declared and runtime Neon resource identities are missing or shared", async () => {
    configureStaging();
    delete process.env.CLAIMGRAPH_STAGING_REHEARSAL_EXPECTED_NEON_PROJECT_ID;
    await expect(getStagingRehearsalAvailability()).resolves.toMatchObject({
      enabled: false,
      reason: "missing_expected_neon_project_id"
    });

    configureStaging();
    delete process.env.NEON_PROJECT_ID;
    await expect(getStagingRehearsalAvailability()).resolves.toMatchObject({
      enabled: false,
      reason: "missing_runtime_neon_project_id"
    });

    configureStaging();
    process.env.NEON_PROJECT_ID = "neon-production-project";
    await expect(getStagingRehearsalAvailability()).resolves.toMatchObject({
      enabled: false,
      reason: "neon_project_mismatch"
    });
  });

  it("parses the Blob token store without exposing its secret and rejects shared stores", async () => {
    expect(
      parseBlobStoreIdFromReadWriteToken(
        fakeBlobToken("stagingStore123", "secret_with_segments")
      )
    ).toBe("stagingStore123");
    expect(parseBlobStoreIdFromReadWriteToken("invalid-token")).toBeNull();

    configureStaging();
    delete process.env.CLAIMGRAPH_STAGING_REHEARSAL_EXPECTED_BLOB_STORE_ID;
    await expect(getStagingRehearsalAvailability()).resolves.toMatchObject({
      enabled: false,
      reason: "missing_expected_blob_store_id"
    });

    configureStaging();
    delete process.env.BLOB_READ_WRITE_TOKEN;
    await expect(getStagingRehearsalAvailability()).resolves.toMatchObject({
      enabled: false,
      reason: "invalid_blob_read_write_token"
    });

    configureStaging();
    process.env.BLOB_READ_WRITE_TOKEN = fakeBlobToken("productionStore456");
    await expect(getStagingRehearsalAvailability()).resolves.toMatchObject({
      enabled: false,
      reason: "blob_store_mismatch"
    });
  });

  it("requires Vercel's project production host to match the canonical staging origin", async () => {
    configureStaging();
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "claim-graph.vercel.app";
    await expect(getStagingRehearsalAvailability()).resolves.toMatchObject({
      enabled: false,
      reason: "vercel_origin_mismatch"
    });

    process.env.VERCEL_PROJECT_PRODUCTION_URL = "https://user@example.com/path";
    await expect(getStagingRehearsalAvailability()).resolves.toMatchObject({
      enabled: false,
      reason: "invalid_vercel_project_production_url"
    });

  });
});
