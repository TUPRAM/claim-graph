import { rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getOperationsMonitor } from "@/app/api/internal/monitor/route";
import { GET as runNotificationTick } from "@/app/api/internal/notify/route";
import { withClaimGraphDatabase } from "@/lib/server/database";
import {
  getOperationalEventSummary,
  getOperationalNotificationState,
  recordOperationalEvent,
  saveOperationalNotificationState
} from "@/lib/server/operational-events";
import {
  deliverOperationsNotification,
  getOperationsMonitorSnapshot,
  type OperationsMonitorSnapshot
} from "@/lib/server/operations-monitor";

const testDataDir = path.join(
  process.cwd(),
  "runtime_data",
  "test_state",
  "operations-monitor"
);

const ENV_KEYS = [
  "CLAIMGRAPH_DATA_DIR",
  "CLAIMGRAPH_STORAGE_DRIVER",
  "DATABASE_URL",
  "CRON_SECRET",
  "CLAIMGRAPH_MONITOR_SECRET",
  "CLAIMGRAPH_OPERATIONS_WEBHOOK_FORMAT",
  "CLAIMGRAPH_OPERATIONS_WEBHOOK_URL",
  "CLAIMGRAPH_OPERATIONS_WEBHOOK_BEARER_TOKEN",
  "CLAIMGRAPH_OPERATIONS_WEBHOOK_TIMEOUT_MS",
  "CLAIMGRAPH_OPERATIONS_NOTIFICATION_COOLDOWN_MINUTES",
  "CLAIMGRAPH_OPERATIONAL_EVENT_TTL_DAYS",
  "CLAIMGRAPH_CLEANUP_HEARTBEAT_MAX_HOURS"
] as const;

const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]])
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

function restoreEnv() {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function snapshot(input: {
  checkedAt: string;
  status: "ready" | "warning" | "critical";
  alertCode?: string;
}): OperationsMonitorSnapshot {
  return {
    schemaVersion: 1,
    checkedAt: input.checkedAt,
    status: input.status,
    health: { status: input.status === "critical" ? "unhealthy" : "ready" },
    cleanup: {
      dueCount: 0,
      failedCount: 0,
      deadCount: 0,
      oldestDueAt: null,
      heartbeatAt: input.checkedAt,
      heartbeatAgeSeconds: 0
    },
    provider: {
      analysisEnabled: true,
      activeLeases: 0,
      limit: 2,
      available: true
    },
    events: {
      windowHours: 24,
      aggregates: []
    },
    notification: {
      configured: true,
      bearerConfigured: true,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureCode: null
    },
    alerts: input.alertCode
      ? [{
          code: input.alertCode,
          severity: input.status === "critical" ? "critical" : "warning",
          message: "Operator action is required."
        }]
      : []
  };
}

describe("privacy-minimal operations monitoring", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    restoreEnv();
    rmSync(testDataDir, { recursive: true, force: true });
    process.env.CLAIMGRAPH_DATA_DIR = testDataDir;
    process.env.CLAIMGRAPH_STORAGE_DRIVER = "local";
    delete process.env.DATABASE_URL;
    delete process.env.CLAIMGRAPH_OPERATIONS_WEBHOOK_FORMAT;
    delete process.env.CLAIMGRAPH_OPERATIONS_WEBHOOK_URL;
    delete process.env.CLAIMGRAPH_OPERATIONS_WEBHOOK_BEARER_TOKEN;
  });

  afterAll(() => {
    rmSync(testDataDir, { recursive: true, force: true });
    restoreEnv();
  });

  it("stores only hourly aggregate categories and bounded numeric values", async () => {
    const first = new Date("2026-07-16T04:05:00.000Z");
    const second = new Date("2026-07-16T04:45:00.000Z");

    await recordOperationalEvent({
      eventType: "export-completed",
      value: 1_250,
      now: first
    });
    await recordOperationalEvent({
      eventType: "export-completed",
      value: 2_750,
      now: second
    });
    await recordOperationalEvent({
      eventType: "workspace-creation-429",
      now: second
    });

    const summary = await getOperationalEventSummary({
      since: new Date("2026-07-16T00:00:00.000Z"),
      now: new Date("2026-07-16T05:00:00.000Z")
    });

    expect(summary).toEqual([
      {
        eventType: "export-completed",
        occurrenceCount: 2,
        valueTotal: 4_000,
        lastSeenAt: second.toISOString()
      },
      {
        eventType: "workspace-creation-429",
        occurrenceCount: 1,
        valueTotal: 0,
        lastSeenAt: second.toISOString()
      }
    ]);

    const columns = withClaimGraphDatabase((db) =>
      db.prepare("PRAGMA table_info(operational_event_buckets)").all() as Array<{
        name: string;
      }>
    );
    expect(columns.map((column) => column.name)).toEqual([
      "event_type",
      "window_started_at",
      "occurrence_count",
      "value_total",
      "last_seen_at",
      "expires_at"
    ]);
    expect(JSON.stringify(summary)).not.toContain("workspaceId");
    expect(JSON.stringify(summary)).not.toContain("ipAddress");
  });

  it("reports heartbeat age without exposing cleanup job or workspace identities", async () => {
    const now = new Date("2026-07-16T06:00:00.000Z");
    const beforeHeartbeat = await getOperationsMonitorSnapshot(now);

    expect(beforeHeartbeat.alerts.map((alert) => alert.code)).toContain(
      "cleanup-heartbeat-missing"
    );

    await recordOperationalEvent({
      eventType: "cleanup-heartbeat",
      value: 3,
      now
    });
    const afterHeartbeat = await getOperationsMonitorSnapshot(
      new Date(now.getTime() + 45_000)
    );

    expect(afterHeartbeat.cleanup).toMatchObject({
      heartbeatAt: now.toISOString(),
      heartbeatAgeSeconds: 45
    });
    expect(afterHeartbeat.alerts.map((alert) => alert.code)).not.toContain(
      "cleanup-heartbeat-missing"
    );
    expect(JSON.stringify(afterHeartbeat)).not.toContain("workspaceId");
    expect(JSON.stringify(afterHeartbeat)).not.toContain("jobId");
  });

  it("turns recent paid, capacity, and notification failures into monitor alerts", async () => {
    process.env.CLAIMGRAPH_OPERATIONS_WEBHOOK_URL =
      "https://operations.example.test/claimgraph";
    const now = new Date("2026-07-16T06:30:00.000Z");
    await recordOperationalEvent({ eventType: "cleanup-heartbeat", now });
    await recordOperationalEvent({
      eventType: "paid-analysis-ceiling-refusal",
      now
    });
    await recordOperationalEvent({ eventType: "provider-capacity-refusal", now });
    await recordOperationalEvent({ eventType: "notification-failed", now });

    const failed = await getOperationsMonitorSnapshot(
      new Date(now.getTime() + 60_000)
    );
    expect(failed.alerts.map((alert) => alert.code)).toEqual(
      expect.arrayContaining([
        "paid-analysis-ceiling-exhausted",
        "provider-capacity-refusals",
        "operations-notification-failed"
      ])
    );

    await recordOperationalEvent({
      eventType: "notification-delivered",
      now: new Date(now.getTime() + 2 * 60_000)
    });
    const recovered = await getOperationsMonitorSnapshot(
      new Date(now.getTime() + 3 * 60_000)
    );
    expect(recovered.alerts.map((alert) => alert.code)).not.toContain(
      "operations-notification-failed"
    );
  });

  it("uses the dedicated monitor bearer and refuses the cleanup bearer", async () => {
    process.env.CRON_SECRET = "cleanup-secret-with-at-least-thirty-two-bytes";
    process.env.CLAIMGRAPH_MONITOR_SECRET =
      "monitor-secret-with-at-least-thirty-two-bytes";
    process.env.CLAIMGRAPH_OPERATIONS_WEBHOOK_BEARER_TOKEN =
      "SECRET_WEBHOOK_CANARY_MUST_NOT_LEAK";

    const unauthorized = await getOperationsMonitor(
      new Request("http://localhost/api/internal/monitor")
    );
    const cleanupBearer = await getOperationsMonitor(
      new Request("http://localhost/api/internal/monitor", {
        headers: {
          Authorization: `Bearer ${process.env.CRON_SECRET}`
        }
      })
    );
    const authorized = await getOperationsMonitor(
      new Request("http://localhost/api/internal/monitor", {
        headers: {
          Authorization: `Bearer ${process.env.CLAIMGRAPH_MONITOR_SECRET}`
        }
      })
    );

    expect(unauthorized.status).toBe(401);
    expect(cleanupBearer.status).toBe(401);
    expect(authorized.status).toBe(200);
    expect(authorized.headers.get("Cache-Control")).toBe("no-store");
    const payload = await authorized.json();
    expect(payload).toMatchObject({
      schemaVersion: 1,
      status: "warning",
      events: { windowHours: 24 }
    });
    expect(JSON.stringify(payload)).not.toContain(
      "SECRET_WEBHOOK_CANARY_MUST_NOT_LEAK"
    );

    process.env.CLAIMGRAPH_CLEANUP_HEARTBEAT_MAX_HOURS = "1";
    await recordOperationalEvent({
      eventType: "cleanup-heartbeat",
      now: new Date(Date.now() - 3 * 60 * 60_000)
    });
    const critical = await getOperationsMonitor(
      new Request("http://localhost/api/internal/monitor", {
        headers: {
          Authorization: `Bearer ${process.env.CLAIMGRAPH_MONITOR_SECRET}`
        }
      })
    );
    expect(critical.status).toBe(503);

    process.env.CLAIMGRAPH_MONITOR_SECRET = process.env.CRON_SECRET;
    const sharedSecret = await getOperationsMonitor(
      new Request("http://localhost/api/internal/monitor", {
        headers: {
          Authorization: `Bearer ${process.env.CRON_SECRET}`
        }
      })
    );
    expect(sharedSecret.status).toBe(401);
  });

  it("runs notification delivery independently and alerts on a stale cleanup heartbeat", async () => {
    process.env.CRON_SECRET = "cleanup-secret-with-at-least-thirty-two-bytes";
    process.env.CLAIMGRAPH_OPERATIONS_WEBHOOK_URL =
      "https://operations.example.test/claimgraph";
    process.env.CLAIMGRAPH_CLEANUP_HEARTBEAT_MAX_HOURS = "1";
    await recordOperationalEvent({
      eventType: "cleanup-heartbeat",
      now: new Date(Date.now() - 3 * 60 * 60_000)
    });
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit
    ) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchImpl);

    const unauthorized = await runNotificationTick(
      new Request("http://localhost/api/internal/notify")
    );
    const delivered = await runNotificationTick(
      new Request("http://localhost/api/internal/notify", {
        headers: {
          Authorization: `Bearer ${process.env.CRON_SECRET}`
        }
      })
    );

    expect(unauthorized.status).toBe(401);
    expect(delivered.status).toBe(200);
    expect(delivered.headers.get("Cache-Control")).toBe("no-store");
    await expect(delivered.json()).resolves.toEqual({
      notification: { kind: "delivered" }
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, request] = fetchImpl.mock.calls[0]!;
    const payload = JSON.parse(String(request?.body));
    expect(payload.alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "cleanup-heartbeat-critical" })
    ]));
  });

  it("returns a retryable status when the independent notification tick fails", async () => {
    process.env.CRON_SECRET = "cleanup-secret-with-at-least-thirty-two-bytes";
    process.env.CLAIMGRAPH_OPERATIONS_WEBHOOK_URL =
      "https://operations.example.test/claimgraph";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));

    const response = await runNotificationTick(
      new Request("http://localhost/api/internal/notify", {
        headers: {
          Authorization: `Bearer ${process.env.CRON_SECRET}`
        }
      })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      notification: { kind: "failed", failureCode: "http_503" }
    });
  });

  it("delivers changed alerts and one recovery while suppressing duplicates", async () => {
    process.env.CLAIMGRAPH_OPERATIONS_WEBHOOK_URL =
      "https://operations.example.test/claimgraph";
    process.env.CLAIMGRAPH_OPERATIONS_WEBHOOK_BEARER_TOKEN =
      "private-webhook-bearer";
    process.env.CLAIMGRAPH_OPERATIONS_NOTIFICATION_COOLDOWN_MINUTES = "60";
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit
    ) => new Response(null, { status: 204 }));
    const firstAt = new Date("2026-07-16T07:00:00.000Z");
    const firstSnapshot = snapshot({
      checkedAt: firstAt.toISOString(),
      status: "warning",
      alertCode: "cleanup-backlog-due"
    });

    await expect(deliverOperationsNotification({
      now: firstAt,
      snapshot: firstSnapshot,
      fetchImpl: fetchImpl as unknown as typeof fetch
    })).resolves.toEqual({ kind: "delivered" });
    await expect(deliverOperationsNotification({
      now: new Date(firstAt.getTime() + 60_000),
      snapshot: firstSnapshot,
      fetchImpl: fetchImpl as unknown as typeof fetch
    })).resolves.toEqual({ kind: "skipped" });

    const changedAt = new Date(firstAt.getTime() + 2 * 60_000);
    await expect(deliverOperationsNotification({
      now: changedAt,
      snapshot: snapshot({
        checkedAt: changedAt.toISOString(),
        status: "critical",
        alertCode: "cleanup-jobs-dead"
      }),
      fetchImpl: fetchImpl as unknown as typeof fetch
    })).resolves.toEqual({ kind: "delivered" });

    const recoveryAt = new Date(firstAt.getTime() + 3 * 60_000);
    await expect(deliverOperationsNotification({
      now: recoveryAt,
      snapshot: snapshot({
        checkedAt: recoveryAt.toISOString(),
        status: "ready"
      }),
      fetchImpl: fetchImpl as unknown as typeof fetch
    })).resolves.toEqual({ kind: "delivered" });
    await expect(deliverOperationsNotification({
      now: new Date(firstAt.getTime() + 10 * 60_000),
      snapshot: snapshot({
        checkedAt: new Date(firstAt.getTime() + 10 * 60_000).toISOString(),
        status: "ready"
      }),
      fetchImpl: fetchImpl as unknown as typeof fetch
    })).resolves.toEqual({ kind: "skipped" });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const [, request] = fetchImpl.mock.calls[0]!;
    expect(request).toMatchObject({
      method: "POST",
      cache: "no-store",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer private-webhook-bearer"
      }
    });
    const firstPayload = JSON.parse(String(request?.body));
    expect(firstPayload).toMatchObject({
      schemaVersion: 1,
      kind: "alert",
      status: "warning"
    });
    expect(firstPayload).not.toHaveProperty("notification");
    expect(firstPayload).not.toHaveProperty("workspaceId");
  });

  it("creates a bounded private GitHub issue from only the aggregate payload", async () => {
    process.env.CLAIMGRAPH_OPERATIONS_WEBHOOK_FORMAT = "github-issue";
    process.env.CLAIMGRAPH_OPERATIONS_WEBHOOK_URL =
      "https://api.github.com/repos/example/private-operations/issues";
    process.env.CLAIMGRAPH_OPERATIONS_WEBHOOK_BEARER_TOKEN =
      "SECRET_GITHUB_TOKEN_CANARY_MUST_NOT_LEAK";
    const now = new Date("2026-07-16T07:20:00.000Z");
    const alert = snapshot({
      checkedAt: now.toISOString(),
      status: "critical",
      alertCode: "cleanup-jobs-dead"
    });
    alert.notification.lastFailureCode =
      "SECRET_NOTIFICATION_CANARY_MUST_NOT_LEAK";
    const snapshotWithFutureSecret = {
      ...alert,
      futureInternalSecret: "SECRET_FUTURE_CANARY_MUST_NOT_LEAK",
      workspaceId: "workspace-secret-canary",
      runId: "run-secret-canary"
    } as OperationsMonitorSnapshot;
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit
    ) => new Response(null, { status: 201 }));

    await expect(deliverOperationsNotification({
      now,
      snapshot: snapshotWithFutureSecret,
      fetchImpl: fetchImpl as unknown as typeof fetch
    })).resolves.toEqual({ kind: "delivered" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, request] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(
      "https://api.github.com/repos/example/private-operations/issues"
    );
    expect(request).toMatchObject({
      method: "POST",
      cache: "no-store",
      redirect: "error",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer SECRET_GITHUB_TOKEN_CANARY_MUST_NOT_LEAK",
        "Content-Type": "application/json",
        "User-Agent": "ClaimGraph-Operations-Notifier/1.0",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });

    const issue = JSON.parse(String(request?.body)) as {
      title: string;
      body: string;
    };
    expect(Object.keys(issue).sort()).toEqual(["body", "title"]);
    expect(issue.title).toBe("[ClaimGraph operations] CRITICAL alert");
    expect(issue.title.length).toBeLessThanOrEqual(120);
    expect(issue.body.length).toBeLessThanOrEqual(24_000);
    const aggregateMatch = issue.body.match(/```json\n([\s\S]+)\n```$/u);
    expect(aggregateMatch).not.toBeNull();
    const aggregate = JSON.parse(aggregateMatch![1]!);
    expect(aggregate).toEqual({
      schemaVersion: 1,
      kind: "alert",
      checkedAt: now.toISOString(),
      status: "critical",
      alerts: alert.alerts,
      health: alert.health,
      cleanup: alert.cleanup,
      provider: alert.provider,
      events: alert.events
    });
    expect(issue.body).not.toContain("SECRET_GITHUB_TOKEN_CANARY_MUST_NOT_LEAK");
    expect(issue.body).not.toContain("SECRET_NOTIFICATION_CANARY_MUST_NOT_LEAK");
    expect(issue.body).not.toContain("SECRET_FUTURE_CANARY_MUST_NOT_LEAK");
    expect(issue.body).not.toContain("workspace-secret-canary");
    expect(issue.body).not.toContain("run-secret-canary");
  });

  it("claims concurrent notification attempts with a durable single-flight lease", async () => {
    process.env.CLAIMGRAPH_OPERATIONS_WEBHOOK_URL =
      "https://operations.example.test/claimgraph";
    const now = new Date("2026-07-16T07:30:00.000Z");
    const alert = snapshot({
      checkedAt: now.toISOString(),
      status: "warning",
      alertCode: "cleanup-backlog-due"
    });
    let finishDelivery!: () => void;
    const deliveryGate = new Promise<void>((resolve) => {
      finishDelivery = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      await deliveryGate;
      return new Response(null, { status: 204 });
    });
    const first = deliverOperationsNotification({
      now,
      snapshot: alert,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const second = await deliverOperationsNotification({
      now,
      snapshot: alert,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    finishDelivery();

    await expect(first).resolves.toEqual({ kind: "delivered" });
    expect(second).toEqual({ kind: "skipped" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a failed recovery after cooldown and marks it delivered only on success", async () => {
    process.env.CLAIMGRAPH_OPERATIONS_WEBHOOK_URL =
      "https://operations.example.test/claimgraph";
    process.env.CLAIMGRAPH_OPERATIONS_NOTIFICATION_COOLDOWN_MINUTES = "5";
    await saveOperationalNotificationState({
      lastStatus: "warning",
      lastFingerprint: "previous-alert",
      lastAttemptAt: "2026-07-16T07:00:00.000Z",
      lastSuccessAt: "2026-07-16T07:00:00.000Z",
      lastFailureAt: null,
      lastFailureCode: null
    });
    const recoveryAt = new Date("2026-07-16T08:00:00.000Z");
    const recoverySnapshot = snapshot({
      checkedAt: recoveryAt.toISOString(),
      status: "ready"
    });
    const failedFetch = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit
    ) => new Response(null, { status: 503 }));

    await expect(deliverOperationsNotification({
      now: recoveryAt,
      snapshot: recoverySnapshot,
      fetchImpl: failedFetch as unknown as typeof fetch
    })).resolves.toEqual({ kind: "failed", failureCode: "http_503" });
    expect((await getOperationalNotificationState())?.lastStatus).toBe("warning");

    const successfulFetch = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit
    ) => new Response(null, { status: 204 }));
    await expect(deliverOperationsNotification({
      now: new Date(recoveryAt.getTime() + 60_000),
      snapshot: recoverySnapshot,
      fetchImpl: successfulFetch as unknown as typeof fetch
    })).resolves.toEqual({ kind: "skipped" });
    await expect(deliverOperationsNotification({
      now: new Date(recoveryAt.getTime() + 6 * 60_000),
      snapshot: recoverySnapshot,
      fetchImpl: successfulFetch as unknown as typeof fetch
    })).resolves.toEqual({ kind: "delivered" });

    expect(successfulFetch).toHaveBeenCalledTimes(1);
    expect(await getOperationalNotificationState()).toMatchObject({
      lastStatus: "ready",
      lastSuccessAt: new Date(recoveryAt.getTime() + 6 * 60_000).toISOString(),
      lastFailureCode: null
    });
  });
});
