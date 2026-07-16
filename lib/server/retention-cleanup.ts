import { randomUUID } from "node:crypto";
import { getWorkspaceDeletionCleanupJobId } from "@/lib/server/cleanup-job-identity";
import {
  deleteHostedWorkspaceObjectPrefix,
  deletePersistedWorkspaceObject,
  type ClaimGraphObjectStorageProvider
} from "@/lib/server/object-storage";
import { getPublicBetaPolicy } from "@/lib/server/public-beta-policy";
import {
  deleteWorkspaceExportsDir,
  deleteWorkspaceUploadsDir
} from "@/lib/server/runtime-data";
import { getClaimGraphStorageDriver } from "@/lib/server/storage/config";
import { getReadyHostedSql } from "@/lib/server/storage/hosted-schema";
import { getClaimGraphStore } from "@/lib/server/storage/store-factory";
import { withClaimGraphDatabase } from "@/lib/server/database";
import { pruneExpiredPublicBetaControlRecords } from "@/lib/server/public-beta-control-store";
import { throwIfStagingRehearsalFault } from "@/lib/server/staging-rehearsal";
import { tryRecordOperationalEvent } from "@/lib/server/operational-events";

export type CleanupJobType =
  | "workspace_delete"
  | "abandoned_workspace_delete"
  | "qa_workspace_delete"
  | "upload_delete"
  | "export_delete"
  | "orphan_object_delete";

export type CleanupJobStatus =
  | "pending"
  | "running"
  | "failed"
  | "completed"
  | "dead";

export interface CleanupJob {
  id: string;
  workspaceId: string | null;
  runId: string | null;
  jobType: CleanupJobType;
  status: CleanupJobStatus;
  createdAt: string;
  attemptedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  attemptCount: number;
  nextAttemptAt: string;
  leaseExpiresAt: string | null;
  data: CleanupJobData;
}

export interface CleanupJobData {
  reason: string;
  storageProvider?: ClaimGraphObjectStorageProvider;
  objectKey?: string;
  objectKind?: "source" | "export";
  fileId?: string;
  retentionMs?: number;
  invalidateArtifacts?: boolean;
}

interface CleanupJobRow {
  id: string;
  workspace_id: string | null;
  run_id: string | null;
  job_type: CleanupJobType;
  status: CleanupJobStatus;
  created_at: string | Date;
  attempted_at: string | Date | null;
  completed_at: string | Date | null;
  error_message: string | null;
  attempt_count: number | string;
  next_attempt_at: string | Date;
  lease_expires_at: string | Date | null;
  data: string | CleanupJobData;
}

function iso(value: string | Date | null) {
  if (value == null) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizeJob(row: CleanupJobRow): CleanupJob {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    jobType: row.job_type,
    status: row.status,
    createdAt: iso(row.created_at)!,
    attemptedAt: iso(row.attempted_at),
    completedAt: iso(row.completed_at),
    errorMessage: row.error_message,
    attemptCount: Number(row.attempt_count),
    nextAttemptAt: iso(row.next_attempt_at)!,
    leaseExpiresAt: iso(row.lease_expires_at),
    data:
      typeof row.data === "string"
        ? (JSON.parse(row.data) as CleanupJobData)
        : row.data
  };
}

function rowColumns(alias?: string) {
  const prefix = alias ? `${alias}.` : "";

  return `
    ${prefix}id, ${prefix}workspace_id, ${prefix}run_id, ${prefix}job_type,
    ${prefix}status, ${prefix}created_at, ${prefix}attempted_at,
    ${prefix}completed_at, ${prefix}error_message, ${prefix}attempt_count,
    ${prefix}next_attempt_at, ${prefix}lease_expires_at, ${prefix}data
  `;
}

export async function enqueueCleanupJob(input: {
  id?: string;
  workspaceId?: string | null;
  runId?: string | null;
  jobType: CleanupJobType;
  dueAt: Date;
  data: CleanupJobData;
  now?: Date;
}) {
  const job: CleanupJob = {
    id: input.id ?? randomUUID(),
    workspaceId: input.workspaceId ?? null,
    runId: input.runId ?? null,
    jobType: input.jobType,
    status: "pending",
    createdAt: (input.now ?? new Date()).toISOString(),
    attemptedAt: null,
    completedAt: null,
    errorMessage: null,
    attemptCount: 0,
    nextAttemptAt: input.dueAt.toISOString(),
    leaseExpiresAt: null,
    data: input.data
  };

  if (getClaimGraphStorageDriver() === "hosted") {
    const sql = await getReadyHostedSql();
    const rows = (await sql.query(
      `
        INSERT INTO claimgraph_cleanup_jobs
          (
            id, workspace_id, run_id, job_type, status, created_at,
            attempt_count, next_attempt_at, data
          )
        VALUES ($1, $2, $3, $4, 'pending', $5, 0, $6, $7::jsonb)
        ON CONFLICT (id) DO UPDATE
          SET next_attempt_at = EXCLUDED.next_attempt_at,
              data = EXCLUDED.data
          WHERE claimgraph_cleanup_jobs.status IN ('pending', 'failed')
        RETURNING ${rowColumns()}
      `,
      [
        job.id,
        job.workspaceId,
        job.runId,
        job.jobType,
        job.createdAt,
        job.nextAttemptAt,
        JSON.stringify(job.data)
      ]
    )) as CleanupJobRow[];
    return rows[0] ? normalizeJob(rows[0]) : null;
  }

  return withClaimGraphDatabase((db) => {
    db.prepare(`
      INSERT INTO cleanup_jobs
        (
          id, workspace_id, run_id, job_type, status, created_at,
          attempt_count, next_attempt_at, data
        )
      VALUES (?, ?, ?, ?, 'pending', ?, 0, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        next_attempt_at = excluded.next_attempt_at,
        data = excluded.data
      WHERE cleanup_jobs.status IN ('pending', 'failed')
    `).run(
      job.id,
      job.workspaceId,
      job.runId,
      job.jobType,
      job.createdAt,
      job.nextAttemptAt,
      JSON.stringify(job.data)
    );
    const row = db.prepare(`SELECT ${rowColumns()} FROM cleanup_jobs WHERE id = ?`)
      .get(job.id) as CleanupJobRow | undefined;
    return row ? normalizeJob(row) : null;
  });
}

export function scheduleWorkspaceRetention(input: {
  workspaceId: string;
  qa?: boolean;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const policy = getPublicBetaPolicy();
  const retentionMs = input.qa
    ? policy.retention.qaWorkspaceMs
    : policy.retention.abandonedWorkspaceMs;

  return enqueueCleanupJob({
    id: `${input.qa ? "qa" : "abandoned"}-workspace:${input.workspaceId}`,
    workspaceId: input.workspaceId,
    jobType: input.qa ? "qa_workspace_delete" : "abandoned_workspace_delete",
    dueAt: new Date(now.getTime() + retentionMs),
    now,
    data: {
      reason: input.qa ? "qa_workspace_ttl" : "abandoned_workspace_ttl",
      retentionMs
    }
  });
}

export function enqueueWorkspaceDeletionCleanup(input: {
  workspaceId: string;
  reason?: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();

  return enqueueCleanupJob({
    id: getWorkspaceDeletionCleanupJobId(input.workspaceId),
    workspaceId: input.workspaceId,
    jobType: "workspace_delete",
    dueAt: now,
    now,
    data: {
      reason: input.reason ?? "owner_requested_workspace_deletion"
    }
  });
}

export function enqueueUploadDeletion(input: {
  workspaceId: string;
  fileId: string;
  storageProvider: ClaimGraphObjectStorageProvider;
  objectKey: string;
  reason?: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();

  return enqueueCleanupJob({
    id: `upload:${input.fileId}`,
    workspaceId: input.workspaceId,
    jobType: "upload_delete",
    dueAt: now,
    now,
    data: {
      reason: input.reason ?? "owner_requested_upload_deletion",
      storageProvider: input.storageProvider,
      objectKey: input.objectKey,
      objectKind: "source",
      fileId: input.fileId,
      invalidateArtifacts: true
    }
  });
}

export function scheduleUploadRetention(input: {
  workspaceId: string;
  fileId: string;
  storageProvider: ClaimGraphObjectStorageProvider;
  objectKey: string;
  uploadedAt?: Date;
}) {
  const uploadedAt = input.uploadedAt ?? new Date();
  const retentionMs = getPublicBetaPolicy().retention.uploadedObjectMs;

  return enqueueCleanupJob({
    id: `upload:${input.fileId}`,
    workspaceId: input.workspaceId,
    jobType: "upload_delete",
    dueAt: new Date(uploadedAt.getTime() + retentionMs),
    now: uploadedAt,
    data: {
      reason: "upload_ttl",
      storageProvider: input.storageProvider,
      objectKey: input.objectKey,
      objectKind: "source",
      fileId: input.fileId,
      retentionMs,
      invalidateArtifacts: true
    }
  });
}

export function scheduleExportRetention(input: {
  workspaceId: string;
  storageProvider: ClaimGraphObjectStorageProvider;
  objectKey: string;
  createdAt?: Date;
}) {
  const createdAt = input.createdAt ?? new Date();
  const retentionMs = getPublicBetaPolicy().retention.generatedExportMs;

  return enqueueCleanupJob({
    workspaceId: input.workspaceId,
    jobType: "export_delete",
    dueAt: new Date(createdAt.getTime() + retentionMs),
    now: createdAt,
    data: {
      reason: "generated_export_ttl",
      storageProvider: input.storageProvider,
      objectKey: input.objectKey,
      objectKind: "export",
      retentionMs
    }
  });
}

/** Used when object persistence succeeded but the owning database mutation did not. */
export function enqueueOrphanObjectCleanup(input: {
  workspaceId: string;
  storageProvider: ClaimGraphObjectStorageProvider;
  objectKey: string;
  objectKind: "source" | "export";
  reason?: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();

  return enqueueCleanupJob({
    workspaceId: input.workspaceId,
    jobType: "orphan_object_delete",
    dueAt: now,
    now,
    data: {
      reason: input.reason ?? "database_persistence_failed_after_object_write",
      storageProvider: input.storageProvider,
      objectKey: input.objectKey,
      objectKind: input.objectKind
    }
  });
}

async function claimDueCleanupJobs(now: Date, limit: number) {
  const leaseExpiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();

  if (getClaimGraphStorageDriver() === "hosted") {
    const sql = await getReadyHostedSql();
    const rows = (await sql.query(
      `
        WITH candidates AS (
          SELECT id
          FROM claimgraph_cleanup_jobs
          WHERE (
              status IN ('pending', 'failed')
              AND next_attempt_at <= $1
              AND (lease_expires_at IS NULL OR lease_expires_at <= $1)
            ) OR (
              status = 'running'
              AND (lease_expires_at IS NULL OR lease_expires_at <= $1)
            )
          ORDER BY next_attempt_at ASC, created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $2
        )
        UPDATE claimgraph_cleanup_jobs AS job
        SET status = 'running',
            attempted_at = $1,
            attempt_count = job.attempt_count + 1,
            lease_expires_at = $3,
            error_message = null
        FROM candidates
        WHERE job.id = candidates.id
        RETURNING ${rowColumns("job")}
      `,
      [now.toISOString(), limit, leaseExpiresAt]
    )) as CleanupJobRow[];
    return rows.map(normalizeJob);
  }

  return withClaimGraphDatabase((db) => {
    const transaction = db.transaction(() => {
      const rows = db.prepare(`
        SELECT ${rowColumns()}
        FROM cleanup_jobs
        WHERE (
            status IN ('pending', 'failed')
            AND next_attempt_at <= ?
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
          ) OR (
            status = 'running'
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
          )
        ORDER BY next_attempt_at ASC, created_at ASC
        LIMIT ?
      `).all(
        now.toISOString(),
        now.toISOString(),
        now.toISOString(),
        limit
      ) as CleanupJobRow[];
      const claim = db.prepare(`
        UPDATE cleanup_jobs
        SET status = 'running', attempted_at = ?, attempt_count = attempt_count + 1,
            lease_expires_at = ?, error_message = NULL
        WHERE id = ? AND (
          status IN ('pending', 'failed')
          OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
        )
      `);
      const claimed: CleanupJob[] = [];

      for (const row of rows) {
        if (
          claim.run(
            now.toISOString(),
            leaseExpiresAt,
            row.id,
            now.toISOString()
          ).changes === 1
        ) {
          claimed.push(
            normalizeJob({
              ...row,
              status: "running",
              attempted_at: now.toISOString(),
              attempt_count: Number(row.attempt_count) + 1,
              lease_expires_at: leaseExpiresAt,
              error_message: null
            })
          );
        }
      }

      return claimed;
    });

    return transaction.immediate();
  });
}

async function completeCleanupJob(id: string, now: Date) {
  if (getClaimGraphStorageDriver() === "hosted") {
    const sql = await getReadyHostedSql();
    await sql.query(
      `
        UPDATE claimgraph_cleanup_jobs
        SET status = 'completed', completed_at = $2, lease_expires_at = null,
            error_message = null
        WHERE id = $1
      `,
      [id, now.toISOString()]
    );
    return;
  }

  withClaimGraphDatabase((db) => {
    db.prepare(`
      UPDATE cleanup_jobs
      SET status = 'completed', completed_at = ?, lease_expires_at = NULL,
          error_message = NULL
      WHERE id = ?
    `).run(now.toISOString(), id);
  });
}

async function deferCleanupJob(id: string, nextAttemptAt: Date) {
  if (getClaimGraphStorageDriver() === "hosted") {
    const sql = await getReadyHostedSql();
    await sql.query(
      `
        UPDATE claimgraph_cleanup_jobs
        SET status = 'pending', next_attempt_at = $2, lease_expires_at = null
        WHERE id = $1
      `,
      [id, nextAttemptAt.toISOString()]
    );
    return;
  }

  withClaimGraphDatabase((db) => {
    db.prepare(`
      UPDATE cleanup_jobs
      SET status = 'pending', next_attempt_at = ?, lease_expires_at = NULL
      WHERE id = ?
    `).run(nextAttemptAt.toISOString(), id);
  });
}

async function failCleanupJob(job: CleanupJob, error: unknown, now: Date) {
  const maxAttempts = getPublicBetaPolicy().retention.maxCleanupAttempts;
  const terminal = job.attemptCount >= maxAttempts;
  const retryDelayMs = Math.min(
    24 * 60 * 60_000,
    60_000 * 2 ** Math.min(job.attemptCount - 1, 10)
  );
  const status: CleanupJobStatus = terminal ? "dead" : "failed";
  const errorMessage = error instanceof Error ? error.message : "Cleanup failed.";
  const nextAttemptAt = new Date(now.getTime() + retryDelayMs).toISOString();

  if (getClaimGraphStorageDriver() === "hosted") {
    const sql = await getReadyHostedSql();
    await sql.query(
      `
        UPDATE claimgraph_cleanup_jobs
        SET status = $2, error_message = $3, next_attempt_at = $4,
            lease_expires_at = null
        WHERE id = $1
      `,
      [job.id, status, errorMessage, nextAttemptAt]
    );
    return status;
  }

  withClaimGraphDatabase((db) => {
    db.prepare(`
      UPDATE cleanup_jobs
      SET status = ?, error_message = ?, next_attempt_at = ?, lease_expires_at = NULL
      WHERE id = ?
    `).run(status, errorMessage, nextAttemptAt, job.id);
  });
  return status;
}

async function processCleanupJob(job: CleanupJob, now: Date) {
  const store = await getClaimGraphStore();

  if (
    job.jobType === "workspace_delete" ||
    job.jobType === "abandoned_workspace_delete" ||
    job.jobType === "qa_workspace_delete"
  ) {
    if (!job.workspaceId) {
      throw new Error("Workspace cleanup job is missing workspaceId.");
    }

    const workspace = await store.getWorkspace(job.workspaceId);

    if (!workspace) {
      if (
        job.jobType === "workspace_delete" &&
        getClaimGraphStorageDriver() === "hosted"
      ) {
        // Owner deletion tombstones the workspace before Blob cleanup. Keep the
        // tombstone and this retry row until the external prefix is gone, then
        // physically purge the database row (which may cascade this job).
        await throwIfStagingRehearsalFault("fail_next_blob_deletion");
        await deleteHostedWorkspaceObjectPrefix(job.workspaceId);
        await throwIfStagingRehearsalFault(
          "fail_next_db_cleanup_finalization"
        );
        await store.deleteWorkspace(job.workspaceId);
      } else {
        await throwIfStagingRehearsalFault(
          "fail_next_db_cleanup_finalization"
        );
      }

      await completeCleanupJob(job.id, now);
      return "completed" as const;
    }

    const activeRun = await store.getActiveRunForWorkspace(job.workspaceId);

    if (activeRun) {
      await deferCleanupJob(job.id, new Date(now.getTime() + 60 * 60_000));
      return "deferred" as const;
    }

    if (job.jobType === "abandoned_workspace_delete") {
      const retentionMs = job.data.retentionMs ??
        getPublicBetaPolicy().retention.abandonedWorkspaceMs;
      const dueAt = new Date(Date.parse(workspace.updatedAt) + retentionMs);

      if (dueAt.getTime() > now.getTime()) {
        await deferCleanupJob(job.id, dueAt);
        return "deferred" as const;
      }
    }

    if (getClaimGraphStorageDriver() === "hosted") {
      await throwIfStagingRehearsalFault("fail_next_blob_deletion");
      await deleteHostedWorkspaceObjectPrefix(job.workspaceId);
    } else {
      deleteWorkspaceUploadsDir(job.workspaceId);
      deleteWorkspaceExportsDir(job.workspaceId);
    }

    await throwIfStagingRehearsalFault(
      "fail_next_db_cleanup_finalization"
    );
    await store.deleteWorkspace(job.workspaceId);
    // The cleanup row may be cascade-deleted with the workspace. This update is
    // intentionally idempotent when no row remains.
    await completeCleanupJob(job.id, now);
    return "completed" as const;
  }

  if (!job.workspaceId || !job.data.storageProvider || !job.data.objectKey) {
    throw new Error("Object cleanup job is missing its persisted object identity.");
  }

  if (job.jobType === "upload_delete") {
    const activeRun = await store.getActiveRunForWorkspace(job.workspaceId);

    if (activeRun) {
      await deferCleanupJob(job.id, new Date(now.getTime() + 60 * 60_000));
      return "deferred" as const;
    }

    if (job.data.fileId) {
      const files = await store.getWorkspaceFiles(job.workspaceId);
      const fileStillExists = files.some((file) => file.id === job.data.fileId);

      if (fileStillExists) {
        const removal = await store.removeWorkspaceFileIfNoActiveRun(
          job.workspaceId,
          job.data.fileId,
          {
            invalidateArtifacts: job.data.invalidateArtifacts === true,
            statusMessage:
              "An uploaded source was deleted or reached its retention limit. Previous live artifacts were cleared; rebuild from the remaining sources."
          }
        );

        if (!removal.applied) {
          await deferCleanupJob(job.id, new Date(now.getTime() + 60 * 60_000));
          return "deferred" as const;
        }
      }
    }
  }

  if (job.data.storageProvider === "vercel_blob") {
    await throwIfStagingRehearsalFault("fail_next_blob_deletion");
  }

  await deletePersistedWorkspaceObject({
    workspaceId: job.workspaceId,
    storageProvider: job.data.storageProvider,
    key: job.data.objectKey,
    kind: job.data.objectKind ?? "export"
  });

  await throwIfStagingRehearsalFault(
    "fail_next_db_cleanup_finalization"
  );
  await completeCleanupJob(job.id, now);
  return "completed" as const;
}

export async function runDueCleanupJobs(input?: {
  now?: Date;
  limit?: number;
}) {
  const now = input?.now ?? new Date();
  await pruneExpiredPublicBetaControlRecords(now);
  const limit = Math.max(
    1,
    Math.min(
      input?.limit ?? getPublicBetaPolicy().retention.cleanupBatchSize,
      100
    )
  );
  const jobs = await claimDueCleanupJobs(now, limit);
  const results: Array<{
    id: string;
    status: "completed" | "deferred" | "failed";
    error?: string;
  }> = [];
  let deadFailureCount = 0;

  for (const job of jobs) {
    try {
      const status = await processCleanupJob(job, now);
      results.push({ id: job.id, status });
    } catch (error) {
      const failureStatus = await failCleanupJob(job, error, now);
      if (failureStatus === "dead") {
        deadFailureCount += 1;
      }
      results.push({
        id: job.id,
        status: "failed",
        error: error instanceof Error ? error.message : "Cleanup failed."
      });
    }
  }

  const completedCount = results.filter(
    (result) => result.status === "completed"
  ).length;
  const failedCount = results.filter((result) => result.status === "failed").length;

  if (completedCount > 0) {
    await tryRecordOperationalEvent({
      eventType: "cleanup-job-completed",
      value: completedCount,
      now
    });
  }
  if (failedCount - deadFailureCount > 0) {
    await tryRecordOperationalEvent({
      eventType: "cleanup-job-failed",
      value: failedCount - deadFailureCount,
      now
    });
  }
  if (deadFailureCount > 0) {
    await tryRecordOperationalEvent({
      eventType: "cleanup-job-dead",
      value: deadFailureCount,
      now
    });
  }

  return {
    claimedCount: jobs.length,
    completedCount,
    deferredCount: results.filter((result) => result.status === "deferred").length,
    failedCount,
    results
  };
}

export async function getCleanupBacklogSummary(now = new Date()) {
  const timestamp = now.toISOString();

  if (getClaimGraphStorageDriver() === "hosted") {
    const sql = await getReadyHostedSql();
    const rows = (await sql.query(
      `
        SELECT
          count(*) FILTER (
            WHERE status IN ('pending', 'failed', 'running')
              AND next_attempt_at <= $1
              AND (status <> 'running' OR lease_expires_at IS NULL OR lease_expires_at <= $1)
          ) AS due_count,
          count(*) FILTER (WHERE status = 'failed') AS failed_count,
          count(*) FILTER (WHERE status = 'dead') AS dead_count,
          min(next_attempt_at) FILTER (
            WHERE status IN ('pending', 'failed', 'running')
              AND next_attempt_at <= $1
              AND (status <> 'running' OR lease_expires_at IS NULL OR lease_expires_at <= $1)
          ) AS oldest_due_at
        FROM claimgraph_cleanup_jobs
      `,
      [timestamp]
    )) as Array<{
      due_count: number | string;
      failed_count: number | string;
      dead_count: number | string;
      oldest_due_at: string | Date | null;
    }>;
    const row = rows[0];
    return {
      dueCount: Number(row?.due_count ?? 0),
      failedCount: Number(row?.failed_count ?? 0),
      deadCount: Number(row?.dead_count ?? 0),
      oldestDueAt: row?.oldest_due_at ? iso(row.oldest_due_at) : null
    };
  }

  return withClaimGraphDatabase((db) => {
    const row = db.prepare(`
      SELECT
        sum(CASE WHEN
          status IN ('pending', 'failed', 'running')
          AND next_attempt_at <= ?
          AND (status <> 'running' OR lease_expires_at IS NULL OR lease_expires_at <= ?)
          THEN 1 ELSE 0 END
        ) AS due_count,
        sum(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
        sum(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) AS dead_count,
        min(CASE WHEN
          status IN ('pending', 'failed', 'running')
          AND next_attempt_at <= ?
          AND (status <> 'running' OR lease_expires_at IS NULL OR lease_expires_at <= ?)
          THEN next_attempt_at ELSE NULL END
        ) AS oldest_due_at
      FROM cleanup_jobs
    `).get(timestamp, timestamp, timestamp, timestamp) as {
      due_count: number | null;
      failed_count: number | null;
      dead_count: number | null;
      oldest_due_at: string | null;
    };

    return {
      dueCount: Number(row.due_count ?? 0),
      failedCount: Number(row.failed_count ?? 0),
      deadCount: Number(row.dead_count ?? 0),
      oldestDueAt: row.oldest_due_at
    };
  });
}

export async function drainDueCleanupJobs(input?: {
  maxJobs?: number;
  maxDurationMs?: number;
}) {
  const policy = getPublicBetaPolicy();
  const maxJobs = Math.max(
    1,
    Math.min(input?.maxJobs ?? policy.retention.cleanupDrainLimit, 5_000)
  );
  const maxDurationMs = Math.max(
    1_000,
    Math.min(
      input?.maxDurationMs ?? policy.retention.cleanupMaxDurationMs,
      240_000
    )
  );
  const startedAtMs = Date.now();
  const aggregate = {
    claimedCount: 0,
    completedCount: 0,
    deferredCount: 0,
    failedCount: 0,
    results: [] as Array<{
      id: string;
      status: "completed" | "deferred" | "failed";
      error?: string;
    }>
  };

  while (
    aggregate.claimedCount < maxJobs &&
    Date.now() - startedAtMs < maxDurationMs
  ) {
    const remaining = maxJobs - aggregate.claimedCount;
    const result = await runDueCleanupJobs({
      limit: Math.min(policy.retention.cleanupBatchSize, remaining)
    });

    aggregate.claimedCount += result.claimedCount;
    aggregate.completedCount += result.completedCount;
    aggregate.deferredCount += result.deferredCount;
    aggregate.failedCount += result.failedCount;
    aggregate.results.push(...result.results);

    if (result.claimedCount === 0) {
      break;
    }
  }

  await tryRecordOperationalEvent({
    eventType: "cleanup-heartbeat",
    value: aggregate.claimedCount
  });

  return {
    ...aggregate,
    durationMs: Date.now() - startedAtMs,
    reachedJobLimit: aggregate.claimedCount >= maxJobs,
    reachedTimeLimit: Date.now() - startedAtMs >= maxDurationMs,
    backlog: await getCleanupBacklogSummary()
  };
}

export async function retryCleanupJob(id: string, now = new Date()) {
  if (getClaimGraphStorageDriver() === "hosted") {
    const sql = await getReadyHostedSql();
    const rows = (await sql.query(
      `
        UPDATE claimgraph_cleanup_jobs
        SET status = 'pending', next_attempt_at = $2, lease_expires_at = null,
            error_message = null
        WHERE id = $1 AND status IN ('failed', 'dead')
        RETURNING ${rowColumns()}
      `,
      [id, now.toISOString()]
    )) as CleanupJobRow[];
    return rows[0] ? normalizeJob(rows[0]) : null;
  }

  return withClaimGraphDatabase((db) => {
    db.prepare(`
      UPDATE cleanup_jobs
      SET status = 'pending', next_attempt_at = ?, lease_expires_at = NULL,
          error_message = NULL
      WHERE id = ? AND status IN ('failed', 'dead')
    `).run(now.toISOString(), id);
    const row = db.prepare(`SELECT ${rowColumns()} FROM cleanup_jobs WHERE id = ?`)
      .get(id) as CleanupJobRow | undefined;
    return row ? normalizeJob(row) : null;
  });
}

export function completeScheduledCleanupJob(id: string, now = new Date()) {
  return completeCleanupJob(id, now);
}

export async function listCleanupJobs(input?: {
  statuses?: CleanupJobStatus[];
  limit?: number;
}) {
  const statuses = input?.statuses?.length
    ? input.statuses
    : ["pending", "running", "failed", "dead"] satisfies CleanupJobStatus[];
  const limit = Math.max(1, Math.min(input?.limit ?? 100, 250));

  if (getClaimGraphStorageDriver() === "hosted") {
    const sql = await getReadyHostedSql();
    const rows = (await sql.query(
      `
        SELECT ${rowColumns()}
        FROM claimgraph_cleanup_jobs
        WHERE status = ANY($1)
        ORDER BY next_attempt_at ASC, created_at ASC
        LIMIT $2
      `,
      [statuses, limit]
    )) as CleanupJobRow[];
    return rows.map(normalizeJob);
  }

  return withClaimGraphDatabase((db) => {
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = db.prepare(`
      SELECT ${rowColumns()}
      FROM cleanup_jobs
      WHERE status IN (${placeholders})
      ORDER BY next_attempt_at ASC, created_at ASC
      LIMIT ?
    `).all(...statuses, limit) as CleanupJobRow[];
    return rows.map(normalizeJob);
  });
}
