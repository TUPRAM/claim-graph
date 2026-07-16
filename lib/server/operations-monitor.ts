import { randomUUID } from "node:crypto";
import {
  claimOperationalNotificationDelivery,
  completeOperationalNotificationDelivery,
  getOperationalEventSummary,
  getOperationalNotificationState,
  operationalAlertFingerprint,
  releaseOperationalNotificationDelivery,
  tryRecordOperationalEvent,
  type OperationalEventAggregate,
  type OperationalMonitorStatus
} from "@/lib/server/operational-events";
import { getProductionHealthSummary } from "@/lib/server/production-health";
import { getProviderCapacitySnapshot } from "@/lib/server/public-beta-control-store";
import {
  validateOperationsNotificationConfiguration,
  type OperationsWebhookFormat
} from "@/lib/server/public-beta-policy";
import { getCleanupBacklogSummary } from "@/lib/server/retention-cleanup";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_ISSUE_TITLE_MAX_CHARS = 120;
const GITHUB_ISSUE_BODY_MAX_CHARS = 24_000;

export interface OperationalAlert {
  code: string;
  severity: "warning" | "critical";
  message: string;
}

export interface OperationsMonitorSnapshot {
  schemaVersion: 1;
  checkedAt: string;
  status: OperationalMonitorStatus;
  health: {
    status: "ready" | "degraded" | "unhealthy";
  };
  cleanup: {
    dueCount: number;
    failedCount: number;
    deadCount: number;
    oldestDueAt: string | null;
    heartbeatAt: string | null;
    heartbeatAgeSeconds: number | null;
  };
  provider: {
    analysisEnabled: boolean;
    activeLeases: number;
    limit: number;
    available: boolean;
  };
  events: {
    windowHours: 24;
    aggregates: OperationalEventAggregate[];
  };
  notification: {
    configured: boolean;
    bearerConfigured: boolean;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    lastFailureCode: string | null;
  };
  alerts: OperationalAlert[];
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  bounds: { min: number; max: number }
) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed)
    ? Math.max(bounds.min, Math.min(bounds.max, parsed))
    : fallback;
}

function webhookConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const rawUrl = env.CLAIMGRAPH_OPERATIONS_WEBHOOK_URL?.trim() ?? "";
  const validation = validateOperationsNotificationConfiguration(env);
  return {
    format: validation.format,
    url: validation.configured ? rawUrl : null,
    bearerToken: env.CLAIMGRAPH_OPERATIONS_WEBHOOK_BEARER_TOKEN?.trim() || null,
    timeoutMs: boundedInteger(
      env.CLAIMGRAPH_OPERATIONS_WEBHOOK_TIMEOUT_MS,
      5_000,
      { min: 1_000, max: 30_000 }
    ),
    cooldownMs: boundedInteger(
      env.CLAIMGRAPH_OPERATIONS_NOTIFICATION_COOLDOWN_MINUTES,
      60,
      { min: 5, max: 24 * 60 }
    ) * 60_000
  };
}

type OperationsNotificationPayload = Omit<OperationsMonitorSnapshot, "notification"> & {
  kind: "alert" | "recovery";
};

function sanitizeBoundedText(value: string, maxChars: number) {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ")
    .replace(/\r\n?/gu, "\n")
    .trim()
    .slice(0, maxChars);
}

function githubIssuePayload(payload: OperationsNotificationPayload) {
  const title = sanitizeBoundedText(
    payload.kind === "recovery"
      ? "[ClaimGraph operations] Recovery"
      : `[ClaimGraph operations] ${payload.status.toUpperCase()} alert`,
    GITHUB_ISSUE_TITLE_MAX_CHARS
  );
  const serializedAggregate = JSON.stringify(payload, null, 2)
    .replace(/```/gu, "` ` `");
  const body = sanitizeBoundedText([
    "ClaimGraph privacy-minimal aggregate notification.",
    "",
    "```json",
    serializedAggregate,
    "```"
  ].join("\n"), GITHUB_ISSUE_BODY_MAX_CHARS);

  return { title, body };
}

function deliveryRequest(input: {
  format: OperationsWebhookFormat;
  bearerToken: string | null;
  payload: OperationsNotificationPayload;
}): { headers: Record<string, string>; body: string } {
  if (input.format === "github-issue") {
    return {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${input.bearerToken}`,
        "Content-Type": "application/json",
        "User-Agent": "ClaimGraph-Operations-Notifier/1.0",
        "X-GitHub-Api-Version": GITHUB_API_VERSION
      },
      body: JSON.stringify(githubIssuePayload(input.payload))
    };
  }

  return {
    headers: {
      "Content-Type": "application/json",
      ...(input.bearerToken
        ? { Authorization: `Bearer ${input.bearerToken}` }
        : {})
    },
    body: JSON.stringify(input.payload)
  };
}

function newestEvent(
  events: OperationalEventAggregate[],
  eventType: OperationalEventAggregate["eventType"]
) {
  return events.find((event) => event.eventType === eventType) ?? null;
}

function failureIsNewer(input: {
  failureAt: string | null;
  successAt: string | null;
}) {
  if (!input.failureAt) {
    return false;
  }

  return !input.successAt || Date.parse(input.failureAt) > Date.parse(input.successAt);
}

function eventIsNewer(
  left: OperationalEventAggregate | null,
  right: OperationalEventAggregate | null
) {
  return Boolean(
    left && (!right || Date.parse(left.lastSeenAt) > Date.parse(right.lastSeenAt))
  );
}

export async function getOperationsMonitorSnapshot(
  now = new Date()
): Promise<OperationsMonitorSnapshot> {
  const [health, cleanup, provider, recentEvents, retainedEvents, notificationState] =
    await Promise.all([
      getProductionHealthSummary(),
      getCleanupBacklogSummary(now),
      getProviderCapacitySnapshot(now),
      getOperationalEventSummary({ since: new Date(now.getTime() - DAY_MS), now }),
      getOperationalEventSummary({ since: new Date(0), now }),
      getOperationalNotificationState()
    ]);
  const config = webhookConfiguration();
  const heartbeatAt = newestEvent(retainedEvents, "cleanup-heartbeat")?.lastSeenAt ?? null;
  const heartbeatAgeSeconds = heartbeatAt
    ? Math.max(0, Math.floor((now.getTime() - Date.parse(heartbeatAt)) / 1_000))
    : null;
  const heartbeatWarningSeconds = boundedInteger(
    process.env.CLAIMGRAPH_CLEANUP_HEARTBEAT_MAX_HOURS,
    26,
    { min: 1, max: 7 * 24 }
  ) * 60 * 60;
  const alerts: OperationalAlert[] = [];

  if (health.status === "unhealthy") {
    alerts.push({
      code: "production-health-unhealthy",
      severity: "critical",
      message: "Production health is unhealthy."
    });
  } else if (health.status === "degraded") {
    alerts.push({
      code: "production-health-degraded",
      severity: "warning",
      message: "Production health is degraded."
    });
  }

  if (!heartbeatAt) {
    alerts.push({
      code: "cleanup-heartbeat-missing",
      severity: "warning",
      message: "No cleanup scheduler heartbeat has been recorded."
    });
  } else if ((heartbeatAgeSeconds ?? 0) > heartbeatWarningSeconds * 2) {
    alerts.push({
      code: "cleanup-heartbeat-critical",
      severity: "critical",
      message: "The cleanup scheduler heartbeat is more than twice its allowed age."
    });
  } else if ((heartbeatAgeSeconds ?? 0) > heartbeatWarningSeconds) {
    alerts.push({
      code: "cleanup-heartbeat-stale",
      severity: "warning",
      message: "The cleanup scheduler heartbeat is stale."
    });
  }

  if (cleanup.deadCount > 0) {
    alerts.push({
      code: "cleanup-jobs-dead",
      severity: "critical",
      message: `${cleanup.deadCount} cleanup job(s) exhausted their retry budget.`
    });
  } else if (cleanup.failedCount > 0) {
    alerts.push({
      code: "cleanup-jobs-failed",
      severity: "warning",
      message: `${cleanup.failedCount} cleanup job(s) are waiting for retry.`
    });
  }

  if (cleanup.dueCount > 0) {
    const oldestDueAgeMs = cleanup.oldestDueAt
      ? now.getTime() - Date.parse(cleanup.oldestDueAt)
      : 0;
    alerts.push({
      code: oldestDueAgeMs > 6 * HOUR_MS
        ? "cleanup-backlog-critical"
        : "cleanup-backlog-due",
      severity: oldestDueAgeMs > 6 * HOUR_MS ? "critical" : "warning",
      message: `${cleanup.dueCount} cleanup job(s) are currently due.`
    });
  }

  if (provider.analysisEnabled && provider.activeLeases >= provider.limit) {
    alerts.push({
      code: "provider-capacity-saturated",
      severity: "warning",
      message: "Provider concurrency is currently saturated."
    });
  }

  const paidCeilingRefusals = newestEvent(
    recentEvents,
    "paid-analysis-ceiling-refusal"
  );
  if ((paidCeilingRefusals?.occurrenceCount ?? 0) > 0) {
    alerts.push({
      code: "paid-analysis-ceiling-exhausted",
      severity: "warning",
      message: "The paid-analysis daily ceiling refused one or more requests."
    });
  }

  const providerCapacityRefusals = newestEvent(
    recentEvents,
    "provider-capacity-refusal"
  );
  if ((providerCapacityRefusals?.occurrenceCount ?? 0) > 0) {
    alerts.push({
      code: "provider-capacity-refusals",
      severity: "warning",
      message: "Provider concurrency refused one or more requests in the last 24 hours."
    });
  }

  if (!config.url) {
    alerts.push({
      code: "operations-notification-unconfigured",
      severity: "warning",
      message: "The operator notification webhook is not configured."
    });
  }

  const notificationFailed = newestEvent(recentEvents, "notification-failed");
  const notificationDelivered = newestEvent(recentEvents, "notification-delivered");
  if (failureIsNewer({
    failureAt: notificationState?.lastFailureAt ?? null,
    successAt: notificationState?.lastSuccessAt ?? null
  }) || eventIsNewer(notificationFailed, notificationDelivered)) {
    alerts.push({
      code: "operations-notification-failed",
      severity: "warning",
      message: "The most recent operator notification delivery failed."
    });
  }

  const status: OperationalMonitorStatus = alerts.some(
    (alert) => alert.severity === "critical"
  )
    ? "critical"
    : alerts.length
      ? "warning"
      : "ready";

  return {
    schemaVersion: 1,
    checkedAt: now.toISOString(),
    status,
    health: { status: health.status },
    cleanup: {
      dueCount: cleanup.dueCount,
      failedCount: cleanup.failedCount,
      deadCount: cleanup.deadCount,
      oldestDueAt: cleanup.oldestDueAt,
      heartbeatAt,
      heartbeatAgeSeconds
    },
    provider: {
      analysisEnabled: provider.analysisEnabled,
      activeLeases: provider.activeLeases,
      limit: provider.limit,
      available: provider.available
    },
    events: {
      windowHours: 24,
      aggregates: recentEvents
    },
    notification: {
      configured: Boolean(config.url),
      bearerConfigured: Boolean(config.bearerToken),
      lastAttemptAt: notificationState?.lastAttemptAt ?? null,
      lastSuccessAt: notificationState?.lastSuccessAt ?? null,
      lastFailureAt: notificationState?.lastFailureAt ?? null,
      lastFailureCode: notificationState?.lastFailureCode ?? null
    },
    alerts
  };
}

function classifyDeliveryError(error: unknown) {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return "timeout";
  }

  return "network";
}

export async function deliverOperationsNotification(input?: {
  now?: Date;
  snapshot?: OperationsMonitorSnapshot;
  fetchImpl?: typeof fetch;
}) {
  const now = input?.now ?? new Date();
  const config = webhookConfiguration();

  if (!config.url) {
    return { kind: "not-configured" as const };
  }

  const snapshot = input?.snapshot ?? await getOperationsMonitorSnapshot(now);
  const leaseId = randomUUID();
  const state = await claimOperationalNotificationDelivery({
    leaseId,
    now,
    leaseMs: config.timeoutMs + 30_000
  });

  if (!state) {
    return { kind: "skipped" as const };
  }

  const fingerprint = operationalAlertFingerprint({
    status: snapshot.status,
    alertCodes: snapshot.alerts.map((alert) => alert.code)
  });
  const recovery = snapshot.status === "ready" && state.lastStatus !== "ready";
  const activeAlert = snapshot.status !== "ready";
  const changed = state.lastFingerprint !== fingerprint;
  const cooldownElapsed = !state.lastAttemptAt ||
    now.getTime() - Date.parse(state.lastAttemptAt) >= config.cooldownMs;

  if (!recovery && !activeAlert) {
    await releaseOperationalNotificationDelivery(leaseId);
    return { kind: "skipped" as const };
  }

  if (!changed && !cooldownElapsed) {
    await releaseOperationalNotificationDelivery(leaseId);
    return { kind: "skipped" as const };
  }

  const attemptedAt = now.toISOString();
  const payload: OperationsNotificationPayload = {
    schemaVersion: 1,
    kind: recovery ? "recovery" : "alert",
    checkedAt: snapshot.checkedAt,
    status: snapshot.status,
    alerts: snapshot.alerts,
    health: snapshot.health,
    cleanup: snapshot.cleanup,
    provider: snapshot.provider,
    events: snapshot.events
  };
  const request = deliveryRequest({
    format: config.format!,
    bearerToken: config.bearerToken,
    payload
  });
  let failureCode: string | null = null;

  try {
    const response = await (input?.fetchImpl ?? fetch)(config.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(config.timeoutMs)
    });

    if (!response.ok) {
      failureCode = `http_${response.status}`;
    }
  } catch (error) {
    failureCode = classifyDeliveryError(error);
  }

  const completed = await completeOperationalNotificationDelivery({
    leaseId,
    state: {
      // lastStatus deliberately means "last successfully delivered status".
      // Keeping the prior value after a delivery failure lets recovery messages
      // retry after the cooldown instead of being lost permanently.
      lastStatus: failureCode ? state.lastStatus : snapshot.status,
      lastFingerprint: fingerprint,
      lastAttemptAt: attemptedAt,
      lastSuccessAt: failureCode ? state.lastSuccessAt : attemptedAt,
      lastFailureAt: failureCode ? attemptedAt : state.lastFailureAt,
      lastFailureCode: failureCode
    }
  });

  if (!completed) {
    throw new Error("The operations notification delivery lease expired.");
  }
  await tryRecordOperationalEvent({
    eventType: failureCode ? "notification-failed" : "notification-delivered",
    now
  });

  return failureCode
    ? { kind: "failed" as const, failureCode }
    : { kind: "delivered" as const };
}

export async function tryDeliverOperationsNotification(input?: {
  now?: Date;
  snapshot?: OperationsMonitorSnapshot;
  fetchImpl?: typeof fetch;
}) {
  try {
    return await deliverOperationsNotification(input);
  } catch {
    await tryRecordOperationalEvent({
      eventType: "notification-failed",
      now: input?.now
    });
    return { kind: "failed" as const, failureCode: "internal" };
  }
}
