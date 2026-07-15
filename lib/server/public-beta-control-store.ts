import { createHash, createHmac, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { withClaimGraphDatabase } from "@/lib/server/database";
import {
  getPublicBetaPolicy,
  hasStrongPublicBetaSecret
} from "@/lib/server/public-beta-policy";
import { getClaimGraphStorageDriver } from "@/lib/server/storage/config";
import { getReadyHostedSql } from "@/lib/server/storage/hosted-schema";

export type PublicBetaRateLimitScope =
  | "dev-login"
  | "dev-login-global"
  | "workspace-create"
  | "workspace-create-global"
  | "workspace-analysis"
  | "workspace-export"
  | "workspace-export-global"
  | "workspace-file-mutation"
  | "workspace-file-mutation-global"
  | "workspace-upload-bytes"
  | "paid-analysis";

export interface PublicBetaRateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  count: number;
  resetAt: string;
  retryAfterSeconds: number;
}

export interface PublicBetaOperatorOverrides {
  analysisEnabled?: boolean;
  workspaceCreationLimit?: number;
  workspaceAnalysisLimit?: number;
  exportLimit?: number;
  dailyPaidAnalysisLimit?: number;
  providerConcurrency?: number;
  updatedAt?: string;
}

export type IdempotencyBeginResult =
  | { kind: "acquired"; keyHash: string }
  | { kind: "in_flight"; keyHash: string }
  | { kind: "conflict"; keyHash: string }
  | {
      kind: "replay";
      keyHash: string;
      responseStatus: number;
      response: unknown;
    };

export interface ProviderLease {
  id: string;
  runId: string;
  acquiredAt: string;
  expiresAt: string;
}

interface RateLimitRow {
  count: number | string;
  expires_at: string | Date;
}

interface IdempotencyRow {
  request_hash: string;
  state: "pending" | "completed";
  response_status: number | null;
  response_data: unknown;
  expires_at: string | Date;
}

interface OperatorControlRow {
  data: string | Record<string, unknown>;
}

interface ProviderLeaseRow {
  id: string;
  run_id: string;
  acquired_at: string | Date;
  expires_at: string | Date;
}

function iso(value: string | Date) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function jsonValue<T>(value: string | T): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : value;
}

function positiveInteger(value: number | undefined, fallback: number, max: number) {
  if (!Number.isInteger(value) || !value || value < 1) {
    return fallback;
  }

  return Math.min(value, max);
}

function getAbuseHashSecret(env: NodeJS.ProcessEnv = process.env) {
  const configured = env.CLAIMGRAPH_ABUSE_HASH_SECRET?.trim();

  if (configured && hasStrongPublicBetaSecret(configured)) {
    return configured;
  }

  if (configured) {
    throw new Error(
      "CLAIMGRAPH_ABUSE_HASH_SECRET must contain at least 32 bytes."
    );
  }

  if (
    env.NODE_ENV !== "test" &&
    (env.NODE_ENV === "production" ||
      env.CLAIMGRAPH_STORAGE_DRIVER?.trim().toLowerCase() === "hosted")
  ) {
    throw new Error(
      "CLAIMGRAPH_ABUSE_HASH_SECRET is required for hosted public-beta controls."
    );
  }

  return env.DEV_MODE_SESSION_SECRET?.trim() || "claimgraph-local-controls-only";
}

export function hashPublicBetaSubject(
  namespace: string,
  value: string,
  env: NodeJS.ProcessEnv = process.env
) {
  return createHmac("sha256", getAbuseHashSecret(env))
    .update(`${namespace}\0${value.trim().toLowerCase()}`)
    .digest("hex");
}

export function getPublicClientAddress(request: Request) {
  const trustForwarded =
    process.env.VERCEL === "1" ||
    process.env.CLAIMGRAPH_TRUST_PROXY?.trim() === "1";
  const trustedHeaders = trustForwarded
    ? ["x-forwarded-for", "x-real-ip"]
    : [];

  for (const name of trustedHeaders) {
    const value = request.headers.get(name)?.split(",", 1)[0]?.trim();

    if (value && isIP(value)) {
      return value;
    }
  }

  if (process.env.NODE_ENV !== "production") {
    const value = request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
    return value && isIP(value) ? value : "local";
  }

  return "unknown";
}

function fixedWindow(nowMs: number, windowMs: number) {
  const startedAtMs = Math.floor(nowMs / windowMs) * windowMs;

  return {
    startedAt: new Date(startedAtMs).toISOString(),
    expiresAt: new Date(startedAtMs + windowMs).toISOString()
  };
}

function rateDecision(input: {
  allowed: boolean;
  count: number;
  limit: number;
  expiresAt: string;
  nowMs: number;
}): PublicBetaRateLimitDecision {
  return {
    allowed: input.allowed,
    count: input.count,
    limit: input.limit,
    remaining: Math.max(0, input.limit - input.count),
    resetAt: input.expiresAt,
    retryAfterSeconds: input.allowed
      ? 0
      : Math.max(1, Math.ceil((Date.parse(input.expiresAt) - input.nowMs) / 1_000))
  };
}

async function consumeHostedRateLimit(input: {
  scope: PublicBetaRateLimitScope;
  subjectHash: string;
  limit: number;
  amount: number;
  startedAt: string;
  expiresAt: string;
  nowMs: number;
}) {
  const sql = await getReadyHostedSql();
  const rows = (await sql.query(
    `
      INSERT INTO claimgraph_rate_limit_buckets
        (scope, subject_hash, window_started_at, count, expires_at)
      SELECT $1::text, $2::text, $3::timestamptz, $4::integer, $5::timestamptz
      WHERE $4::integer <= $6::integer
      ON CONFLICT (scope, subject_hash, window_started_at)
      DO UPDATE SET count = claimgraph_rate_limit_buckets.count + EXCLUDED.count
      WHERE claimgraph_rate_limit_buckets.count + EXCLUDED.count <= $6
      RETURNING count, expires_at
    `,
    [
      input.scope,
      input.subjectHash,
      input.startedAt,
      input.amount,
      input.expiresAt,
      input.limit
    ]
  )) as RateLimitRow[];

  if (rows[0]) {
    return rateDecision({
      allowed: true,
      count: Number(rows[0].count),
      limit: input.limit,
      expiresAt: iso(rows[0].expires_at),
      nowMs: input.nowMs
    });
  }

  const current = (await sql.query(
    `
      SELECT count, expires_at
      FROM claimgraph_rate_limit_buckets
      WHERE scope = $1 AND subject_hash = $2 AND window_started_at = $3
    `,
    [input.scope, input.subjectHash, input.startedAt]
  )) as RateLimitRow[];
  const row = current[0];

  return rateDecision({
    allowed: false,
    count: row ? Number(row.count) : input.limit,
    limit: input.limit,
    expiresAt: row ? iso(row.expires_at) : input.expiresAt,
    nowMs: input.nowMs
  });
}

function consumeLocalRateLimit(input: {
  scope: PublicBetaRateLimitScope;
  subjectHash: string;
  limit: number;
  amount: number;
  startedAt: string;
  expiresAt: string;
  nowMs: number;
}) {
  return withClaimGraphDatabase((db) => {
    const transaction = db.transaction(() => {
      db.prepare("DELETE FROM public_beta_rate_limit_buckets WHERE expires_at <= ?")
        .run(new Date(input.nowMs).toISOString());
      const row = db.prepare(`
        SELECT count, expires_at
        FROM public_beta_rate_limit_buckets
        WHERE scope = ? AND subject_hash = ? AND window_started_at = ?
      `).get(input.scope, input.subjectHash, input.startedAt) as
        | { count: number; expires_at: string }
        | undefined;
      const nextCount = (row?.count ?? 0) + input.amount;

      if (nextCount > input.limit) {
        return rateDecision({
          allowed: false,
          count: row?.count ?? input.limit,
          limit: input.limit,
          expiresAt: row?.expires_at ?? input.expiresAt,
          nowMs: input.nowMs
        });
      }

      db.prepare(`
        INSERT INTO public_beta_rate_limit_buckets
          (scope, subject_hash, window_started_at, count, expires_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (scope, subject_hash, window_started_at)
        DO UPDATE SET count = excluded.count, expires_at = excluded.expires_at
      `).run(
        input.scope,
        input.subjectHash,
        input.startedAt,
        nextCount,
        input.expiresAt
      );

      return rateDecision({
        allowed: true,
        count: nextCount,
        limit: input.limit,
        expiresAt: input.expiresAt,
        nowMs: input.nowMs
      });
    });

    return transaction.immediate();
  });
}

export async function consumePublicBetaRateLimit(input: {
  scope: PublicBetaRateLimitScope;
  subject: string;
  limit: number;
  windowMs: number;
  amount?: number;
  now?: Date;
}) {
  const nowMs = (input.now ?? new Date()).getTime();
  await pruneExpiredPublicBetaControlRecords(new Date(nowMs));
  const amount = positiveInteger(input.amount, 1, 2_000_000_000);
  const limit = positiveInteger(input.limit, 1, 2_000_000_000);
  const { startedAt, expiresAt } = fixedWindow(nowMs, input.windowMs);
  const subjectHash = hashPublicBetaSubject(input.scope, input.subject);
  const args = {
    scope: input.scope,
    subjectHash,
    limit,
    amount,
    startedAt,
    expiresAt,
    nowMs
  };

  return getClaimGraphStorageDriver() === "hosted"
    ? consumeHostedRateLimit(args)
    : consumeLocalRateLimit(args);
}

function requestFingerprintHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export async function beginIdempotentOperation(input: {
  scope: string;
  key: string;
  requestFingerprint: string;
  ttlMs?: number;
  now?: Date;
}): Promise<IdempotencyBeginResult> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(
    now.getTime() + (input.ttlMs ?? getPublicBetaPolicy().idempotencyTtlMs)
  ).toISOString();
  const keyHash = hashPublicBetaSubject(`idempotency:${input.scope}`, input.key);
  const fingerprint = requestFingerprintHash(input.requestFingerprint);

  if (getClaimGraphStorageDriver() === "hosted") {
    const sql = await getReadyHostedSql();
    await sql.query(
      "DELETE FROM claimgraph_idempotency_keys WHERE expires_at <= $1",
      [now.toISOString()]
    );
    const inserted = (await sql.query(
      `
        INSERT INTO claimgraph_idempotency_keys
          (scope, key_hash, request_hash, state, created_at, expires_at)
        VALUES ($1, $2, $3, 'pending', $4, $5)
        ON CONFLICT (scope, key_hash) DO NOTHING
        RETURNING key_hash
      `,
      [input.scope, keyHash, fingerprint, now.toISOString(), expiresAt]
    )) as Array<{ key_hash: string }>;

    if (inserted.length) {
      return { kind: "acquired", keyHash };
    }

    const rows = (await sql.query(
      `
        SELECT request_hash, state, response_status, response_data, expires_at
        FROM claimgraph_idempotency_keys
        WHERE scope = $1 AND key_hash = $2
      `,
      [input.scope, keyHash]
    )) as IdempotencyRow[];

    return classifyIdempotencyRow(rows[0], fingerprint, keyHash);
  }

  return withClaimGraphDatabase((db) => {
    const transaction = db.transaction((): IdempotencyBeginResult => {
      db.prepare("DELETE FROM public_beta_idempotency_keys WHERE expires_at <= ?")
        .run(now.toISOString());
      const row = db.prepare(`
        SELECT request_hash, state, response_status, response_data, expires_at
        FROM public_beta_idempotency_keys
        WHERE scope = ? AND key_hash = ?
      `).get(input.scope, keyHash) as
        | {
            request_hash: string;
            state: "pending" | "completed";
            response_status: number | null;
            response_data: string | null;
            expires_at: string;
          }
        | undefined;

      if (row) {
        return classifyIdempotencyRow(row, fingerprint, keyHash);
      }

      db.prepare(`
        INSERT INTO public_beta_idempotency_keys
          (scope, key_hash, request_hash, state, created_at, expires_at)
        VALUES (?, ?, ?, 'pending', ?, ?)
      `).run(input.scope, keyHash, fingerprint, now.toISOString(), expiresAt);
      return { kind: "acquired", keyHash };
    });

    return transaction.immediate();
  });
}

function classifyIdempotencyRow(
  row: IdempotencyRow | undefined,
  fingerprint: string,
  keyHash: string
): IdempotencyBeginResult {
  if (!row) {
    return { kind: "in_flight", keyHash };
  }

  if (row.request_hash !== fingerprint) {
    return { kind: "conflict", keyHash };
  }

  if (row.state !== "completed" || row.response_status == null) {
    return { kind: "in_flight", keyHash };
  }

  return {
    kind: "replay",
    keyHash,
    responseStatus: row.response_status,
    response:
      typeof row.response_data === "string"
        ? jsonValue<unknown>(row.response_data)
        : row.response_data
  };
}

export async function completeIdempotentOperation(input: {
  scope: string;
  key: string;
  requestFingerprint: string;
  responseStatus: number;
  response: unknown;
}) {
  const keyHash = hashPublicBetaSubject(`idempotency:${input.scope}`, input.key);
  const fingerprint = requestFingerprintHash(input.requestFingerprint);
  const responseJson = JSON.stringify(input.response);

  if (getClaimGraphStorageDriver() === "hosted") {
    const sql = await getReadyHostedSql();
    const rows = (await sql.query(
      `
        UPDATE claimgraph_idempotency_keys
        SET state = 'completed', response_status = $4, response_data = $5::jsonb
        WHERE scope = $1 AND key_hash = $2 AND request_hash = $3 AND state = 'pending'
        RETURNING key_hash
      `,
      [input.scope, keyHash, fingerprint, input.responseStatus, responseJson]
    )) as Array<{ key_hash: string }>;
    return rows.length === 1;
  }

  return withClaimGraphDatabase((db) =>
    db.prepare(`
      UPDATE public_beta_idempotency_keys
      SET state = 'completed', response_status = ?, response_data = ?
      WHERE scope = ? AND key_hash = ? AND request_hash = ? AND state = 'pending'
    `).run(
      input.responseStatus,
      responseJson,
      input.scope,
      keyHash,
      fingerprint
    ).changes === 1
  );
}

export async function releaseIdempotentOperation(input: {
  scope: string;
  key: string;
  requestFingerprint: string;
}) {
  const keyHash = hashPublicBetaSubject(`idempotency:${input.scope}`, input.key);
  const fingerprint = requestFingerprintHash(input.requestFingerprint);

  if (getClaimGraphStorageDriver() === "hosted") {
    const sql = await getReadyHostedSql();
    const rows = (await sql.query(
      `
        DELETE FROM claimgraph_idempotency_keys
        WHERE scope = $1 AND key_hash = $2 AND request_hash = $3 AND state = 'pending'
        RETURNING key_hash
      `,
      [input.scope, keyHash, fingerprint]
    )) as Array<{ key_hash: string }>;
    return rows.length === 1;
  }

  return withClaimGraphDatabase((db) =>
    db.prepare(`
      DELETE FROM public_beta_idempotency_keys
      WHERE scope = ? AND key_hash = ? AND request_hash = ? AND state = 'pending'
    `).run(input.scope, keyHash, fingerprint).changes === 1
  );
}

export async function getPublicBetaOperatorOverrides(): Promise<PublicBetaOperatorOverrides> {
  if (getClaimGraphStorageDriver() === "hosted") {
    const sql = await getReadyHostedSql();
    const rows = (await sql.query(
      "SELECT data FROM claimgraph_operator_controls WHERE id = 'public-beta'"
    )) as OperatorControlRow[];
    return rows[0]
      ? jsonValue<PublicBetaOperatorOverrides>(rows[0].data)
      : {};
  }

  return withClaimGraphDatabase((db) => {
    const row = db.prepare(
      "SELECT data FROM public_beta_operator_controls WHERE id = 'public-beta'"
    ).get() as { data: string } | undefined;
    return row ? jsonValue<PublicBetaOperatorOverrides>(row.data) : {};
  });
}

export async function updatePublicBetaOperatorOverrides(
  patch: Omit<PublicBetaOperatorOverrides, "updatedAt">
) {
  const updatedAt = new Date().toISOString();
  const patchWithTimestamp: PublicBetaOperatorOverrides = {
    ...patch,
    updatedAt
  };

  if (getClaimGraphStorageDriver() === "hosted") {
    const sql = await getReadyHostedSql();
    const rows = (await sql.query(
      `
        INSERT INTO claimgraph_operator_controls (id, updated_at, data)
        VALUES ('public-beta', $1, $2::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          updated_at = EXCLUDED.updated_at,
          data = claimgraph_operator_controls.data || EXCLUDED.data
        RETURNING data
      `,
      [updatedAt, JSON.stringify(patchWithTimestamp)]
    )) as OperatorControlRow[];
    return jsonValue<PublicBetaOperatorOverrides>(rows[0]!.data);
  }

  return withClaimGraphDatabase((db) => {
    const transaction = db.transaction(() => {
      const row = db.prepare(
        "SELECT data FROM public_beta_operator_controls WHERE id = 'public-beta'"
      ).get() as { data: string } | undefined;
      const next: PublicBetaOperatorOverrides = {
        ...(row ? jsonValue<PublicBetaOperatorOverrides>(row.data) : {}),
        ...patchWithTimestamp
      };
      db.prepare(`
        INSERT INTO public_beta_operator_controls (id, updated_at, data)
        VALUES ('public-beta', ?, ?)
        ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at, data = excluded.data
      `).run(updatedAt, JSON.stringify(next));
      return next;
    });
    return transaction.immediate();
  });
}

export async function getEffectivePublicBetaControls() {
  const policy = getPublicBetaPolicy();
  const overrides = await getPublicBetaOperatorOverrides();

  return {
    analysisEnabled:
      overrides.analysisEnabled ?? policy.analysisEnabledByDefault,
    workspaceCreationLimit: positiveInteger(
      overrides.workspaceCreationLimit,
      policy.workspaceCreation.limit,
      1_000
    ),
    workspaceAnalysisLimit: positiveInteger(
      overrides.workspaceAnalysisLimit,
      policy.workspaceAnalysis.limit,
      1_000
    ),
    exportLimit: positiveInteger(
      overrides.exportLimit,
      policy.export.limit,
      10_000
    ),
    dailyPaidAnalysisLimit: positiveInteger(
      overrides.dailyPaidAnalysisLimit,
      policy.paidAnalysis.dailyLimit,
      10_000
    ),
    providerConcurrency: positiveInteger(
      overrides.providerConcurrency,
      policy.provider.concurrency,
      100
    ),
    policy,
    overrides
  };
}

function normalizeLease(row: ProviderLeaseRow): ProviderLease {
  return {
    id: row.id,
    runId: row.run_id,
    acquiredAt: iso(row.acquired_at),
    expiresAt: iso(row.expires_at)
  };
}

export async function acquireProviderLease(input: {
  runId: string;
  limit?: number;
  leaseMs?: number;
  now?: Date;
}): Promise<{ acquired: boolean; lease: ProviderLease | null }> {
  await pruneExpiredPublicBetaControlRecords(input.now ?? new Date());
  const controls = await getEffectivePublicBetaControls();

  if (!controls.analysisEnabled) {
    return { acquired: false, lease: null };
  }

  const now = input.now ?? new Date();
  const limit = positiveInteger(input.limit, controls.providerConcurrency, 100);
  const leaseMs = input.leaseMs ?? controls.policy.provider.leaseMs;
  const lease: ProviderLease = {
    id: randomUUID(),
    runId: input.runId,
    acquiredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + leaseMs).toISOString()
  };

  if (getClaimGraphStorageDriver() === "hosted") {
    const sql = await getReadyHostedSql();
    const rows = (await sql.query(
      `
        WITH lifecycle_lock AS (
          SELECT pg_advisory_xact_lock(hashtextextended('claimgraph-provider-capacity', 0))
        ),
        inserted AS (
          INSERT INTO claimgraph_provider_leases
            (id, run_id, acquired_at, expires_at)
          SELECT $2, $3, $1, $4 FROM lifecycle_lock
          WHERE (
            SELECT count(*)
            FROM claimgraph_provider_leases
            WHERE expires_at > $1
          ) < $5
          RETURNING id, run_id, acquired_at, expires_at
        )
        SELECT id, run_id, acquired_at, expires_at FROM inserted
      `,
      [lease.acquiredAt, lease.id, lease.runId, lease.expiresAt, limit]
    )) as ProviderLeaseRow[];

    return {
      acquired: rows.length === 1,
      lease: rows[0] ? normalizeLease(rows[0]) : null
    };
  }

  return withClaimGraphDatabase((db) => {
    const transaction = db.transaction(() => {
      db.prepare("DELETE FROM public_beta_provider_leases WHERE expires_at <= ?")
        .run(lease.acquiredAt);
      const count = db.prepare(
        "SELECT count(*) AS count FROM public_beta_provider_leases"
      ).get() as { count: number };

      if (count.count >= limit) {
        return { acquired: false, lease: null };
      }

      db.prepare(`
        INSERT INTO public_beta_provider_leases (id, run_id, acquired_at, expires_at)
        VALUES (?, ?, ?, ?)
      `).run(lease.id, lease.runId, lease.acquiredAt, lease.expiresAt);
      return { acquired: true, lease };
    });

    return transaction.immediate();
  });
}

export async function releaseProviderLease(leaseId: string) {
  if (getClaimGraphStorageDriver() === "hosted") {
    const sql = await getReadyHostedSql();
    const rows = (await sql.query(
      "DELETE FROM claimgraph_provider_leases WHERE id = $1 RETURNING id",
      [leaseId]
    )) as Array<{ id: string }>;
    return rows.length === 1;
  }

  return withClaimGraphDatabase((db) =>
    db.prepare("DELETE FROM public_beta_provider_leases WHERE id = ?")
      .run(leaseId).changes === 1
  );
}

export async function renewProviderLease(
  leaseId: string,
  leaseMs = getPublicBetaPolicy().provider.leaseMs,
  now = new Date()
) {
  const expiresAt = new Date(now.getTime() + leaseMs).toISOString();

  if (getClaimGraphStorageDriver() === "hosted") {
    const sql = await getReadyHostedSql();
    const rows = (await sql.query(
      `
        UPDATE claimgraph_provider_leases
        SET expires_at = $2
        WHERE id = $1 AND expires_at > $3
        RETURNING id
      `,
      [leaseId, expiresAt, now.toISOString()]
    )) as Array<{ id: string }>;
    return rows.length === 1;
  }

  return withClaimGraphDatabase((db) =>
    db.prepare(`
      UPDATE public_beta_provider_leases
      SET expires_at = ?
      WHERE id = ? AND expires_at > ?
    `).run(expiresAt, leaseId, now.toISOString()).changes === 1
  );
}

export async function withProviderLease<T>(input: {
  runId: string;
  execute: () => Promise<T>;
  limit?: number;
  leaseMs?: number;
}) {
  const acquired = await acquireProviderLease(input);

  if (!acquired.acquired) {
    throw new PublicBetaCapacityError(
      "Provider capacity is currently full or analysis has been disabled."
    );
  }

  const heartbeatMs = Math.max(
    5_000,
    Math.min(60_000, Math.floor((input.leaseMs ?? getPublicBetaPolicy().provider.leaseMs) / 3))
  );
  const heartbeat = acquired.lease
    ? setInterval(() => {
        void renewProviderLease(
          acquired.lease!.id,
          input.leaseMs ?? getPublicBetaPolicy().provider.leaseMs
        ).catch(() => undefined);
      }, heartbeatMs)
    : null;
  heartbeat?.unref?.();

  try {
    return await input.execute();
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
    if (acquired.lease) {
      await releaseProviderLease(acquired.lease.id).catch(() => undefined);
    }
  }
}

export async function getProviderCapacitySnapshot(now = new Date()) {
  await pruneExpiredPublicBetaControlRecords(now);
  const controls = await getEffectivePublicBetaControls();
  let activeLeases = 0;

  if (getClaimGraphStorageDriver() === "hosted") {
    const sql = await getReadyHostedSql();
    const rows = (await sql.query(
      "SELECT count(*) AS count FROM claimgraph_provider_leases WHERE expires_at > $1",
      [now.toISOString()]
    )) as Array<{ count: number | string }>;
    activeLeases = Number(rows[0]?.count ?? 0);
  } else {
    activeLeases = withClaimGraphDatabase((db) => {
      db.prepare("DELETE FROM public_beta_provider_leases WHERE expires_at <= ?")
        .run(now.toISOString());
      const row = db.prepare(
        "SELECT count(*) AS count FROM public_beta_provider_leases"
      ).get() as { count: number };
      return row.count;
    });
  }

  return {
    analysisEnabled: controls.analysisEnabled,
    activeLeases,
    limit: controls.providerConcurrency,
    available: controls.analysisEnabled && activeLeases < controls.providerConcurrency
  };
}

export async function pruneExpiredPublicBetaControlRecords(now = new Date()) {
  const timestamp = now.toISOString();

  if (getClaimGraphStorageDriver() === "hosted") {
    const sql = await getReadyHostedSql();
    await sql.transaction([
      sql.query("DELETE FROM claimgraph_rate_limit_buckets WHERE expires_at <= $1", [timestamp]),
      sql.query("DELETE FROM claimgraph_idempotency_keys WHERE expires_at <= $1", [timestamp]),
      sql.query("DELETE FROM claimgraph_provider_leases WHERE expires_at <= $1", [timestamp])
    ]);
    return;
  }

  withClaimGraphDatabase((db) => {
    const transaction = db.transaction(() => {
      db.prepare("DELETE FROM public_beta_rate_limit_buckets WHERE expires_at <= ?")
        .run(timestamp);
      db.prepare("DELETE FROM public_beta_idempotency_keys WHERE expires_at <= ?")
        .run(timestamp);
      db.prepare("DELETE FROM public_beta_provider_leases WHERE expires_at <= ?")
        .run(timestamp);
    });
    transaction.immediate();
  });
}

export class PublicBetaCapacityError extends Error {
  readonly status = 429;

  constructor(message: string) {
    super(message);
    this.name = "PublicBetaCapacityError";
  }
}
