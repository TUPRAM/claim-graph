import { createHash, timingSafeEqual } from "node:crypto";
import {
  hasStrongPublicBetaSecret,
  hasValidCanonicalPublicOrigin
} from "@/lib/server/public-beta-policy";
import { getReadyHostedSql } from "@/lib/server/storage/hosted-schema";
import { getNeonSql } from "@/lib/server/storage/neon-client";

export const STAGING_REHEARSAL_BARRIER_ACTIONS = [
  "pause_after_evidence_persistence",
  "pause_after_inventory_persistence"
] as const;

export const STAGING_REHEARSAL_FAULT_ACTIONS = [
  "fail_next_blob_deletion",
  "fail_next_db_cleanup_finalization"
] as const;

export const STAGING_REHEARSAL_ACTIONS = [
  ...STAGING_REHEARSAL_BARRIER_ACTIONS,
  ...STAGING_REHEARSAL_FAULT_ACTIONS
] as const;

export const STAGING_REHEARSAL_MUTATIONS = [
  ...STAGING_REHEARSAL_ACTIONS,
  "release_barriers"
] as const;

export type StagingRehearsalAction =
  (typeof STAGING_REHEARSAL_ACTIONS)[number];
export type StagingRehearsalBarrierAction =
  (typeof STAGING_REHEARSAL_BARRIER_ACTIONS)[number];
export type StagingRehearsalFaultAction =
  (typeof STAGING_REHEARSAL_FAULT_ACTIONS)[number];
export type StagingRehearsalMutation =
  (typeof STAGING_REHEARSAL_MUTATIONS)[number];

export const STAGING_REHEARSAL_DEFAULT_TTL_SECONDS = 180;
export const STAGING_REHEARSAL_MIN_TTL_SECONDS = 5;
export const STAGING_REHEARSAL_MAX_TTL_SECONDS = 10 * 60;

const STAGING_REHEARSAL_CONTROL_ID = "staging-rehearsal";
const STAGING_REHEARSAL_BINDING_ID = "staging-rehearsal";
const PUBLIC_PRODUCTION_ORIGIN = "https://claim-graph.vercel.app";
const actionSet = new Set<string>(STAGING_REHEARSAL_ACTIONS);

type RehearsalControlData = {
  version: 1;
  updatedAt: string;
} & Partial<Record<StagingRehearsalAction, string>>;

interface OperatorControlRow {
  data: string | Record<string, unknown>;
}

export type StagingRehearsalAvailabilityReason =
  | "ready"
  | "disabled"
  | "not_staging"
  | "invalid_canonical_origin"
  | "invalid_production_origin"
  | "production_origin"
  | "not_hosted_storage"
  | "missing_expected_database_hostname"
  | "invalid_database_url"
  | "database_hostname_mismatch"
  | "missing_expected_neon_project_id"
  | "missing_runtime_neon_project_id"
  | "neon_project_mismatch"
  | "missing_expected_blob_store_id"
  | "invalid_blob_read_write_token"
  | "blob_store_mismatch"
  | "invalid_vercel_project_production_url"
  | "vercel_origin_mismatch"
  | "missing_database_binding_secret"
  | "database_binding_unavailable"
  | "missing_database_binding"
  | "database_binding_mismatch";

export interface StagingRehearsalAvailability {
  enabled: boolean;
  reason: StagingRehearsalAvailabilityReason;
  deploymentRole: string | null;
  canonicalOrigin: string | null;
}

function normalizeOrigin(value: string | undefined) {
  const normalized = value?.trim().replace(/\/$/u, "");
  return normalized && hasValidCanonicalPublicOrigin(normalized)
    ? normalized
    : null;
}

function normalizeBlobStoreId(value: string | undefined) {
  const normalized = value?.trim() ?? "";
  const withoutPrefix = normalized.startsWith("store_")
    ? normalized.slice("store_".length)
    : normalized;

  return /^[a-zA-Z0-9]+$/u.test(withoutPrefix) ? withoutPrefix : null;
}

/** Mirrors the documented Vercel read-write token shape without exposing it. */
export function parseBlobStoreIdFromReadWriteToken(
  token: string | undefined
) {
  const parts = token?.trim().split("_") ?? [];

  if (
    parts.length < 5 ||
    parts[0] !== "vercel" ||
    parts[1] !== "blob" ||
    parts[2] !== "rw" ||
    !parts.slice(4).join("_")
  ) {
    return null;
  }

  return normalizeBlobStoreId(parts[3]);
}

function parseVercelProjectProductionHost(value: string | undefined) {
  const normalized = value?.trim();

  if (!normalized) {
    return null;
  }

  try {
    const url = new URL(
      normalized.includes("://") ? normalized : `https://${normalized}`
    );

    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
      ? url.host
      : null;
  } catch {
    return null;
  }
}

function parsePostgresHostname(value: string | undefined) {
  const normalized = value?.trim();

  if (!normalized) {
    return null;
  }

  try {
    const url = new URL(normalized);
    return (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
      url.hostname
      ? url.hostname.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

function normalizeExpectedDatabaseHostname(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();

  if (!normalized || normalized.includes(":") || normalized.includes("/")) {
    return null;
  }

  try {
    const parsed = new URL(`postgresql://${normalized}/`);
    return parsed.hostname === normalized ? normalized : null;
  } catch {
    return null;
  }
}

async function verifyDatabaseBinding(
  secret: string,
  env: NodeJS.ProcessEnv
): Promise<
  "verified" | "unavailable" | "missing" | "mismatch"
> {
  let rows: Array<{ secret_hash: string }>;

  try {
    const sql = await getNeonSql(env);
    rows = (await sql.query(
      `
        SELECT secret_hash
        FROM claimgraph_staging_rehearsal_bindings
        WHERE id = $1::text
      `,
      [STAGING_REHEARSAL_BINDING_ID]
    )) as Array<{ secret_hash: string }>;
  } catch {
    return "unavailable";
  }

  const storedHash = rows[0]?.secret_hash?.trim().toLowerCase();

  if (!storedHash) {
    return "missing";
  }

  if (!/^[0-9a-f]{64}$/u.test(storedHash)) {
    return "mismatch";
  }

  const expectedHash = createHash("sha256").update(secret, "utf8").digest();
  const actualHash = Buffer.from(storedHash, "hex");

  return actualHash.length === expectedHash.length &&
    timingSafeEqual(actualHash, expectedHash)
    ? "verified"
    : "mismatch";
}

/**
 * This is deliberately stricter than the normal deployment readiness gate.
 * Merely setting the deployment role is insufficient: the rehearsal flag and
 * an explicit non-production canonical origin are both required.
 */
export async function getStagingRehearsalAvailability(
  env: NodeJS.ProcessEnv = process.env
): Promise<StagingRehearsalAvailability> {
  const deploymentRole = env.CLAIMGRAPH_DEPLOYMENT_ROLE?.trim().toLowerCase() || null;
  const canonicalOrigin = normalizeOrigin(env.CLAIMGRAPH_PUBLIC_ORIGIN);
  const configuredProductionOrigin = env.CLAIMGRAPH_PRODUCTION_ORIGIN?.trim()
    ? normalizeOrigin(env.CLAIMGRAPH_PRODUCTION_ORIGIN)
    : PUBLIC_PRODUCTION_ORIGIN;

  if (env.CLAIMGRAPH_STAGING_REHEARSAL_ENABLED?.trim() !== "1") {
    return {
      enabled: false,
      reason: "disabled",
      deploymentRole,
      canonicalOrigin
    };
  }

  if (deploymentRole !== "staging") {
    return {
      enabled: false,
      reason: "not_staging",
      deploymentRole,
      canonicalOrigin
    };
  }

  if (!canonicalOrigin) {
    return {
      enabled: false,
      reason: "invalid_canonical_origin",
      deploymentRole,
      canonicalOrigin: null
    };
  }

  if (!configuredProductionOrigin) {
    return {
      enabled: false,
      reason: "invalid_production_origin",
      deploymentRole,
      canonicalOrigin
    };
  }

  if (
    canonicalOrigin === PUBLIC_PRODUCTION_ORIGIN ||
    canonicalOrigin === configuredProductionOrigin
  ) {
    return {
      enabled: false,
      reason: "production_origin",
      deploymentRole,
      canonicalOrigin
    };
  }

  if (env.CLAIMGRAPH_STORAGE_DRIVER?.trim().toLowerCase() !== "hosted") {
    return {
      enabled: false,
      reason: "not_hosted_storage",
      deploymentRole,
      canonicalOrigin
    };
  }

  const expectedDatabaseHostname = normalizeExpectedDatabaseHostname(
    env.CLAIMGRAPH_STAGING_REHEARSAL_EXPECTED_DATABASE_HOSTNAME
  );

  if (!expectedDatabaseHostname) {
    return {
      enabled: false,
      reason: "missing_expected_database_hostname",
      deploymentRole,
      canonicalOrigin
    };
  }

  const runtimeDatabaseHostname = parsePostgresHostname(env.DATABASE_URL);

  if (!runtimeDatabaseHostname) {
    return {
      enabled: false,
      reason: "invalid_database_url",
      deploymentRole,
      canonicalOrigin
    };
  }

  if (runtimeDatabaseHostname !== expectedDatabaseHostname) {
    return {
      enabled: false,
      reason: "database_hostname_mismatch",
      deploymentRole,
      canonicalOrigin
    };
  }

  const expectedNeonProjectId =
    env.CLAIMGRAPH_STAGING_REHEARSAL_EXPECTED_NEON_PROJECT_ID?.trim();

  if (!expectedNeonProjectId) {
    return {
      enabled: false,
      reason: "missing_expected_neon_project_id",
      deploymentRole,
      canonicalOrigin
    };
  }

  const runtimeNeonProjectId = env.NEON_PROJECT_ID?.trim();

  if (!runtimeNeonProjectId) {
    return {
      enabled: false,
      reason: "missing_runtime_neon_project_id",
      deploymentRole,
      canonicalOrigin
    };
  }

  if (runtimeNeonProjectId !== expectedNeonProjectId) {
    return {
      enabled: false,
      reason: "neon_project_mismatch",
      deploymentRole,
      canonicalOrigin
    };
  }

  const expectedBlobStoreId = normalizeBlobStoreId(
    env.CLAIMGRAPH_STAGING_REHEARSAL_EXPECTED_BLOB_STORE_ID
  );

  if (!expectedBlobStoreId) {
    return {
      enabled: false,
      reason: "missing_expected_blob_store_id",
      deploymentRole,
      canonicalOrigin
    };
  }

  const runtimeBlobStoreId = parseBlobStoreIdFromReadWriteToken(
    env.BLOB_READ_WRITE_TOKEN
  );

  if (!runtimeBlobStoreId) {
    return {
      enabled: false,
      reason: "invalid_blob_read_write_token",
      deploymentRole,
      canonicalOrigin
    };
  }

  if (runtimeBlobStoreId !== expectedBlobStoreId) {
    return {
      enabled: false,
      reason: "blob_store_mismatch",
      deploymentRole,
      canonicalOrigin
    };
  }

  const vercelProjectProductionUrl =
    env.VERCEL_PROJECT_PRODUCTION_URL?.trim();

  if (vercelProjectProductionUrl) {
    const vercelProductionHost = parseVercelProjectProductionHost(
      vercelProjectProductionUrl
    );

    if (!vercelProductionHost) {
      return {
        enabled: false,
        reason: "invalid_vercel_project_production_url",
        deploymentRole,
        canonicalOrigin
      };
    }

    if (vercelProductionHost !== new URL(canonicalOrigin).host) {
      return {
        enabled: false,
        reason: "vercel_origin_mismatch",
        deploymentRole,
        canonicalOrigin
      };
    }
  }

  const bindingSecret =
    env.CLAIMGRAPH_STAGING_REHEARSAL_BINDING_SECRET;

  if (!hasStrongPublicBetaSecret(bindingSecret)) {
    return {
      enabled: false,
      reason: "missing_database_binding_secret",
      deploymentRole,
      canonicalOrigin
    };
  }

  const binding = await verifyDatabaseBinding(bindingSecret!, env);

  if (binding !== "verified") {
    return {
      enabled: false,
      reason:
        binding === "unavailable"
          ? "database_binding_unavailable"
          : binding === "missing"
            ? "missing_database_binding"
            : "database_binding_mismatch",
      deploymentRole,
      canonicalOrigin
    };
  }

  return {
    enabled: true,
    reason: "ready",
    deploymentRole,
    canonicalOrigin
  };
}

export class StagingRehearsalUnavailableError extends Error {
  readonly status = 403;
  readonly reason: StagingRehearsalAvailabilityReason;

  constructor(availability: StagingRehearsalAvailability) {
    super(
      `Staging rehearsal controls are unavailable (${availability.reason}).`
    );
    this.name = "StagingRehearsalUnavailableError";
    this.reason = availability.reason;
  }
}

async function requireStagingRehearsalEnabled() {
  const availability = await getStagingRehearsalAvailability();

  if (!availability.enabled) {
    throw new StagingRehearsalUnavailableError(availability);
  }

  return availability;
}

function parseControlData(value: string | Record<string, unknown> | undefined) {
  let parsed: unknown = value;

  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      parsed = null;
    }
  }

  const data =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  const normalized: RehearsalControlData = {
    version: 1,
    updatedAt:
      typeof data.updatedAt === "string" && Number.isFinite(Date.parse(data.updatedAt))
        ? data.updatedAt
        : new Date(0).toISOString()
  };

  for (const action of STAGING_REHEARSAL_ACTIONS) {
    const expiresAt = data[action];

    if (typeof expiresAt === "string" && Number.isFinite(Date.parse(expiresAt))) {
      normalized[action] = expiresAt;
    }
  }

  return normalized;
}

function activeActions(data: RehearsalControlData, now: Date) {
  const nowMs = now.getTime();
  const actions: Partial<Record<StagingRehearsalAction, string>> = {};

  for (const action of STAGING_REHEARSAL_ACTIONS) {
    const expiresAt = data[action];

    if (expiresAt && Date.parse(expiresAt) > nowMs) {
      actions[action] = expiresAt;
    }
  }

  return actions;
}

async function readControlData() {
  const sql = await getReadyHostedSql();
  const rows = (await sql.query(
    "SELECT data FROM claimgraph_operator_controls WHERE id = $1",
    [STAGING_REHEARSAL_CONTROL_ID]
  )) as OperatorControlRow[];
  return parseControlData(rows[0]?.data);
}

function assertAction(value: string): asserts value is StagingRehearsalAction {
  if (!actionSet.has(value)) {
    throw new TypeError("Unsupported staging rehearsal action.");
  }
}

function normalizedTtlSeconds(value: number) {
  if (
    !Number.isInteger(value) ||
    value < STAGING_REHEARSAL_MIN_TTL_SECONDS ||
    value > STAGING_REHEARSAL_MAX_TTL_SECONDS
  ) {
    throw new RangeError(
      `Staging rehearsal TTL must be an integer from ${STAGING_REHEARSAL_MIN_TTL_SECONDS} to ${STAGING_REHEARSAL_MAX_TTL_SECONDS} seconds.`
    );
  }

  return value;
}

export async function getStagingRehearsalSnapshot(now = new Date()) {
  const availability = await getStagingRehearsalAvailability();

  if (!availability.enabled) {
    return {
      availability,
      actions: {},
      updatedAt: null
    };
  }

  const data = await readControlData();
  return {
    availability,
    actions: activeActions(data, now),
    updatedAt: data.updatedAt
  };
}

export async function activateStagingRehearsalAction(input: {
  action: StagingRehearsalAction;
  ttlSeconds?: number;
  now?: Date;
}) {
  await requireStagingRehearsalEnabled();
  assertAction(input.action);
  const ttlSeconds = normalizedTtlSeconds(
    input.ttlSeconds ?? STAGING_REHEARSAL_DEFAULT_TTL_SECONDS
  );
  const now = input.now ?? new Date();
  const updatedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1_000).toISOString();
  const patch: RehearsalControlData = {
    version: 1,
    updatedAt,
    [input.action]: expiresAt
  };

  const sql = await getReadyHostedSql();
  await sql.query(
    `
      INSERT INTO claimgraph_operator_controls (id, updated_at, data)
      VALUES ($1, $2, $3::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        updated_at = EXCLUDED.updated_at,
        data = claimgraph_operator_controls.data || EXCLUDED.data
    `,
    [STAGING_REHEARSAL_CONTROL_ID, updatedAt, JSON.stringify(patch)]
  );

  return getStagingRehearsalSnapshot(now);
}

export async function releaseStagingRehearsalBarriers(now = new Date()) {
  await requireStagingRehearsalEnabled();
  const updatedAt = now.toISOString();

  const sql = await getReadyHostedSql();
  await sql.query(
    `
      UPDATE claimgraph_operator_controls
      SET updated_at = $2::timestamptz,
          data = (data - 'pause_after_evidence_persistence'
                       - 'pause_after_inventory_persistence')
                 || jsonb_build_object(
                      'version', 1,
                      'updatedAt', $2::timestamptz
                    )
      WHERE id = $1
    `,
    [STAGING_REHEARSAL_CONTROL_ID, updatedAt]
  );

  return getStagingRehearsalSnapshot(now);
}

export async function isStagingRehearsalBarrierActive(
  action: StagingRehearsalBarrierAction,
  now = new Date()
) {
  if (!STAGING_REHEARSAL_BARRIER_ACTIONS.includes(action)) {
    return false;
  }

  if (!(await getStagingRehearsalAvailability()).enabled) {
    return false;
  }

  const data = await readControlData();
  const expiresAt = data[action];
  return Boolean(expiresAt && Date.parse(expiresAt) > now.getTime());
}

/** Atomically consumes one short-lived fault. Exactly one caller can win. */
export async function consumeStagingRehearsalFault(
  action: StagingRehearsalFaultAction,
  now = new Date()
) {
  if (!STAGING_REHEARSAL_FAULT_ACTIONS.includes(action)) {
    return false;
  }

  if (!(await getStagingRehearsalAvailability()).enabled) {
    return false;
  }

  const updatedAt = now.toISOString();

  const sql = await getReadyHostedSql();
  const rows = (await sql.query(
    `
      UPDATE claimgraph_operator_controls
      SET updated_at = $3::timestamptz,
          data = (data - $2::text)
                 || jsonb_build_object(
                      'version', 1,
                      'updatedAt', $3::timestamptz
                    )
      WHERE id = $1
        AND CASE
          WHEN jsonb_typeof(data -> $2::text) = 'string'
            THEN (data ->> $2::text)::timestamptz > $3::timestamptz
          ELSE false
        END
      RETURNING id
    `,
    [STAGING_REHEARSAL_CONTROL_ID, action, updatedAt]
  )) as Array<{ id: string }>;
  return rows.length === 1;
}

export class StagingRehearsalInjectedFailure extends Error {
  readonly action: StagingRehearsalFaultAction;

  constructor(action: StagingRehearsalFaultAction) {
    super(`Staging rehearsal injected ${action}.`);
    this.name = "StagingRehearsalInjectedFailure";
    this.action = action;
  }
}

export async function throwIfStagingRehearsalFault(
  action: StagingRehearsalFaultAction
) {
  if (await consumeStagingRehearsalFault(action)) {
    throw new StagingRehearsalInjectedFailure(action);
  }
}
