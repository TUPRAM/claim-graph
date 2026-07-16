import { createHash } from "node:crypto";
import { withClaimGraphDatabase } from "@/lib/server/database";
import { getClaimGraphStorageDriver } from "@/lib/server/storage/config";
import { getReadyHostedSql } from "@/lib/server/storage/hosted-schema";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_EVENT_RETENTION_DAYS = 30;

export const OPERATIONAL_EVENT_TYPES = [
  "workspace-creation-429",
  "analysis-limit-429",
  "paid-analysis-ceiling-refusal",
  "provider-capacity-refusal",
  "kill-switch-changed",
  "analysis-kill-switch-refusal",
  "export-429",
  "export-completed",
  "export-failed",
  "file-mutation-429",
  "developer-login-429",
  "cleanup-heartbeat",
  "cleanup-job-completed",
  "cleanup-job-failed",
  "cleanup-job-dead",
  "notification-delivered",
  "notification-failed"
] as const;

export type OperationalEventType = typeof OPERATIONAL_EVENT_TYPES[number];
export type OperationalMonitorStatus = "ready" | "warning" | "critical";

export interface OperationalEventAggregate {
  eventType: OperationalEventType;
  occurrenceCount: number;
  valueTotal: number;
  lastSeenAt: string;
}

export interface OperationalNotificationState {
  lastStatus: OperationalMonitorStatus;
  lastFingerprint: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureCode: string | null;
}

interface OperationalEventRow {
  event_type: OperationalEventType;
  occurrence_count: number | string;
  value_total: number | string;
  last_seen_at: string | Date;
}

interface NotificationStateRow {
  last_status: OperationalMonitorStatus;
  last_fingerprint: string;
  last_attempt_at: string | Date | null;
  last_success_at: string | Date | null;
  last_failure_at: string | Date | null;
  last_failure_code: string | null;
}

const NOTIFICATION_STATE_COLUMNS = `
  last_status, last_fingerprint, last_attempt_at, last_success_at,
  last_failure_at, last_failure_code
`;

function boundedInteger(value: string | undefined, fallback: number, max: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(max, parsed)) : fallback;
}

function eventRetentionMs(env: NodeJS.ProcessEnv = process.env) {
  return boundedInteger(
    env.CLAIMGRAPH_OPERATIONAL_EVENT_TTL_DAYS,
    DEFAULT_EVENT_RETENTION_DAYS,
    365
  ) * DAY_MS;
}

function iso(value: string | Date | null) {
  if (value === null) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizeAggregate(row: OperationalEventRow): OperationalEventAggregate {
  return {
    eventType: row.event_type,
    occurrenceCount: Number(row.occurrence_count),
    valueTotal: Number(row.value_total),
    lastSeenAt: iso(row.last_seen_at)!
  };
}

function normalizeNotificationState(
  row: NotificationStateRow
): OperationalNotificationState {
  return {
    lastStatus: row.last_status,
    lastFingerprint: row.last_fingerprint,
    lastAttemptAt: iso(row.last_attempt_at),
    lastSuccessAt: iso(row.last_success_at),
    lastFailureAt: iso(row.last_failure_at),
    lastFailureCode: row.last_failure_code
  };
}

export async function recordOperationalEvent(input: {
  eventType: OperationalEventType;
  value?: number;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const value = Math.max(0, Math.min(2_000_000_000, Math.round(input.value ?? 0)));
  const windowStartedAt = new Date(
    Math.floor(now.getTime() / HOUR_MS) * HOUR_MS
  ).toISOString();
  const expiresAt = new Date(now.getTime() + eventRetentionMs()).toISOString();

  if (getClaimGraphStorageDriver() === "hosted") {
    const sql = await getReadyHostedSql();
    await sql.transaction([
      sql.query(
        "DELETE FROM claimgraph_operational_event_buckets WHERE expires_at <= $1",
        [now.toISOString()]
      ),
      sql.query(
        `
          INSERT INTO claimgraph_operational_event_buckets
            (event_type, window_started_at, occurrence_count, value_total, last_seen_at, expires_at)
          VALUES ($1, $2, 1, $3, $4, $5)
          ON CONFLICT (event_type, window_started_at)
          DO UPDATE SET
            occurrence_count = claimgraph_operational_event_buckets.occurrence_count + 1,
            value_total = claimgraph_operational_event_buckets.value_total + EXCLUDED.value_total,
            last_seen_at = EXCLUDED.last_seen_at,
            expires_at = EXCLUDED.expires_at
        `,
        [input.eventType, windowStartedAt, value, now.toISOString(), expiresAt]
      )
    ]);
    return;
  }

  withClaimGraphDatabase((db) => {
    const transaction = db.transaction(() => {
      db.prepare("DELETE FROM operational_event_buckets WHERE expires_at <= ?")
        .run(now.toISOString());
      db.prepare(`
        INSERT INTO operational_event_buckets
          (event_type, window_started_at, occurrence_count, value_total, last_seen_at, expires_at)
        VALUES (?, ?, 1, ?, ?, ?)
        ON CONFLICT (event_type, window_started_at)
        DO UPDATE SET
          occurrence_count = operational_event_buckets.occurrence_count + 1,
          value_total = operational_event_buckets.value_total + excluded.value_total,
          last_seen_at = excluded.last_seen_at,
          expires_at = excluded.expires_at
      `).run(
        input.eventType,
        windowStartedAt,
        value,
        now.toISOString(),
        expiresAt
      );
    });
    transaction.immediate();
  });
}

export async function tryRecordOperationalEvent(input: {
  eventType: OperationalEventType;
  value?: number;
  now?: Date;
}) {
  try {
    await recordOperationalEvent(input);
    return true;
  } catch {
    return false;
  }
}

export async function getOperationalEventSummary(input?: {
  since?: Date;
  now?: Date;
}) {
  const now = input?.now ?? new Date();
  const since = input?.since ?? new Date(now.getTime() - DAY_MS);

  if (getClaimGraphStorageDriver() === "hosted") {
    const sql = await getReadyHostedSql();
    const rows = (await sql.query(
      `
        SELECT event_type, sum(occurrence_count) AS occurrence_count,
               sum(value_total) AS value_total, max(last_seen_at) AS last_seen_at
        FROM claimgraph_operational_event_buckets
        WHERE last_seen_at >= $1 AND expires_at > $2
        GROUP BY event_type
        ORDER BY event_type ASC
      `,
      [since.toISOString(), now.toISOString()]
    )) as OperationalEventRow[];
    return rows.map(normalizeAggregate);
  }

  return withClaimGraphDatabase((db) => {
    const rows = db.prepare(`
      SELECT event_type, sum(occurrence_count) AS occurrence_count,
             sum(value_total) AS value_total, max(last_seen_at) AS last_seen_at
      FROM operational_event_buckets
      WHERE last_seen_at >= ? AND expires_at > ?
      GROUP BY event_type
      ORDER BY event_type ASC
    `).all(since.toISOString(), now.toISOString()) as OperationalEventRow[];
    return rows.map(normalizeAggregate);
  });
}

export async function getOperationalNotificationState() {
  if (getClaimGraphStorageDriver() === "hosted") {
    const sql = await getReadyHostedSql();
    const rows = (await sql.query(
      `
        SELECT ${NOTIFICATION_STATE_COLUMNS}
        FROM claimgraph_operational_notification_state
        WHERE id = 'primary'
      `
    )) as NotificationStateRow[];
    return rows[0] ? normalizeNotificationState(rows[0]) : null;
  }

  return withClaimGraphDatabase((db) => {
    const row = db.prepare(`
      SELECT ${NOTIFICATION_STATE_COLUMNS}
      FROM operational_notification_state
      WHERE id = 'primary'
    `).get() as NotificationStateRow | undefined;
    return row ? normalizeNotificationState(row) : null;
  });
}

export async function claimOperationalNotificationDelivery(input: {
  leaseId: string;
  now: Date;
  leaseMs: number;
}) {
  const expiresAt = new Date(
    input.now.getTime() + Math.max(10_000, Math.min(input.leaseMs, 120_000))
  ).toISOString();

  if (getClaimGraphStorageDriver() === "hosted") {
    const sql = await getReadyHostedSql();
    const rows = (await sql.query(
      `
        INSERT INTO claimgraph_operational_notification_state
          (id, last_status, last_fingerprint, last_attempt_at, last_success_at,
           last_failure_at, last_failure_code, delivery_lease_id,
           delivery_lease_expires_at)
        VALUES ('primary', 'ready', '', NULL, NULL, NULL, NULL, $1, $2)
        ON CONFLICT (id) DO UPDATE SET
          delivery_lease_id = EXCLUDED.delivery_lease_id,
          delivery_lease_expires_at = EXCLUDED.delivery_lease_expires_at
        WHERE
          claimgraph_operational_notification_state.delivery_lease_id IS NULL
          OR claimgraph_operational_notification_state.delivery_lease_expires_at IS NULL
          OR claimgraph_operational_notification_state.delivery_lease_expires_at <= $3
        RETURNING ${NOTIFICATION_STATE_COLUMNS}
      `,
      [input.leaseId, expiresAt, input.now.toISOString()]
    )) as NotificationStateRow[];
    return rows[0] ? normalizeNotificationState(rows[0]) : null;
  }

  return withClaimGraphDatabase((db) => {
    const transaction = db.transaction(() => {
      db.prepare(`
        INSERT OR IGNORE INTO operational_notification_state
          (id, last_status, last_fingerprint, last_attempt_at, last_success_at,
           last_failure_at, last_failure_code, delivery_lease_id,
           delivery_lease_expires_at)
        VALUES ('primary', 'ready', '', NULL, NULL, NULL, NULL, NULL, NULL)
      `).run();
      const claimed = db.prepare(`
        UPDATE operational_notification_state
        SET delivery_lease_id = ?, delivery_lease_expires_at = ?
        WHERE id = 'primary'
          AND (
            delivery_lease_id IS NULL
            OR delivery_lease_expires_at IS NULL
            OR delivery_lease_expires_at <= ?
          )
      `).run(input.leaseId, expiresAt, input.now.toISOString());

      if (claimed.changes !== 1) {
        return null;
      }

      const row = db.prepare(`
        SELECT ${NOTIFICATION_STATE_COLUMNS}
        FROM operational_notification_state
        WHERE id = 'primary'
      `).get() as NotificationStateRow;
      return normalizeNotificationState(row);
    });
    return transaction.immediate();
  });
}

export async function releaseOperationalNotificationDelivery(leaseId: string) {
  if (getClaimGraphStorageDriver() === "hosted") {
    const sql = await getReadyHostedSql();
    const rows = (await sql.query(
      `
        UPDATE claimgraph_operational_notification_state
        SET delivery_lease_id = NULL, delivery_lease_expires_at = NULL
        WHERE id = 'primary' AND delivery_lease_id = $1
        RETURNING id
      `,
      [leaseId]
    )) as Array<{ id: string }>;
    return rows.length === 1;
  }

  return withClaimGraphDatabase((db) =>
    db.prepare(`
      UPDATE operational_notification_state
      SET delivery_lease_id = NULL, delivery_lease_expires_at = NULL
      WHERE id = 'primary' AND delivery_lease_id = ?
    `).run(leaseId).changes === 1
  );
}

export async function completeOperationalNotificationDelivery(input: {
  leaseId: string;
  state: OperationalNotificationState;
}) {
  const { state } = input;

  if (getClaimGraphStorageDriver() === "hosted") {
    const sql = await getReadyHostedSql();
    const rows = (await sql.query(
      `
        UPDATE claimgraph_operational_notification_state
        SET last_status = $2, last_fingerprint = $3, last_attempt_at = $4,
            last_success_at = $5, last_failure_at = $6, last_failure_code = $7,
            delivery_lease_id = NULL, delivery_lease_expires_at = NULL
        WHERE id = 'primary' AND delivery_lease_id = $1
        RETURNING id
      `,
      [
        input.leaseId,
        state.lastStatus,
        state.lastFingerprint,
        state.lastAttemptAt,
        state.lastSuccessAt,
        state.lastFailureAt,
        state.lastFailureCode
      ]
    )) as Array<{ id: string }>;
    return rows.length === 1;
  }

  return withClaimGraphDatabase((db) =>
    db.prepare(`
      UPDATE operational_notification_state
      SET last_status = ?, last_fingerprint = ?, last_attempt_at = ?,
          last_success_at = ?, last_failure_at = ?, last_failure_code = ?,
          delivery_lease_id = NULL, delivery_lease_expires_at = NULL
      WHERE id = 'primary' AND delivery_lease_id = ?
    `).run(
      state.lastStatus,
      state.lastFingerprint,
      state.lastAttemptAt,
      state.lastSuccessAt,
      state.lastFailureAt,
      state.lastFailureCode,
      input.leaseId
    ).changes === 1
  );
}

export async function saveOperationalNotificationState(
  state: OperationalNotificationState
) {
  if (getClaimGraphStorageDriver() === "hosted") {
    const sql = await getReadyHostedSql();
    await sql.query(
      `
        INSERT INTO claimgraph_operational_notification_state
          (id, last_status, last_fingerprint, last_attempt_at, last_success_at,
           last_failure_at, last_failure_code)
        VALUES ('primary', $1, $2, $3, $4, $5, $6)
        ON CONFLICT (id) DO UPDATE SET
          last_status = EXCLUDED.last_status,
          last_fingerprint = EXCLUDED.last_fingerprint,
          last_attempt_at = EXCLUDED.last_attempt_at,
          last_success_at = EXCLUDED.last_success_at,
          last_failure_at = EXCLUDED.last_failure_at,
          last_failure_code = EXCLUDED.last_failure_code
      `,
      [
        state.lastStatus,
        state.lastFingerprint,
        state.lastAttemptAt,
        state.lastSuccessAt,
        state.lastFailureAt,
        state.lastFailureCode
      ]
    );
    return;
  }

  withClaimGraphDatabase((db) => {
    db.prepare(`
      INSERT INTO operational_notification_state
        (id, last_status, last_fingerprint, last_attempt_at, last_success_at,
         last_failure_at, last_failure_code)
      VALUES ('primary', ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        last_status = excluded.last_status,
        last_fingerprint = excluded.last_fingerprint,
        last_attempt_at = excluded.last_attempt_at,
        last_success_at = excluded.last_success_at,
        last_failure_at = excluded.last_failure_at,
        last_failure_code = excluded.last_failure_code
    `).run(
      state.lastStatus,
      state.lastFingerprint,
      state.lastAttemptAt,
      state.lastSuccessAt,
      state.lastFailureAt,
      state.lastFailureCode
    );
  });
}

export function operationalAlertFingerprint(input: {
  status: OperationalMonitorStatus;
  alertCodes: string[];
}) {
  return createHash("sha256")
    .update(`${input.status}\0${[...input.alertCodes].sort().join("\0")}`)
    .digest("hex");
}
