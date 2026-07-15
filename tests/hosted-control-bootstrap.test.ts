import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPgliteNeonClient } from "./helpers/pglite-neon";

const originalDriver = process.env.CLAIMGRAPH_STORAGE_DRIVER;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalAbuseSecret = process.env.CLAIMGRAPH_ABUSE_HASH_SECRET;

describe("hosted public-beta control bootstrap", () => {
  let database: PGlite;

  beforeEach(async () => {
    vi.resetModules();
    database = new PGlite();
    const client = createPgliteNeonClient(database);
    vi.doMock("@/lib/server/storage/neon-client", () => ({
      getNeonSql: vi.fn(async () => client),
      resetCachedNeonSqlForTests: vi.fn()
    }));
    process.env.CLAIMGRAPH_STORAGE_DRIVER = "hosted";
    process.env.DATABASE_URL = "postgresql://bootstrap.invalid/claimgraph";
    process.env.CLAIMGRAPH_ABUSE_HASH_SECRET = "hosted-bootstrap-secret-32-bytes";
  });

  afterEach(async () => {
    vi.doUnmock("@/lib/server/storage/neon-client");
    vi.resetModules();
    await database.close();

    if (originalDriver === undefined) delete process.env.CLAIMGRAPH_STORAGE_DRIVER;
    else process.env.CLAIMGRAPH_STORAGE_DRIVER = originalDriver;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalAbuseSecret === undefined) delete process.env.CLAIMGRAPH_ABUSE_HASH_SECRET;
    else process.env.CLAIMGRAPH_ABUSE_HASH_SECRET = originalAbuseSecret;
  });

  it("initializes control and cleanup tables before the first hosted rate check", async () => {
    const {
      acquireProviderLease,
      consumePublicBetaRateLimit,
      releaseProviderLease
    } = await import(
      "@/lib/server/public-beta-control-store"
    );
    const decision = await consumePublicBetaRateLimit({
      scope: "workspace-create",
      subject: "203.0.113.10",
      limit: 2,
      windowMs: 60_000,
      now: new Date("2026-07-12T00:00:00.000Z")
    });

    expect(decision.allowed).toBe(true);
    const tables = await database.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_name IN (
        'claimgraph_rate_limit_buckets',
        'claimgraph_idempotency_keys',
        'claimgraph_operator_controls',
        'claimgraph_provider_leases',
        'claimgraph_cleanup_jobs'
      )
      ORDER BY table_name
    `);
    expect(tables.rows.map((row) => row.table_name)).toHaveLength(5);

    const { getCleanupBacklogSummary } = await import(
      "@/lib/server/retention-cleanup"
    );
    await expect(getCleanupBacklogSummary()).resolves.toMatchObject({
      dueCount: 0,
      failedCount: 0,
      deadCount: 0
    });

    const firstLease = await acquireProviderLease({ runId: "same-run", limit: 2 });
    const secondLease = await acquireProviderLease({ runId: "same-run", limit: 2 });
    const blockedLease = await acquireProviderLease({ runId: "other-run", limit: 2 });
    expect(firstLease.acquired).toBe(true);
    expect(secondLease.acquired).toBe(true);
    expect(firstLease.lease?.id).not.toBe(secondLease.lease?.id);
    expect(blockedLease.acquired).toBe(false);
    await releaseProviderLease(firstLease.lease!.id);
  });

  it("retries hosted schema initialization after a transient failure", async () => {
    const client = createPgliteNeonClient(database);
    const getNeonSql = vi.fn()
      .mockRejectedValueOnce(new Error("transient Neon connection failure"))
      .mockResolvedValue(client);

    const {
      ensureHostedStorageSchema,
      resetHostedStorageSchemaForTests
    } = await import(
      "@/lib/server/storage/hosted-schema"
    );
    resetHostedStorageSchemaForTests();

    await expect(
      ensureHostedStorageSchema(process.env, getNeonSql)
    ).rejects.toThrow(
      /transient Neon connection failure/
    );
    await expect(
      ensureHostedStorageSchema(process.env, getNeonSql)
    ).resolves.toBeUndefined();
    expect(getNeonSql).toHaveBeenCalledTimes(2);
  });
});
