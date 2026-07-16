import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPgliteNeonClient } from "./helpers/pglite-neon";

const originalDriver = process.env.CLAIMGRAPH_STORAGE_DRIVER;
const originalDatabaseUrl = process.env.DATABASE_URL;

describe("hosted operations ledger on ephemeral PostgreSQL", () => {
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
    process.env.DATABASE_URL = "postgresql://operations.invalid/claimgraph";
  });

  afterEach(async () => {
    vi.doUnmock("@/lib/server/storage/neon-client");
    vi.resetModules();
    await database.close();
    if (originalDriver === undefined) {
      delete process.env.CLAIMGRAPH_STORAGE_DRIVER;
    } else {
      process.env.CLAIMGRAPH_STORAGE_DRIVER = originalDriver;
    }
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it("upserts aggregate events and persists notification state without raw subjects", async () => {
    const {
      getOperationalEventSummary,
      getOperationalNotificationState,
      recordOperationalEvent,
      saveOperationalNotificationState
    } = await import("@/lib/server/operational-events");
    const firstAt = new Date("2026-07-16T09:05:00.000Z");
    const secondAt = new Date("2026-07-16T09:45:00.000Z");

    await recordOperationalEvent({
      eventType: "analysis-limit-429",
      now: firstAt
    });
    await recordOperationalEvent({
      eventType: "analysis-limit-429",
      now: secondAt
    });
    await saveOperationalNotificationState({
      lastStatus: "warning",
      lastFingerprint: "aggregate-alert-fingerprint",
      lastAttemptAt: secondAt.toISOString(),
      lastSuccessAt: secondAt.toISOString(),
      lastFailureAt: null,
      lastFailureCode: null
    });

    await expect(getOperationalEventSummary({
      since: new Date("2026-07-16T09:00:00.000Z"),
      now: new Date("2026-07-16T10:00:00.000Z")
    })).resolves.toEqual([{
      eventType: "analysis-limit-429",
      occurrenceCount: 2,
      valueTotal: 0,
      lastSeenAt: secondAt.toISOString()
    }]);
    await expect(getOperationalNotificationState()).resolves.toMatchObject({
      lastStatus: "warning",
      lastFingerprint: "aggregate-alert-fingerprint",
      lastSuccessAt: secondAt.toISOString()
    });

    const eventColumns = await database.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'claimgraph_operational_event_buckets'
      ORDER BY ordinal_position
    `);
    expect(eventColumns.rows.map((row) => row.column_name)).toEqual([
      "event_type",
      "window_started_at",
      "occurrence_count",
      "value_total",
      "last_seen_at",
      "expires_at"
    ]);
  });

  it("records hosted kill-switch changes and enforces a notification lease", async () => {
    const {
      claimOperationalNotificationDelivery,
      getOperationalEventSummary,
      releaseOperationalNotificationDelivery
    } = await import("@/lib/server/operational-events");
    const { updatePublicBetaOperatorOverrides } = await import(
      "@/lib/server/public-beta-control-store"
    );
    const disabled = await updatePublicBetaOperatorOverrides({
      analysisEnabled: false
    });
    const enabled = await updatePublicBetaOperatorOverrides({
      analysisEnabled: true
    });

    expect(disabled.analysisEnabled).toBe(false);
    expect(enabled.analysisEnabled).toBe(true);
    await expect(getOperationalEventSummary()).resolves.toEqual([{
      eventType: "kill-switch-changed",
      occurrenceCount: 2,
      valueTotal: 1,
      lastSeenAt: enabled.updatedAt
    }]);

    const now = new Date("2026-07-16T10:00:00.000Z");
    await expect(claimOperationalNotificationDelivery({
      leaseId: "lease-one",
      now,
      leaseMs: 30_000
    })).resolves.toMatchObject({ lastStatus: "ready" });
    await expect(claimOperationalNotificationDelivery({
      leaseId: "lease-two",
      now,
      leaseMs: 30_000
    })).resolves.toBeNull();
    await expect(releaseOperationalNotificationDelivery("lease-one"))
      .resolves.toBe(true);
    await expect(claimOperationalNotificationDelivery({
      leaseId: "lease-two",
      now,
      leaseMs: 30_000
    })).resolves.toMatchObject({ lastStatus: "ready" });
  });
});
