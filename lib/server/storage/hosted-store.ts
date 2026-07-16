import { buildStarterDataset } from "@/lib/demo/graph-template";
import { computeRunMetrics } from "@/lib/graph/score";
import { repairLiveGraphDisagreementClusters } from "@/lib/graph/live-assembly";
import { stabilizeClaimInventory } from "@/lib/pipeline/claim-inventory";
import { enhanceGraphReviewLabels } from "@/lib/provenance/source-notes";
import {
  CURRENT_WORKSPACE_GRAPH_RECORD_VERSION,
  normalizeClaimInventoryRecord,
  normalizeEvidencePackRecord,
  normalizeWorkspaceGraphRecord,
  tryNormalizeClaimInventoryRecord,
  tryNormalizeEvidencePackRecord,
  tryNormalizeWorkspaceGraphRecord
} from "@/lib/validation/persisted-artifacts";
import { validateClaimGraphArtifacts } from "@/lib/validation/claim-graph";
import {
  getClaimGraphRuntimeConfig,
  getClaimGraphRuntimeInfo
} from "@/lib/claimgraph/config";
import { getReadyHostedSql as getReadySql } from "@/lib/server/storage/hosted-schema";
import { getWorkspaceDeletionCleanupJobId } from "@/lib/server/cleanup-job-identity";
import {
  buildSyntheticDemoRun,
  buildSyntheticDemoWorkspace,
  isSyntheticDemoRunId,
  isSyntheticDemoWorkspaceId,
  SYNTHETIC_DEMO_RUN_ID,
  SYNTHETIC_DEMO_TIMESTAMP
} from "@/lib/server/synthetic-demo-run";
import type {
  ClaimInventoryRecord,
  EvidencePackRecord,
  Run,
  RunStage,
  Workspace,
  WorkspaceAlphaAssessment,
  WorkspaceFile,
  WorkspaceGraphPayload,
  WorkspaceGraphRecord
} from "@/types/claimgraph";
import type {
  ClaimGraphStore,
  DeleteWorkspaceIfNoActiveRunResult,
  GuardedWorkspaceFileAddResult,
  GuardedWorkspaceFileRemoveOptions,
  GuardedWorkspaceFileRemoveResult,
  WorkspaceExportEventInput
} from "@/lib/server/storage/claimgraph-store";

type JsonRow<T = unknown> = { data: T };
type StoredRunRow = JsonRow & { version: number | string };
type ArtifactType =
  | "evidence_pack"
  | "claim_inventory"
  | "retrieval_state"
  | "workspace_alpha_assessment";

const ACTIVE_RUN_STATUSES: Run["status"][] = [
  "queued",
  "ingesting",
  "gathering",
  "extracting",
  "assembling"
];
const RUN_CAS_MAX_ATTEMPTS = 8;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function nowIso() {
  return new Date().toISOString();
}

function encodeJson(value: unknown) {
  return JSON.stringify(value);
}

function decodeJson<T>(value: unknown): T {
  if (typeof value === "string") {
    return JSON.parse(value) as T;
  }

  return clone(value as T);
}

export function normalizeHostedTimestampForColumn(value: string | undefined) {
  const normalized = value?.trim();

  if (!normalized) {
    return null;
  }

  const parsed = Date.parse(normalized);

  if (Number.isNaN(parsed)) {
    return null;
  }

  return new Date(parsed).toISOString();
}

function isRunStage(value: Run["status"]): value is RunStage {
  return value === "queued" ||
    value === "ingesting" ||
    value === "gathering" ||
    value === "extracting" ||
    value === "assembling";
}

function buildQueuedRun(workspaceId: string, staleAfterMs: number) {
  const createdAt = nowIso();
  const run: Run = {
    id: crypto.randomUUID(),
    workspaceId,
    status: "queued",
    createdAt,
    statusMessage: "Run queued.",
    observability: {
      stages: [],
      exportEvents: [],
      retrievalCleanupEvents: [],
      providerFailureEvents: [],
      execution: {
        mode: "in_process",
        scheduledAt: createdAt,
        staleAfterMs
      }
    }
  };

  openStage(run, "queued", createdAt);
  return run;
}

function ensureRunObservability(run: Run) {
  if (!run.observability) {
    run.observability = {
      stages: [],
      exportEvents: [],
      retrievalCleanupEvents: [],
      providerFailureEvents: []
    };
  }

  run.observability.retrievalCleanupEvents ??= [];
  run.observability.providerFailureEvents ??= [];

  return run.observability;
}

function closeOpenStage(run: Run, completedAt = nowIso()) {
  const observability = ensureRunObservability(run);
  const activeStage = [...observability.stages]
    .reverse()
    .find((stage) => !stage.completedAt);

  if (!activeStage) {
    return;
  }

  activeStage.completedAt = completedAt;
  activeStage.durationMs = Math.max(
    0,
    new Date(completedAt).getTime() - new Date(activeStage.startedAt).getTime()
  );
}

function openStage(run: Run, stage: RunStage, startedAt = nowIso()) {
  const observability = ensureRunObservability(run);
  const activeStage = [...observability.stages]
    .reverse()
    .find((item) => !item.completedAt);

  if (activeStage?.stage === stage) {
    return;
  }

  closeOpenStage(run, startedAt);
  observability.stages.push({
    stage,
    startedAt
  });
}

function ensureRunExecution(run: Run, staleAfterMs: number) {
  const observability = ensureRunObservability(run);

  if (!observability.execution) {
    observability.execution = {
      mode: "in_process",
      scheduledAt: run.createdAt,
      staleAfterMs
    };
  }

  return observability.execution;
}

function stabilizeClaimInventoryRecord(record: ClaimInventoryRecord) {
  return {
    ...record,
    claimInventory: stabilizeClaimInventory(record.claimInventory)
  };
}

function tryReadClaimInventoryRecord(value: unknown) {
  const normalized = tryNormalizeClaimInventoryRecord(value).record;
  return normalized ? stabilizeClaimInventoryRecord(normalized) : null;
}

function normalizeWorkspace(workspace: Workspace) {
  return {
    ...workspace,
    settings: {
      ...getClaimGraphRuntimeConfig().defaultWorkspaceSettings,
      ...(workspace.settings ?? {})
    },
    sourceUrls: Array.isArray(workspace.sourceUrls) ? workspace.sourceUrls : []
  } satisfies Workspace;
}

async function upsertWorkspace(
  workspace: Workspace,
  options?: {
    writeCapabilityHash?: string;
  }
) {
  const sql = await getReadySql();

  const workspaceQuery = sql.query(
    `
      INSERT INTO claimgraph_workspaces
        (id, question, created_at, updated_at, settings, source_urls, data, deleted_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, null)
      ON CONFLICT(id) DO UPDATE SET
        question = excluded.question,
        updated_at = excluded.updated_at,
        settings = excluded.settings,
        source_urls = excluded.source_urls,
        data = excluded.data,
        deleted_at = null
    `,
    [
      workspace.id,
      workspace.question,
      workspace.createdAt,
      workspace.updatedAt,
      encodeJson(workspace.settings),
      encodeJson(workspace.sourceUrls),
      encodeJson(workspace)
    ]
  );

  if (!options?.writeCapabilityHash) {
    await workspaceQuery;
    return;
  }

  await sql.transaction([
    workspaceQuery,
    sql.query(
      `
        INSERT INTO claimgraph_workspace_capabilities
          (workspace_id, write_capability_hash, created_at)
        VALUES ($1, $2, $3)
        ON CONFLICT(workspace_id) DO UPDATE SET
          write_capability_hash = excluded.write_capability_hash
      `,
      [workspace.id, options.writeCapabilityHash, nowIso()]
    )
  ]);
}

async function getWorkspaceFromHosted(workspaceId: string) {
  const sql = await getReadySql();
  const rows = (await sql.query(
    `
      SELECT data
      FROM claimgraph_workspaces
      WHERE id = $1 AND deleted_at IS NULL
      LIMIT 1
    `,
    [workspaceId]
  )) as Array<JsonRow>;

  const row = rows[0];
  return row ? normalizeWorkspace(decodeJson<Workspace>(row.data)) : null;
}

async function acquireHostedRun(run: Run, staleAfterMs: number) {
  const sql = await getReadySql();
  const staleBefore = new Date(Date.now() - staleAfterMs).toISOString();
  const rows = (await sql.query(
    `
      WITH lifecycle_lock AS (
        SELECT pg_advisory_xact_lock(hashtextextended($1, 0))
      ),
      eligible_workspace AS (
        SELECT workspace.id
        FROM claimgraph_workspaces AS workspace
        CROSS JOIN lifecycle_lock
        WHERE workspace.id = $1 AND workspace.deleted_at IS NULL
      ),
      retired_superseded AS (
        UPDATE claimgraph_runs AS current_run
        SET
          completed_at = $2,
          status = 'failed',
          status_message = CASE
            WHEN current_run.status = 'queued'
              AND current_run.workflow_id IS NULL
              AND current_run.created_at <= $10
              THEN 'Undispatched hosted run expired before Workflow start.'
            ELSE 'Run superseded by a newer workspace state.'
          END,
          error_message = CASE
            WHEN current_run.status = 'queued'
              AND current_run.workflow_id IS NULL
              AND current_run.created_at <= $10
              THEN 'The hosted run was never dispatched before its lease expired.'
            ELSE 'A newer workspace run superseded this analysis before it could finish.'
          END,
          execution = CASE
            WHEN current_run.execution IS NULL THEN null
            ELSE current_run.execution || jsonb_build_object(
              'heartbeatAt', ($2::timestamptz)::text,
              'finishedAt', ($2::timestamptz)::text
            )
          END,
          observability = CASE
            WHEN current_run.observability IS NULL THEN null
            WHEN current_run.observability->'execution' IS NULL THEN current_run.observability
            ELSE jsonb_set(
              current_run.observability,
              '{execution}',
              current_run.observability->'execution' || jsonb_build_object(
                'heartbeatAt', ($2::timestamptz)::text,
                'finishedAt', ($2::timestamptz)::text
              ),
              true
            )
          END,
          data = jsonb_set(
            current_run.data || jsonb_build_object(
              'status', 'failed',
              'completedAt', ($2::timestamptz)::text,
              'statusMessage', CASE
                WHEN current_run.status = 'queued'
                  AND current_run.workflow_id IS NULL
                  AND current_run.created_at <= $10
                  THEN 'Undispatched hosted run expired before Workflow start.'
                ELSE 'Run superseded by a newer workspace state.'
              END,
              'errorMessage', CASE
                WHEN current_run.status = 'queued'
                  AND current_run.workflow_id IS NULL
                  AND current_run.created_at <= $10
                  THEN 'The hosted run was never dispatched before its lease expired.'
                ELSE 'A newer workspace run superseded this analysis before it could finish.'
              END
            ),
            '{observability}',
            CASE
              WHEN current_run.data->'observability' IS NULL THEN '{}'::jsonb
              WHEN current_run.data#>'{observability,execution}' IS NULL
                THEN current_run.data->'observability'
              ELSE jsonb_set(
                current_run.data->'observability',
                '{execution}',
                (current_run.data#>'{observability,execution}') ||
                  jsonb_build_object(
                    'heartbeatAt', ($2::timestamptz)::text,
                    'finishedAt', ($2::timestamptz)::text
                  ),
                true
              )
            END,
            true
          ),
          version = current_run.version + 1
        WHERE current_run.workspace_id IN (SELECT id FROM eligible_workspace)
          AND current_run.status = ANY($3)
          AND (
            EXISTS (
              SELECT 1
              FROM claimgraph_runs AS newer_run
              WHERE newer_run.workspace_id = current_run.workspace_id
                AND (
                  newer_run.created_at > current_run.created_at
                  OR (
                    newer_run.created_at = current_run.created_at
                    AND newer_run.seq > current_run.seq
                  )
                )
            )
            OR (
              current_run.status = 'queued'
              AND current_run.workflow_id IS NULL
              AND current_run.created_at <= $10
            )
          )
        RETURNING current_run.id
      ),
      active_run AS (
        SELECT current_run.data
        FROM claimgraph_runs AS current_run
        WHERE current_run.workspace_id IN (SELECT id FROM eligible_workspace)
          AND current_run.status = ANY($3)
          AND NOT (
            current_run.status = 'queued'
            AND current_run.workflow_id IS NULL
            AND current_run.created_at <= $10
          )
          AND NOT EXISTS (
            SELECT 1
            FROM claimgraph_runs AS newer_run
            WHERE newer_run.workspace_id = current_run.workspace_id
              AND (
                newer_run.created_at > current_run.created_at
                OR (
                  newer_run.created_at = current_run.created_at
                  AND newer_run.seq > current_run.seq
                )
              )
          )
        ORDER BY current_run.created_at DESC, current_run.seq DESC
        LIMIT 1
        FOR UPDATE
      ),
      inserted_run AS (
        INSERT INTO claimgraph_runs
          (
            id,
            workspace_id,
            created_at,
            completed_at,
            status,
            status_message,
            error_message,
            metrics,
            observability,
            execution,
            workflow_id,
            version,
            data
          )
        SELECT
          $4,
          eligible_workspace.id,
          $5,
          null,
          'queued',
          $6,
          null,
          null,
          $7::jsonb,
          $8::jsonb,
          null,
          1,
          $9::jsonb
        FROM eligible_workspace
        WHERE NOT EXISTS (SELECT 1 FROM active_run)
          AND NOT EXISTS (SELECT 1 FROM retired_superseded)
        ON CONFLICT DO NOTHING
        RETURNING data
      )
      SELECT data, true AS created FROM inserted_run
      UNION ALL
      SELECT data, false AS created FROM active_run
      LIMIT 1
    `,
    [
      run.workspaceId,
      nowIso(),
      ACTIVE_RUN_STATUSES,
      run.id,
      run.createdAt,
      run.statusMessage ?? null,
      encodeJson(run.observability ?? null),
      encodeJson(run.observability?.execution ?? null),
      encodeJson(run),
      staleBefore
    ]
  )) as Array<JsonRow & { created: boolean }>;

  const row = rows[0];
  return row
    ? {
        run: decodeJson<Run>(row.data),
        created: row.created
      }
    : null;
}

async function getStoredRunFromHosted(runId: string) {
  const sql = await getReadySql();
  const rows = (await sql.query(
    `
      SELECT data, version
      FROM claimgraph_runs
      WHERE id = $1
      LIMIT 1
    `,
    [runId]
  )) as Array<StoredRunRow>;

  const row = rows[0];
  return row
    ? {
        run: decodeJson<Run>(row.data),
        version: Number(row.version)
      }
    : null;
}

async function getRunFromHosted(runId: string) {
  return (await getStoredRunFromHosted(runId))?.run ?? null;
}

async function updateRunWithCas(
  run: Run,
  expectedVersion: number,
  options?: { requireNewest?: boolean }
) {
  const sql = await getReadySql();
  const rows = (await sql.query(
    `
      UPDATE claimgraph_runs AS current_run
      SET
        completed_at = $2,
        status = $3,
        status_message = $4,
        error_message = $5,
        metrics = $6::jsonb,
        observability = $7::jsonb,
        execution = $8::jsonb,
        workflow_id = $9,
        data = $10::jsonb,
        version = current_run.version + 1
      WHERE current_run.id = $1
        AND current_run.version = $11
        AND (
          $12::boolean = false
          OR NOT EXISTS (
            SELECT 1
            FROM claimgraph_runs AS newer_run
            WHERE newer_run.workspace_id = current_run.workspace_id
              AND (
                newer_run.created_at > current_run.created_at
                OR (
                  newer_run.created_at = current_run.created_at
                  AND newer_run.seq > current_run.seq
                )
              )
          )
        )
      RETURNING data, version
    `,
    [
      run.id,
      run.completedAt ?? null,
      run.status,
      run.statusMessage ?? null,
      run.errorMessage ?? null,
      encodeJson(run.metrics ?? null),
      encodeJson(run.observability ?? null),
      encodeJson(run.observability?.execution ?? null),
      run.observability?.execution?.workflowRunId ?? null,
      encodeJson(run),
      expectedVersion,
      options?.requireNewest ?? false
    ]
  )) as Array<StoredRunRow>;

  const row = rows[0];
  return row ? decodeJson<Run>(row.data) : null;
}

async function mutateRunWithCas(
  runId: string,
  mutate: (run: Run) => boolean,
  options?: { requireNewest?: boolean }
) {
  for (let attempt = 0; attempt < RUN_CAS_MAX_ATTEMPTS; attempt += 1) {
    const stored = await getStoredRunFromHosted(runId);

    if (!stored) {
      throw new Error("Run not found.");
    }

    const run = clone(stored.run);

    if (!mutate(run)) {
      return {
        applied: false,
        run: clone(stored.run)
      };
    }

    const updated = await updateRunWithCas(run, stored.version, options);

    if (updated) {
      return {
        applied: true,
        run: clone(updated)
      };
    }

    if (options?.requireNewest) {
      const latest = await getLatestRunForWorkspaceFromHosted(stored.run.workspaceId);

      if (latest?.id !== runId) {
        return {
          applied: false,
          run: clone((await getRunFromHosted(runId)) ?? stored.run)
        };
      }
    }
  }

  throw new Error("Run update conflicted repeatedly; retry the operation.");
}

async function getLatestRunForWorkspaceFromHosted(workspaceId: string) {
  const sql = await getReadySql();
  const rows = (await sql.query(
    `
      SELECT data
      FROM claimgraph_runs
      WHERE workspace_id = $1
      ORDER BY created_at DESC, seq DESC
      LIMIT 1
    `,
    [workspaceId]
  )) as Array<JsonRow>;

  const row = rows[0];
  return row ? decodeJson<Run>(row.data) : null;
}

async function getActiveRunForWorkspaceFromHosted(workspaceId: string) {
  const sql = await getReadySql();
  const rows = (await sql.query(
    `
      SELECT data
      FROM claimgraph_runs
      WHERE workspace_id = $1
        AND status = ANY($2)
      ORDER BY created_at DESC, seq DESC
      LIMIT 1
    `,
    [workspaceId, ACTIVE_RUN_STATUSES]
  )) as Array<JsonRow>;

  const row = rows[0];
  return row ? decodeJson<Run>(row.data) : null;
}

async function upsertWorkspaceFile(file: WorkspaceFile) {
  const sql = await getReadySql();

  await sql.query(
    `
      INSERT INTO claimgraph_workspace_files
        (
          id,
          workspace_id,
          original_name,
          stored_name,
          mime_type,
          extension,
          size_bytes,
          uploaded_at,
          blob_key,
          data
        )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
      ON CONFLICT(id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        original_name = excluded.original_name,
        stored_name = excluded.stored_name,
        mime_type = excluded.mime_type,
        extension = excluded.extension,
        size_bytes = excluded.size_bytes,
        uploaded_at = excluded.uploaded_at,
        blob_key = excluded.blob_key,
        data = excluded.data
    `,
    [
      file.id,
      file.workspaceId,
      file.originalName,
      file.storedName,
      file.mimeType,
      file.extension,
      file.sizeBytes,
      file.uploadedAt,
      file.blobKey ?? null,
      encodeJson(file)
    ]
  );
}

async function getWorkspaceFilesFromHosted(workspaceId: string) {
  const sql = await getReadySql();
  const rows = (await sql.query(
    `
      SELECT data
      FROM claimgraph_workspace_files
      WHERE workspace_id = $1
      ORDER BY uploaded_at ASC
    `,
    [workspaceId]
  )) as Array<JsonRow>;

  return rows.map((row) => decodeJson<WorkspaceFile>(row.data));
}

type GuardedWorkspaceFileMutationRow = {
  workspace_exists: boolean;
  active_run: unknown | null;
  mutation_count: number | string;
  removed_file?: unknown | null;
  invalidation_count?: number | string;
};

type GuardedWorkspaceDeleteRow = {
  workspace_exists: boolean;
  active_run: unknown | null;
  deleted_workspace: unknown | null;
  files: unknown;
  cleanup_job_id: string | null;
};

function assertWorkspaceFileOwnership(
  workspaceId: string,
  files: WorkspaceFile[]
) {
  if (files.some((file) => file.workspaceId !== workspaceId)) {
    throw new Error("Workspace file belongs to a different workspace.");
  }
}

async function addWorkspaceFilesIfNoActiveRunHosted(
  workspaceId: string,
  files: WorkspaceFile[]
): Promise<GuardedWorkspaceFileAddResult> {
  assertWorkspaceFileOwnership(workspaceId, files);
  const sql = await getReadySql();
  const updatedAt = nowIso();
  const results = await sql.transaction([
    sql.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [workspaceId]
    ),
    sql.query(
      `
        WITH eligible_workspace AS (
          SELECT workspace.id
          FROM claimgraph_workspaces AS workspace
          WHERE workspace.id = $1 AND workspace.deleted_at IS NULL
        ),
        active_run AS (
          SELECT current_run.data
          FROM claimgraph_runs AS current_run
          WHERE current_run.workspace_id IN (SELECT id FROM eligible_workspace)
            AND current_run.status = ANY($3)
          ORDER BY current_run.created_at DESC, current_run.seq DESC
          LIMIT 1
          FOR UPDATE
        ),
        input_files AS (
          SELECT item.data
          FROM jsonb_array_elements($2::jsonb) AS item(data)
        ),
        upserted_files AS (
          INSERT INTO claimgraph_workspace_files
            (
              id,
              workspace_id,
              original_name,
              stored_name,
              mime_type,
              extension,
              size_bytes,
              uploaded_at,
              blob_key,
              data
            )
          SELECT
            input_file.data->>'id',
            eligible_workspace.id,
            input_file.data->>'originalName',
            input_file.data->>'storedName',
            input_file.data->>'mimeType',
            input_file.data->>'extension',
            (input_file.data->>'sizeBytes')::bigint,
            (input_file.data->>'uploadedAt')::timestamptz,
            input_file.data->>'blobKey',
            input_file.data
          FROM input_files AS input_file
          CROSS JOIN eligible_workspace
          WHERE NOT EXISTS (SELECT 1 FROM active_run)
          ON CONFLICT(id) DO UPDATE SET
            workspace_id = excluded.workspace_id,
            original_name = excluded.original_name,
            stored_name = excluded.stored_name,
            mime_type = excluded.mime_type,
            extension = excluded.extension,
            size_bytes = excluded.size_bytes,
            uploaded_at = excluded.uploaded_at,
            blob_key = excluded.blob_key,
            data = excluded.data
          RETURNING id
        ),
        updated_workspace AS (
          UPDATE claimgraph_workspaces AS workspace
          SET
            updated_at = ($4::text)::timestamptz,
            data = jsonb_set(
              workspace.data,
              '{updatedAt}',
              to_jsonb($4::text),
              true
            )
          WHERE workspace.id IN (SELECT id FROM eligible_workspace)
            AND NOT EXISTS (SELECT 1 FROM active_run)
            AND (SELECT count(*) FROM upserted_files) = $5
          RETURNING workspace.id
        )
        SELECT
          EXISTS (SELECT 1 FROM eligible_workspace) AS workspace_exists,
          (SELECT data FROM active_run LIMIT 1) AS active_run,
          (SELECT count(*) FROM upserted_files) AS mutation_count,
          (SELECT count(*) FROM updated_workspace) AS workspace_update_count
      `,
      [
        workspaceId,
        encodeJson(files),
        ACTIVE_RUN_STATUSES,
        updatedAt,
        files.length
      ]
    )
  ]);
  const rows = results[1] as GuardedWorkspaceFileMutationRow[];
  const row = rows[0];

  if (!row?.workspace_exists) {
    throw new Error("Workspace not found.");
  }

  if (row.active_run) {
    return {
      applied: false,
      reason: "active_run",
      activeRun: decodeJson<Run>(row.active_run)
    };
  }

  if (Number(row.mutation_count) !== files.length) {
    throw new Error("Workspace file mutation did not persist every file.");
  }

  return {
    applied: true,
    files: await getWorkspaceFilesFromHosted(workspaceId)
  };
}

async function deleteWorkspaceIfNoActiveRunHosted(
  workspaceId: string
): Promise<DeleteWorkspaceIfNoActiveRunResult> {
  const sql = await getReadySql();
  const deletedAt = nowIso();
  const cleanupJobId = getWorkspaceDeletionCleanupJobId(workspaceId);
  const results = await sql.transaction([
    sql.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [workspaceId]
    ),
    sql.query(
      `
        WITH eligible_workspace AS (
          SELECT workspace.id, workspace.data
          FROM claimgraph_workspaces AS workspace
          WHERE workspace.id = $1 AND workspace.deleted_at IS NULL
          FOR UPDATE
        ),
        active_run AS (
          SELECT current_run.data
          FROM claimgraph_runs AS current_run
          WHERE current_run.workspace_id IN (SELECT id FROM eligible_workspace)
            AND current_run.status = ANY($3)
          ORDER BY current_run.created_at DESC, current_run.seq DESC
          LIMIT 1
          FOR UPDATE
        ),
        workspace_files AS (
          SELECT coalesce(jsonb_agg(workspace_file.data ORDER BY workspace_file.uploaded_at), '[]'::jsonb) AS data
          FROM claimgraph_workspace_files AS workspace_file
          WHERE workspace_file.workspace_id IN (SELECT id FROM eligible_workspace)
        ),
        deleted_workspace AS (
          UPDATE claimgraph_workspaces AS workspace
          SET deleted_at = ($2::text)::timestamptz
          WHERE workspace.id IN (SELECT id FROM eligible_workspace)
            AND NOT EXISTS (SELECT 1 FROM active_run)
          RETURNING workspace.id, workspace.data
        ),
        scheduled_cleanup AS (
          INSERT INTO claimgraph_cleanup_jobs
            (
              id, workspace_id, run_id, job_type, status, created_at,
              attempted_at, completed_at, error_message, attempt_count,
              next_attempt_at, lease_expires_at, data
            )
          SELECT
            $4::text,
            deleted_workspace.id,
            null,
            'workspace_delete',
            'pending',
            ($2::text)::timestamptz,
            null,
            null,
            null,
            0,
            ($2::text)::timestamptz,
            null,
            $5::jsonb
          FROM deleted_workspace
          ON CONFLICT (id) DO UPDATE SET
            workspace_id = EXCLUDED.workspace_id,
            run_id = null,
            job_type = EXCLUDED.job_type,
            status = 'pending',
            created_at = EXCLUDED.created_at,
            attempted_at = null,
            completed_at = null,
            error_message = null,
            attempt_count = 0,
            next_attempt_at = EXCLUDED.next_attempt_at,
            lease_expires_at = null,
            data = EXCLUDED.data
          RETURNING id
        )
        SELECT
          EXISTS (SELECT 1 FROM eligible_workspace) AS workspace_exists,
          (SELECT data FROM active_run LIMIT 1) AS active_run,
          (SELECT data FROM deleted_workspace LIMIT 1) AS deleted_workspace,
          (SELECT data FROM workspace_files) AS files,
          (SELECT id FROM scheduled_cleanup LIMIT 1) AS cleanup_job_id
      `,
      [
        workspaceId,
        deletedAt,
        ACTIVE_RUN_STATUSES,
        cleanupJobId,
        encodeJson({ reason: "owner_requested_workspace_deletion" })
      ]
    )
  ]);
  const rows = results[1] as GuardedWorkspaceDeleteRow[];
  const row = rows[0];

  if (!row?.workspace_exists) {
    return {
      applied: false,
      reason: "not_found"
    };
  }

  if (row.active_run) {
    return {
      applied: false,
      reason: "active_run",
      activeRun: decodeJson<Run>(row.active_run)
    };
  }

  if (!row.deleted_workspace) {
    throw new Error("Workspace deletion did not persist its tombstone.");
  }

  if (row.cleanup_job_id !== cleanupJobId) {
    throw new Error("Workspace deletion did not schedule durable cleanup.");
  }

  return {
    applied: true,
    workspace: normalizeWorkspace(decodeJson<Workspace>(row.deleted_workspace)),
    files: decodeJson<WorkspaceFile[]>(row.files ?? []),
    cleanupJobId
  };
}

async function removeWorkspaceFileIfNoActiveRunHosted(
  workspaceId: string,
  fileId: string,
  options?: GuardedWorkspaceFileRemoveOptions
): Promise<GuardedWorkspaceFileRemoveResult> {
  const workspace = await getWorkspaceFromHosted(workspaceId);

  if (!workspace) {
    throw new Error("Workspace not found.");
  }

  const sql = await getReadySql();
  const updatedAt = nowIso();
  const graphRecord = buildStarterGraphRecord(workspace);
  const invalidationRun: Run = {
    id: crypto.randomUUID(),
    workspaceId,
    status: "completed",
    createdAt: updatedAt,
    completedAt: updatedAt,
    statusMessage:
      options?.statusMessage ??
      "Workspace inputs changed. Previous live analysis artifacts were cleared. Run analysis again to rebuild from the remaining files and web sources.",
    metrics: {
      ...computeRunMetrics(
        graphRecord.graph,
        graphRecord.sources.length,
        graphRecord.snippets.length
      ),
      durationMs: 0
    },
    observability: {
      stages: [],
      exportEvents: [],
      retrievalCleanupEvents: options?.cleanupEvents ?? [],
      providerFailureEvents: [],
      fallbackReason: "workspace_inputs_changed"
    }
  };
  const normalizedGraphRecord = normalizeWorkspaceGraphRecord({
    ...graphRecord,
    createdAt: updatedAt,
    runId: invalidationRun.id
  });
  validateClaimGraphArtifacts({
    graph: normalizedGraphRecord.graph,
    sources: normalizedGraphRecord.sources,
    snippets: normalizedGraphRecord.snippets
  });
  const results = await sql.transaction([
    sql.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [workspaceId]
    ),
    sql.query(
      `
        WITH eligible_workspace AS (
          SELECT workspace.id
          FROM claimgraph_workspaces AS workspace
          WHERE workspace.id = $1 AND workspace.deleted_at IS NULL
        ),
        active_run AS (
          SELECT current_run.data
          FROM claimgraph_runs AS current_run
          WHERE current_run.workspace_id IN (SELECT id FROM eligible_workspace)
            AND current_run.status = ANY($3)
          ORDER BY current_run.created_at DESC, current_run.seq DESC
          LIMIT 1
          FOR UPDATE
        ),
        removed_file AS (
          DELETE FROM claimgraph_workspace_files AS workspace_file
          WHERE workspace_file.workspace_id IN (SELECT id FROM eligible_workspace)
            AND workspace_file.id = $2
            AND NOT EXISTS (SELECT 1 FROM active_run)
          RETURNING workspace_file.data
        ),
        invalidation_run AS (
          INSERT INTO claimgraph_runs
            (
              id,
              workspace_id,
              created_at,
              completed_at,
              status,
              status_message,
              error_message,
              metrics,
              observability,
              execution,
              workflow_id,
              version,
              data
            )
          SELECT
            $6,
            eligible_workspace.id,
            ($4::text)::timestamptz,
            ($4::text)::timestamptz,
            'completed',
            $7,
            null,
            $8::jsonb,
            $9::jsonb,
            null,
            null,
            1,
            $10::jsonb
          FROM eligible_workspace
          WHERE $5::boolean
            AND EXISTS (SELECT 1 FROM removed_file)
          RETURNING id
        ),
        deleted_artifacts AS (
          DELETE FROM claimgraph_artifact_records AS artifact
          WHERE artifact.workspace_id = $1
            AND artifact.artifact_type IN ('evidence_pack', 'claim_inventory')
            AND EXISTS (SELECT 1 FROM invalidation_run)
          RETURNING artifact.id
        ),
        graph_upsert AS (
          INSERT INTO claimgraph_graph_records
            (
              workspace_id,
              run_id,
              record_version,
              origin,
              mode,
              provider,
              backend,
              model,
              response_id,
              created_at,
              graph,
              sources,
              snippets,
              data
            )
          SELECT
            $1,
            invalidation_run.id,
            nullif(graph_record.data->>'recordVersion', '')::integer,
            graph_record.data->>'origin',
            graph_record.data->>'mode',
            graph_record.data->>'provider',
            graph_record.data->>'backend',
            graph_record.data->>'model',
            graph_record.data->>'responseId',
            ($4::text)::timestamptz,
            graph_record.data->'graph',
            graph_record.data->'sources',
            graph_record.data->'snippets',
            graph_record.data
          FROM invalidation_run
          CROSS JOIN (SELECT $11::jsonb AS data) AS graph_record
          ON CONFLICT(workspace_id) DO UPDATE SET
            run_id = excluded.run_id,
            record_version = excluded.record_version,
            origin = excluded.origin,
            mode = excluded.mode,
            provider = excluded.provider,
            backend = excluded.backend,
            model = excluded.model,
            response_id = excluded.response_id,
            created_at = excluded.created_at,
            graph = excluded.graph,
            sources = excluded.sources,
            snippets = excluded.snippets,
            data = excluded.data
          RETURNING workspace_id
        ),
        input_sources AS (
          SELECT source.data
          FROM jsonb_array_elements($11::jsonb->'sources') AS source(data)
        ),
        source_upsert AS (
          INSERT INTO claimgraph_sources
            (
              id,
              workspace_id,
              run_id,
              source_type,
              source_kind,
              title,
              url,
              file_name,
              domain,
              published_at,
              is_primary,
              data
            )
          SELECT
            source.data->>'id',
            $1,
            invalidation_run.id,
            source.data->>'type',
            source.data->>'sourceKind',
            source.data->>'title',
            source.data->>'url',
            source.data->>'fileName',
            source.data->>'domain',
            CASE
              WHEN nullif(source.data->>'publishedAt', '') IS NULL THEN null
              ELSE (source.data->>'publishedAt')::timestamptz
            END,
            CASE
              WHEN nullif(source.data->>'isPrimary', '') IS NULL THEN null
              ELSE (source.data->>'isPrimary')::boolean
            END,
            source.data
          FROM input_sources AS source
          CROSS JOIN invalidation_run
          ON CONFLICT(workspace_id, id) DO UPDATE SET
            run_id = excluded.run_id,
            source_type = excluded.source_type,
            source_kind = excluded.source_kind,
            title = excluded.title,
            url = excluded.url,
            file_name = excluded.file_name,
            domain = excluded.domain,
            published_at = excluded.published_at,
            is_primary = excluded.is_primary,
            data = excluded.data
          RETURNING id
        ),
        pruned_sources AS (
          DELETE FROM claimgraph_sources AS source
          WHERE source.workspace_id = $1
            AND EXISTS (SELECT 1 FROM invalidation_run)
            AND NOT EXISTS (
              SELECT 1
              FROM input_sources
              WHERE input_sources.data->>'id' = source.id
            )
          RETURNING source.id
        ),
        input_snippets AS (
          SELECT snippet.data
          FROM jsonb_array_elements($11::jsonb->'snippets') AS snippet(data)
        ),
        snippet_upsert AS (
          INSERT INTO claimgraph_snippets
            (
              id,
              workspace_id,
              run_id,
              source_id,
              origin,
              location_label,
              page_number,
              offset_start,
              offset_end,
              relevance,
              text,
              rationale,
              data
            )
          SELECT
            snippet.data->>'id',
            $1,
            invalidation_run.id,
            snippet.data->>'sourceId',
            snippet.data->>'origin',
            snippet.data->>'locationLabel',
            nullif(snippet.data->>'pageNumber', '')::integer,
            nullif(snippet.data->>'offsetStart', '')::integer,
            nullif(snippet.data->>'offsetEnd', '')::integer,
            nullif(snippet.data->>'relevance', '')::double precision,
            snippet.data->>'text',
            snippet.data->>'rationale',
            snippet.data
          FROM input_snippets AS snippet
          CROSS JOIN invalidation_run
          ON CONFLICT(workspace_id, id) DO UPDATE SET
            run_id = excluded.run_id,
            source_id = excluded.source_id,
            origin = excluded.origin,
            location_label = excluded.location_label,
            page_number = excluded.page_number,
            offset_start = excluded.offset_start,
            offset_end = excluded.offset_end,
            relevance = excluded.relevance,
            text = excluded.text,
            rationale = excluded.rationale,
            data = excluded.data
          RETURNING id
        ),
        pruned_snippets AS (
          DELETE FROM claimgraph_snippets AS snippet
          WHERE snippet.workspace_id = $1
            AND EXISTS (SELECT 1 FROM invalidation_run)
            AND NOT EXISTS (
              SELECT 1
              FROM input_snippets
              WHERE input_snippets.data->>'id' = snippet.id
            )
          RETURNING snippet.id
        ),
        updated_workspace AS (
          UPDATE claimgraph_workspaces AS workspace
          SET
            updated_at = ($4::text)::timestamptz,
            data = jsonb_set(
              workspace.data,
              '{updatedAt}',
              to_jsonb($4::text),
              true
            )
          WHERE workspace.id IN (SELECT id FROM eligible_workspace)
            AND EXISTS (SELECT 1 FROM removed_file)
          RETURNING workspace.id
        )
        SELECT
          EXISTS (SELECT 1 FROM eligible_workspace) AS workspace_exists,
          (SELECT data FROM active_run LIMIT 1) AS active_run,
          (SELECT count(*) FROM removed_file) AS mutation_count,
          (SELECT data FROM removed_file LIMIT 1) AS removed_file,
          (SELECT count(*) FROM updated_workspace) AS workspace_update_count,
          (SELECT count(*) FROM invalidation_run) AS invalidation_count,
          (SELECT count(*) FROM deleted_artifacts) AS artifact_delete_count,
          (SELECT count(*) FROM graph_upsert) AS graph_upsert_count,
          (SELECT count(*) FROM source_upsert) AS source_upsert_count,
          (SELECT count(*) FROM pruned_sources) AS source_prune_count,
          (SELECT count(*) FROM snippet_upsert) AS snippet_upsert_count,
          (SELECT count(*) FROM pruned_snippets) AS snippet_prune_count
      `,
      [
        workspaceId,
        fileId,
        ACTIVE_RUN_STATUSES,
        updatedAt,
        options?.invalidateArtifacts === true,
        invalidationRun.id,
        invalidationRun.statusMessage ?? null,
        encodeJson(invalidationRun.metrics ?? null),
        encodeJson(invalidationRun.observability ?? null),
        encodeJson(invalidationRun),
        encodeJson(normalizedGraphRecord)
      ]
    )
  ]);
  const rows = results[1] as GuardedWorkspaceFileMutationRow[];
  const row = rows[0];

  if (!row?.workspace_exists) {
    throw new Error("Workspace not found.");
  }

  if (row.active_run) {
    return {
      applied: false,
      reason: "active_run",
      activeRun: decodeJson<Run>(row.active_run)
    };
  }

  if (Number(row.mutation_count) !== 1 || !row.removed_file) {
    throw new Error("Workspace file not found.");
  }

  if (
    options?.invalidateArtifacts === true &&
    Number(row.invalidation_count) !== 1
  ) {
    throw new Error("Workspace artifact invalidation did not commit with file removal.");
  }

  return {
    applied: true,
    file: decodeJson<WorkspaceFile>(row.removed_file),
    files: await getWorkspaceFilesFromHosted(workspaceId),
    artifactsInvalidated: options?.invalidateArtifacts === true,
    invalidationRunId:
      options?.invalidateArtifacts === true ? invalidationRun.id : undefined
  };
}

function buildStarterGraphRecord(workspace: Workspace): WorkspaceGraphRecord {
  const dataset = buildStarterDataset(workspace.question);

  return {
    recordVersion: CURRENT_WORKSPACE_GRAPH_RECORD_VERSION,
    origin: "starter",
    mode: "demo",
    provider: "starter",
    createdAt: nowIso(),
    model: "starter-curated",
    responseId: "starter-curated",
    graph: dataset.graph,
    sources: dataset.sources,
    snippets: dataset.snippets
  };
}

function buildSyntheticDemoGraphRecord() {
  const workspace = buildSyntheticDemoWorkspace();

  return {
    ...buildStarterGraphRecord(workspace),
    createdAt: SYNTHETIC_DEMO_TIMESTAMP,
    responseId: "starter-demo",
    runId: SYNTHETIC_DEMO_RUN_ID
  } satisfies WorkspaceGraphRecord;
}

function buildValidatedGraph(
  graphRecord: WorkspaceGraphRecord,
  claimInventory: ClaimInventoryRecord | null
) {
  const repairedGraph = repairLiveGraphDisagreementClusters({
    graph: graphRecord.graph,
    claimInventory: claimInventory?.claimInventory ?? null
  });
  const reviewGraph = enhanceGraphReviewLabels({
    graph: repairedGraph,
    sources: graphRecord.sources,
    snippets: graphRecord.snippets
  });

  return validateClaimGraphArtifacts({
    graph: reviewGraph,
    sources: graphRecord.sources,
    snippets: graphRecord.snippets
  });
}

function buildSyntheticDemoGraphPayload() {
  const workspace = buildSyntheticDemoWorkspace();
  const run = buildSyntheticDemoRun();
  const graphRecord = buildSyntheticDemoGraphRecord();

  return {
    workspace: clone(workspace),
    run: clone(run),
    latestRun: clone(run),
    activeRun: null,
    graphRun: clone(run),
    graph: clone(buildValidatedGraph(graphRecord, null)),
    sources: clone(graphRecord.sources),
    snippets: clone(graphRecord.snippets),
    files: [],
    evidence: null,
    claimInventory: null,
    latestRunArtifacts: null,
    inProgressArtifacts: null,
    starterMode: true,
    runtime: getClaimGraphRuntimeInfo(),
    graphBuild: {
      origin: graphRecord.origin,
      mode: graphRecord.mode,
      provider: graphRecord.provider,
      model: graphRecord.model,
      responseId: graphRecord.responseId,
      runId: graphRecord.runId
    }
  } satisfies WorkspaceGraphPayload;
}

async function getGraphRecordFromHosted(workspaceId: string) {
  const sql = await getReadySql();
  const rows = (await sql.query(
    `
      SELECT data
      FROM claimgraph_graph_records
      WHERE workspace_id = $1
      LIMIT 1
    `,
    [workspaceId]
  )) as Array<JsonRow>;

  const row = rows[0];

  if (!row) {
    return null;
  }

  const parsed = decodeJson<unknown>(row.data);
  const record = tryNormalizeWorkspaceGraphRecord(parsed).record;

  if (!record) {
    return null;
  }

  return record;
}

async function getWorkspaceGraphForRunFromHosted(runId: string) {
  const sql = await getReadySql();
  const rows = (await sql.query(
    `
      SELECT data
      FROM claimgraph_graph_records
      WHERE run_id = $1
      LIMIT 1
    `,
    [runId]
  )) as Array<JsonRow>;
  const row = rows[0];

  if (!row) {
    return null;
  }

  const record = tryNormalizeWorkspaceGraphRecord(decodeJson<unknown>(row.data)).record;
  return record?.runId === runId ? record : null;
}

async function upsertGraphRecord(
  workspaceId: string,
  graphRecord: WorkspaceGraphRecord
) {
  const sql = await getReadySql();
  const normalizedRecord = normalizeWorkspaceGraphRecord(graphRecord);

  validateClaimGraphArtifacts({
    graph: normalizedRecord.graph,
    sources: normalizedRecord.sources,
    snippets: normalizedRecord.snippets
  });

  const transactionQueries = [
    sql.query(
      `
        INSERT INTO claimgraph_graph_records
          (
            workspace_id,
            run_id,
            record_version,
            origin,
            mode,
            provider,
            backend,
            model,
            response_id,
            created_at,
            graph,
            sources,
            snippets,
            data
          )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb)
        ON CONFLICT(workspace_id) DO UPDATE SET
          run_id = excluded.run_id,
          record_version = excluded.record_version,
          origin = excluded.origin,
          mode = excluded.mode,
          provider = excluded.provider,
          backend = excluded.backend,
          model = excluded.model,
          response_id = excluded.response_id,
          created_at = excluded.created_at,
          graph = excluded.graph,
          sources = excluded.sources,
          snippets = excluded.snippets,
          data = excluded.data
      `,
      [
        workspaceId,
        normalizedRecord.runId ?? null,
        normalizedRecord.recordVersion ?? null,
        normalizedRecord.origin,
        normalizedRecord.mode,
        normalizedRecord.provider,
        normalizedRecord.backend ?? null,
        normalizedRecord.model,
        normalizedRecord.responseId ?? null,
        normalizedRecord.createdAt,
        encodeJson(normalizedRecord.graph),
        encodeJson(normalizedRecord.sources),
        encodeJson(normalizedRecord.snippets),
        encodeJson(normalizedRecord)
      ]
    ),
    sql.query("DELETE FROM claimgraph_sources WHERE workspace_id = $1", [workspaceId]),
    sql.query("DELETE FROM claimgraph_snippets WHERE workspace_id = $1", [workspaceId]),
    ...normalizedRecord.sources.map((source) =>
      sql.query(
        `
          INSERT INTO claimgraph_sources
            (
              id,
              workspace_id,
              run_id,
              source_type,
              source_kind,
              title,
              url,
              file_name,
              domain,
              published_at,
              is_primary,
              data
            )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
        `,
        [
          source.id,
          workspaceId,
          normalizedRecord.runId ?? null,
          source.type,
          source.sourceKind ?? null,
          source.title,
          source.url ?? null,
          source.fileName ?? null,
          source.domain ?? null,
          normalizeHostedTimestampForColumn(source.publishedAt),
          source.isPrimary ?? null,
          encodeJson(source)
        ]
      )
    ),
    ...normalizedRecord.snippets.map((snippet) =>
      sql.query(
        `
          INSERT INTO claimgraph_snippets
            (
              id,
              workspace_id,
              run_id,
              source_id,
              origin,
              location_label,
              page_number,
              offset_start,
              offset_end,
              relevance,
              text,
              rationale,
              data
            )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
        `,
        [
          snippet.id,
          workspaceId,
          normalizedRecord.runId ?? null,
          snippet.sourceId,
          snippet.origin ?? null,
          snippet.locationLabel ?? null,
          snippet.pageNumber ?? null,
          snippet.offsetStart ?? null,
          snippet.offsetEnd ?? null,
          snippet.relevance,
          snippet.text,
          snippet.rationale,
          encodeJson(snippet)
        ]
      )
    )
  ];

  await sql.transaction(transactionQueries);
  return normalizedRecord;
}

async function insertStarterGraphRecordIfSafe(
  workspaceId: string,
  graphRecord: WorkspaceGraphRecord
) {
  const normalizedRecord = normalizeWorkspaceGraphRecord(graphRecord);

  if (normalizedRecord.origin !== "starter" || normalizedRecord.runId) {
    throw new Error("Only an unbound starter graph can use starter materialization.");
  }

  validateClaimGraphArtifacts({
    graph: normalizedRecord.graph,
    sources: normalizedRecord.sources,
    snippets: normalizedRecord.snippets
  });

  const sql = await getReadySql();
  const rows = (await sql.query(
    `
      INSERT INTO claimgraph_graph_records
        (
          workspace_id,
          run_id,
          record_version,
          origin,
          mode,
          provider,
          backend,
          model,
          response_id,
          created_at,
          graph,
          sources,
          snippets,
          data
        )
      SELECT
        workspace.id,
        null,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10::jsonb,
        $11::jsonb,
        $12::jsonb,
        $13::jsonb
      FROM claimgraph_workspaces AS workspace
      WHERE workspace.id = $1
        AND workspace.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM claimgraph_runs AS active_run
          WHERE active_run.workspace_id = workspace.id
            AND active_run.status = ANY($14)
        )
      ON CONFLICT(workspace_id) DO NOTHING
      RETURNING data
    `,
    [
      workspaceId,
      normalizedRecord.recordVersion ?? null,
      normalizedRecord.origin,
      normalizedRecord.mode,
      normalizedRecord.provider,
      normalizedRecord.backend ?? null,
      normalizedRecord.model,
      normalizedRecord.responseId ?? null,
      normalizedRecord.createdAt,
      encodeJson(normalizedRecord.graph),
      encodeJson(normalizedRecord.sources),
      encodeJson(normalizedRecord.snippets),
      encodeJson(normalizedRecord),
      ACTIVE_RUN_STATUSES
    ]
  )) as Array<JsonRow>;

  return rows.length > 0;
}

async function completeRunWithGraphCas(input: {
  run: Run;
  expectedVersion: number;
  expectedStatuses: Run["status"][];
  workspaceId: string;
  record: WorkspaceGraphRecord;
}) {
  const sql = await getReadySql();
  const sourceRows = input.record.sources.map((source) => ({
    data: source,
    publishedAt: normalizeHostedTimestampForColumn(source.publishedAt)
  }));
  const rows = (await sql.query(
    `
      WITH guarded_run AS (
        SELECT current_run.id, current_run.workspace_id, current_run.version
        FROM claimgraph_runs AS current_run
        WHERE current_run.id = $1
          AND current_run.workspace_id = $2
          AND current_run.version = $3
          AND current_run.status = ANY($4)
          AND NOT EXISTS (
            SELECT 1
            FROM claimgraph_runs AS newer_run
            WHERE newer_run.workspace_id = current_run.workspace_id
              AND (
                newer_run.created_at > current_run.created_at
                OR (
                  newer_run.created_at = current_run.created_at
                  AND newer_run.seq > current_run.seq
                )
              )
          )
        FOR UPDATE
      ),
      graph_upsert AS (
        INSERT INTO claimgraph_graph_records
          (
            workspace_id,
            run_id,
            record_version,
            origin,
            mode,
            provider,
            backend,
            model,
            response_id,
            created_at,
            graph,
            sources,
            snippets,
            data
          )
        SELECT
          guarded_run.workspace_id,
          guarded_run.id,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12,
          $13::jsonb,
          $14::jsonb,
          $15::jsonb,
          $16::jsonb
        FROM guarded_run
        ON CONFLICT(workspace_id) DO UPDATE SET
          run_id = excluded.run_id,
          record_version = excluded.record_version,
          origin = excluded.origin,
          mode = excluded.mode,
          provider = excluded.provider,
          backend = excluded.backend,
          model = excluded.model,
          response_id = excluded.response_id,
          created_at = excluded.created_at,
          graph = excluded.graph,
          sources = excluded.sources,
          snippets = excluded.snippets,
          data = excluded.data
        RETURNING workspace_id
      ),
      deleted_sources AS (
        DELETE FROM claimgraph_sources
        WHERE workspace_id IN (SELECT workspace_id FROM graph_upsert)
        RETURNING workspace_id
      ),
      deleted_snippets AS (
        DELETE FROM claimgraph_snippets
        WHERE workspace_id IN (SELECT workspace_id FROM graph_upsert)
        RETURNING workspace_id
      ),
      cleared_artifacts AS (
        SELECT
          graph_upsert.workspace_id,
          (SELECT count(*) FROM deleted_sources) AS deleted_source_count,
          (SELECT count(*) FROM deleted_snippets) AS deleted_snippet_count
        FROM graph_upsert
      ),
      inserted_sources AS (
        INSERT INTO claimgraph_sources
          (
            id,
            workspace_id,
            run_id,
            source_type,
            source_kind,
            title,
            url,
            file_name,
            domain,
            published_at,
            is_primary,
            data
          )
        SELECT
          source_items.source_row->'data'->>'id',
          cleared_artifacts.workspace_id,
          $1,
          source_items.source_row->'data'->>'type',
          source_items.source_row->'data'->>'sourceKind',
          source_items.source_row->'data'->>'title',
          source_items.source_row->'data'->>'url',
          source_items.source_row->'data'->>'fileName',
          source_items.source_row->'data'->>'domain',
          nullif(source_items.source_row->>'publishedAt', '')::timestamptz,
          nullif(source_items.source_row->'data'->>'isPrimary', '')::boolean,
          source_items.source_row->'data'
        FROM cleared_artifacts
        CROSS JOIN LATERAL jsonb_array_elements($23::jsonb) AS source_items(source_row)
        RETURNING id
      ),
      inserted_snippets AS (
        INSERT INTO claimgraph_snippets
          (
            id,
            workspace_id,
            run_id,
            source_id,
            origin,
            location_label,
            page_number,
            offset_start,
            offset_end,
            relevance,
            text,
            rationale,
            data
          )
        SELECT
          snippet_items.snippet->>'id',
          cleared_artifacts.workspace_id,
          $1,
          snippet_items.snippet->>'sourceId',
          snippet_items.snippet->>'origin',
          snippet_items.snippet->>'locationLabel',
          nullif(snippet_items.snippet->>'pageNumber', '')::integer,
          nullif(snippet_items.snippet->>'offsetStart', '')::integer,
          nullif(snippet_items.snippet->>'offsetEnd', '')::integer,
          (snippet_items.snippet->>'relevance')::double precision,
          snippet_items.snippet->>'text',
          snippet_items.snippet->>'rationale',
          snippet_items.snippet
        FROM cleared_artifacts
        CROSS JOIN LATERAL jsonb_array_elements($15::jsonb) AS snippet_items(snippet)
        RETURNING id
      ),
      artifact_counts AS (
        SELECT
          cleared_artifacts.workspace_id,
          (SELECT count(*) FROM inserted_sources) AS inserted_source_count,
          (SELECT count(*) FROM inserted_snippets) AS inserted_snippet_count
        FROM cleared_artifacts
      ),
      updated_workspace AS (
        UPDATE claimgraph_workspaces AS workspace
        SET
          updated_at = $17::timestamptz,
          data = jsonb_set(
            workspace.data,
            '{updatedAt}',
            to_jsonb(($17::timestamptz)::text),
            true
          )
        FROM artifact_counts
        WHERE workspace.id = artifact_counts.workspace_id
        RETURNING workspace.id
      ),
      updated_run AS (
        UPDATE claimgraph_runs AS current_run
        SET
          completed_at = $17::timestamptz,
          status = 'completed',
          status_message = $18,
          error_message = null,
          metrics = $19::jsonb,
          observability = $20::jsonb,
          execution = $21::jsonb,
          workflow_id = $22,
          data = $24::jsonb,
          version = current_run.version + 1
        FROM guarded_run
        WHERE current_run.id = guarded_run.id
          AND current_run.version = guarded_run.version
          AND EXISTS (SELECT 1 FROM updated_workspace)
        RETURNING current_run.data
      )
      SELECT data FROM updated_run
    `,
    [
      input.run.id,
      input.workspaceId,
      input.expectedVersion,
      input.expectedStatuses,
      input.record.recordVersion ?? null,
      input.record.origin,
      input.record.mode,
      input.record.provider,
      input.record.backend ?? null,
      input.record.model,
      input.record.responseId ?? null,
      input.record.createdAt,
      encodeJson(input.record.graph),
      encodeJson(input.record.sources),
      encodeJson(input.record.snippets),
      encodeJson(input.record),
      input.run.completedAt,
      input.run.statusMessage ?? null,
      encodeJson(input.run.metrics ?? null),
      encodeJson(input.run.observability ?? null),
      encodeJson(input.run.observability?.execution ?? null),
      input.run.observability?.execution?.workflowRunId ?? null,
      encodeJson(sourceRows),
      encodeJson(input.run)
    ]
  )) as Array<JsonRow>;

  const row = rows[0];
  return row ? decodeJson<Run>(row.data) : null;
}

async function upsertArtifactRecord(input: {
  id: string;
  workspaceId: string;
  runId?: string | null;
  artifactType: ArtifactType;
  createdAt: string;
  data: unknown;
}) {
  const sql = await getReadySql();

  await sql.query(
    `
      INSERT INTO claimgraph_artifact_records
        (id, workspace_id, run_id, artifact_type, created_at, data)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      ON CONFLICT(id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        run_id = excluded.run_id,
        artifact_type = excluded.artifact_type,
        created_at = excluded.created_at,
        data = excluded.data
    `,
    [
      input.id,
      input.workspaceId,
      input.runId ?? null,
      input.artifactType,
      input.createdAt,
      encodeJson(input.data)
    ]
  );
}

async function upsertArtifactRecordForActiveRun(input: {
  id: string;
  runId: string;
  expectedStatus: Run["status"];
  artifactType: ArtifactType;
  createdAt: string;
  data: unknown;
}) {
  const sql = await getReadySql();
  const rows = (await sql.query(
    `
      WITH guarded_run AS (
        SELECT current_run.id, current_run.workspace_id
        FROM claimgraph_runs AS current_run
        WHERE current_run.id = $2
          AND current_run.status = $6
          AND NOT EXISTS (
            SELECT 1
            FROM claimgraph_runs AS newer_run
            WHERE newer_run.workspace_id = current_run.workspace_id
              AND (
                newer_run.created_at > current_run.created_at
                OR (
                  newer_run.created_at = current_run.created_at
                  AND newer_run.seq > current_run.seq
                )
              )
          )
        FOR UPDATE
      )
      INSERT INTO claimgraph_artifact_records
        (id, workspace_id, run_id, artifact_type, created_at, data)
      SELECT $1, guarded_run.workspace_id, guarded_run.id, $3, $4, $5::jsonb
      FROM guarded_run
      ON CONFLICT(id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        run_id = excluded.run_id,
        artifact_type = excluded.artifact_type,
        created_at = excluded.created_at,
        data = excluded.data
      RETURNING data
    `,
    [
      input.id,
      input.runId,
      input.artifactType,
      input.createdAt,
      encodeJson(input.data),
      input.expectedStatus
    ]
  )) as Array<JsonRow>;

  if (!rows.length) {
    throw new Error(
      "Artifact write rejected because the run left the owning stage or was superseded."
    );
  }
}

async function getLatestArtifactRecord<T>(
  workspaceId: string,
  artifactType: ArtifactType
) {
  const sql = await getReadySql();
  const rows = (await sql.query(
    `
      SELECT data
      FROM claimgraph_artifact_records
      WHERE workspace_id = $1 AND artifact_type = $2
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [workspaceId, artifactType]
  )) as Array<JsonRow>;

  const row = rows[0];
  return row ? decodeJson<T>(row.data) : null;
}

async function getArtifactRecordForRun<T>(
  runId: string,
  artifactType: ArtifactType
) {
  const sql = await getReadySql();
  const rows = (await sql.query(
    `
      SELECT data
      FROM claimgraph_artifact_records
      WHERE run_id = $1 AND artifact_type = $2
      LIMIT 1
    `,
    [runId, artifactType]
  )) as Array<JsonRow>;

  const row = rows[0];
  return row ? decodeJson<T>(row.data) : null;
}

async function buildGraphPayload(
  workspaceId: string,
  graphRecord: WorkspaceGraphRecord
) {
  const workspace = await getWorkspaceFromHosted(workspaceId);

  if (!workspace) {
    throw new Error("Workspace not found.");
  }

  const effectiveGraphRecord =
    graphRecord.origin === "starter"
      ? {
          ...buildStarterGraphRecord(workspace),
          createdAt: graphRecord.createdAt,
          runId: graphRecord.runId
        }
      : graphRecord;
  const [latestRun, activeRun] = await Promise.all([
    getLatestRunForWorkspaceFromHosted(workspaceId),
    getActiveRunForWorkspaceFromHosted(workspaceId)
  ]);
  const graphRunId = effectiveGraphRecord.runId;
  const claimInventory = graphRunId
    ? await hostedClaimGraphStore.getClaimInventoryForRun(graphRunId)
    : null;
  const graph = buildValidatedGraph(effectiveGraphRecord, claimInventory);
  const graphRun = graphRunId ? await getRunFromHosted(graphRunId) : null;
  const latestRunArtifacts =
    latestRun && latestRun.id !== graphRun?.id
      ? {
          runId: latestRun.id,
          evidence: await hostedClaimGraphStore.getEvidencePackForRun(latestRun.id),
          claimInventory: await hostedClaimGraphStore.getClaimInventoryForRun(
            latestRun.id
          )
        }
      : null;
  const inProgressArtifacts = activeRun
    ? {
        runId: activeRun.id,
        evidence: await hostedClaimGraphStore.getEvidencePackForRun(activeRun.id),
        claimInventory: await hostedClaimGraphStore.getClaimInventoryForRun(activeRun.id)
      }
    : null;

  return {
    workspace: clone(workspace),
    run: graphRun,
    latestRun,
    activeRun,
    graphRun,
    graph: clone(graph),
    sources: clone(effectiveGraphRecord.sources),
    snippets: clone(effectiveGraphRecord.snippets),
    files: await getWorkspaceFilesFromHosted(workspaceId),
    evidence: graphRunId
      ? await hostedClaimGraphStore.getEvidencePackForRun(graphRunId)
      : null,
    claimInventory,
    latestRunArtifacts,
    inProgressArtifacts,
    starterMode: effectiveGraphRecord.origin === "starter",
    runtime: getClaimGraphRuntimeInfo(),
    graphBuild: {
      origin: effectiveGraphRecord.origin,
      mode: effectiveGraphRecord.mode,
      provider: effectiveGraphRecord.provider,
      backend: effectiveGraphRecord.backend,
      model: effectiveGraphRecord.model,
      responseId: effectiveGraphRecord.responseId,
      runId: effectiveGraphRecord.runId
    }
  } satisfies WorkspaceGraphPayload;
}

async function materializeStarterGraphForWorkspaceInHosted(workspaceId: string) {
  const workspace = await getWorkspaceFromHosted(workspaceId);

  if (!workspace) {
    throw new Error("Workspace not found.");
  }

  const graphRecord = buildStarterGraphRecord(workspace);
  await insertStarterGraphRecordIfSafe(workspaceId, graphRecord);
  const persistedRecord = await getGraphRecordFromHosted(workspaceId);
  return buildGraphPayload(workspaceId, persistedRecord ?? graphRecord);
}

export const hostedClaimGraphStore: ClaimGraphStore = {
  async createWorkspace(question, settings, sourceUrls = [], options) {
    const now = nowIso();
    const runtimeDefaults = getClaimGraphRuntimeConfig().defaultWorkspaceSettings;
    const workspace: Workspace = {
      id: crypto.randomUUID(),
      question,
      createdAt: now,
      updatedAt: now,
      settings: {
        ...runtimeDefaults,
        ...(settings ?? {})
      },
      sourceUrls: clone(sourceUrls)
    };

    await upsertWorkspace(workspace, options);
    return clone(workspace);
  },
  async getWorkspace(workspaceId) {
    if (isSyntheticDemoWorkspaceId(workspaceId)) {
      return clone(buildSyntheticDemoWorkspace());
    }

    const workspace = await getWorkspaceFromHosted(workspaceId);
    return workspace ? clone(workspace) : null;
  },
  async listWorkspaces(limit = 25) {
    const sql = await getReadySql();
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const rows = (await sql.query(
      `
        SELECT data
        FROM claimgraph_workspaces
        WHERE deleted_at IS NULL
        ORDER BY updated_at DESC, created_at DESC
        LIMIT $1
      `,
      [boundedLimit]
    )) as Array<JsonRow>;

    return rows.map((row) => normalizeWorkspace(decodeJson<Workspace>(row.data)));
  },
  async deleteWorkspace(workspaceId) {
    const sql = await getReadySql();
    const rows = (await sql.query(
      "DELETE FROM claimgraph_workspaces WHERE id = $1 RETURNING data",
      [workspaceId]
    )) as Array<JsonRow>;
    const row = rows[0];

    return row
      ? clone(normalizeWorkspace(decodeJson<Workspace>(row.data)))
      : null;
  },
  async deleteWorkspaceIfNoActiveRun(workspaceId) {
    return deleteWorkspaceIfNoActiveRunHosted(workspaceId);
  },
  async matchesWorkspaceWriteCapability(workspaceId, writeCapabilityHash) {
    if (!writeCapabilityHash) {
      return false;
    }

    const sql = await getReadySql();
    const rows = (await sql.query(
      `
        SELECT 1 AS matched
        FROM claimgraph_workspace_capabilities AS capability
        INNER JOIN claimgraph_workspaces AS workspace
          ON workspace.id = capability.workspace_id
        WHERE
          capability.workspace_id = $1
          AND capability.write_capability_hash = $2
          AND workspace.deleted_at IS NULL
        LIMIT 1
      `,
      [workspaceId, writeCapabilityHash]
    )) as Array<{ matched: number }>;

    return rows[0]?.matched === 1;
  },
  async createRun(workspaceId, options) {
    return (await hostedClaimGraphStore.acquireActiveRun(workspaceId, options)).run;
  },
  async acquireActiveRun(workspaceId, options) {
    const workspace = await getWorkspaceFromHosted(workspaceId);

    if (!workspace) {
      throw new Error("Workspace not found.");
    }

    for (let attempt = 0; attempt < RUN_CAS_MAX_ATTEMPTS; attempt += 1) {
      const run = buildQueuedRun(workspaceId, options?.staleAfterMs ?? 90_000);
      const acquired = await acquireHostedRun(
        run,
        options?.staleAfterMs ?? 90_000
      );

      if (acquired) {
        return {
          run: clone(acquired.run),
          created: acquired.created
        };
      }

      if (!(await getWorkspaceFromHosted(workspaceId))) {
        throw new Error("Workspace not found.");
      }
    }

    throw new Error("Could not acquire the workspace analysis run after repeated conflicts.");
  },
  async getRun(runId) {
    if (isSyntheticDemoRunId(runId)) {
      return clone(buildSyntheticDemoRun());
    }

    const run = await getRunFromHosted(runId);
    return run ? clone(run) : null;
  },
  async getLatestRunForWorkspace(workspaceId) {
    if (isSyntheticDemoWorkspaceId(workspaceId)) {
      return clone(buildSyntheticDemoRun());
    }

    const run = await getLatestRunForWorkspaceFromHosted(workspaceId);
    return run ? clone(run) : null;
  },
  async getActiveRunForWorkspace(workspaceId) {
    if (isSyntheticDemoWorkspaceId(workspaceId)) {
      return null;
    }

    const run = await getActiveRunForWorkspaceFromHosted(workspaceId);
    return run ? clone(run) : null;
  },
  async listRunsByStatuses(statuses) {
    if (!statuses.length) {
      return [];
    }

    const sql = await getReadySql();
    const rows = (await sql.query(
      `
        SELECT data
        FROM claimgraph_runs
        WHERE status = ANY($1)
        ORDER BY created_at DESC
      `,
      [statuses]
    )) as Array<JsonRow>;

    return rows.map((row) => decodeJson<Run>(row.data));
  },
  async updateRunStatus(runId, status, statusMessage) {
    return (
      await hostedClaimGraphStore.transitionRunStatus(runId, {
        expectedStatuses: ACTIVE_RUN_STATUSES,
        nextStatus: status,
        statusMessage
      })
    ).run;
  },
  async transitionRunStatus(runId, input) {
    return mutateRunWithCas(
      runId,
      (run) => {
        if (!isRunStage(run.status) || !input.expectedStatuses.includes(run.status)) {
          return false;
        }

        run.status = input.nextStatus;
        run.statusMessage = input.statusMessage;
        run.errorMessage = input.errorMessage;

        if (input.fallbackReason) {
          ensureRunObservability(run).fallbackReason = input.fallbackReason;
        }

        if (isRunStage(input.nextStatus)) {
          openStage(run, input.nextStatus);
        } else {
          const completedAt = nowIso();
          run.completedAt = run.completedAt ?? completedAt;
          closeOpenStage(run, completedAt);
          const execution = run.observability?.execution;

          if (execution) {
            execution.heartbeatAt = completedAt;
            execution.finishedAt = completedAt;

            if (input.nextStatus === "canceled") {
              execution.cancelRequestedAt ??= completedAt;
            }
          }
        }

        return true;
      },
      { requireNewest: true }
    );
  },
  async recordRunHeartbeat(runId, input) {
    return (
      await mutateRunWithCas(
        runId,
        (run) => {
          if (!isRunStage(run.status)) {
            return false;
          }

          const execution = ensureRunExecution(run, input?.staleAfterMs ?? 90_000);
          execution.startedAt ??= run.createdAt;
          execution.heartbeatAt = input?.heartbeatAt ?? nowIso();
          return true;
        },
        { requireNewest: true }
      )
    ).run;
  },
  async recordRunWorkflowDispatch(runId, input) {
    return (
      await mutateRunWithCas(
        runId,
        (run) => {
          if (!isRunStage(run.status)) {
            return false;
          }

          const scheduledAt = input.scheduledAt ?? nowIso();
          const observability = ensureRunObservability(run);
          observability.execution = {
            ...(observability.execution ?? {
              staleAfterMs: 90_000
            }),
            mode: "vercel_workflow",
            workflowRunId: input.workflowRunId,
            scheduledAt,
            heartbeatAt: scheduledAt,
            finishedAt: undefined
          };
          return true;
        },
        { requireNewest: true }
      )
    ).run;
  },
  async recordRunStageModel(runId, stage, model) {
    return (
      await mutateRunWithCas(
        runId,
        (run) => {
          if (run.status !== stage) {
            return false;
          }

          const observability = ensureRunObservability(run);
          const stageObservation = [...observability.stages]
            .reverse()
            .find((item) => item.stage === stage);

          if (!stageObservation) {
            observability.stages.push({
              stage,
              startedAt: nowIso(),
              model
            });
          } else {
            stageObservation.model = model;
          }
          return true;
        },
        { requireNewest: true }
      )
    ).run;
  },
  async setRunFallbackReason(runId, fallbackReason) {
    return (
      await mutateRunWithCas(
        runId,
        (run) => {
          ensureRunObservability(run).fallbackReason = fallbackReason;
          return true;
        },
        { requireNewest: true }
      )
    ).run;
  },
  async addWorkspaceFiles(workspaceId, files) {
    const workspace = await getWorkspaceFromHosted(workspaceId);

    if (!workspace) {
      throw new Error("Workspace not found.");
    }

    workspace.updatedAt = nowIso();
    await upsertWorkspace(workspace);

    for (const file of files) {
      await upsertWorkspaceFile(file);
    }

    return getWorkspaceFilesFromHosted(workspaceId);
  },
  async addWorkspaceFilesIfNoActiveRun(workspaceId, files) {
    return addWorkspaceFilesIfNoActiveRunHosted(workspaceId, files);
  },
  async removeWorkspaceFile(workspaceId, fileId) {
    const files = await getWorkspaceFilesFromHosted(workspaceId);
    const file = files.find((item) => item.id === fileId);

    if (!file) {
      throw new Error("Workspace file not found.");
    }

    const sql = await getReadySql();
    await sql.query(
      `
        DELETE FROM claimgraph_workspace_files
        WHERE workspace_id = $1 AND id = $2
      `,
      [workspaceId, fileId]
    );

    return clone(file);
  },
  async removeWorkspaceFileIfNoActiveRun(workspaceId, fileId, options) {
    return removeWorkspaceFileIfNoActiveRunHosted(
      workspaceId,
      fileId,
      options
    );
  },
  async getWorkspaceFiles(workspaceId) {
    if (isSyntheticDemoWorkspaceId(workspaceId)) {
      return [];
    }

    return getWorkspaceFilesFromHosted(workspaceId);
  },
  async saveWorkspaceGraph(workspaceId, record) {
    const workspace = await getWorkspaceFromHosted(workspaceId);

    if (!workspace) {
      throw new Error("Workspace not found.");
    }

    if (record.origin === "live" || record.runId) {
      throw new Error(
        "Graph write rejected: live run-bound graphs require active atomic completion through completeRunWithGraph."
      );
    }

    const inserted = await insertStarterGraphRecordIfSafe(workspaceId, record);

    if (!inserted) {
      throw new Error(
        "Graph write rejected because the workspace already has a graph or an active run."
      );
    }

    return clone(normalizeWorkspaceGraphRecord(record));
  },
  async completeRunWithGraph(runId, workspaceId, record, options) {
    const workspace = await getWorkspaceFromHosted(workspaceId);

    if (!workspace) {
      throw new Error("Workspace not found.");
    }

    const normalizedRecord = normalizeWorkspaceGraphRecord(record);
    validateClaimGraphArtifacts({
      graph: normalizedRecord.graph,
      sources: normalizedRecord.sources,
      snippets: normalizedRecord.snippets
    });
    const expectedStatuses = options?.expectedStatuses ?? ["assembling"];

    for (let attempt = 0; attempt < RUN_CAS_MAX_ATTEMPTS; attempt += 1) {
      const stored = await getStoredRunFromHosted(runId);

      if (!stored) {
        throw new Error("Run not found.");
      }

      if (
        stored.run.workspaceId !== workspaceId ||
        normalizedRecord.runId !== runId ||
        !isRunStage(stored.run.status) ||
        !expectedStatuses.includes(stored.run.status)
      ) {
        return {
          applied: false,
          run: clone(stored.run),
          graph: null
        };
      }

      const completedAt = nowIso();
      const completedRun = clone(stored.run);
      completedRun.status = "completed";
      completedRun.completedAt = completedAt;
      completedRun.errorMessage = undefined;
      completedRun.statusMessage = options?.statusMessage;
      closeOpenStage(completedRun, completedAt);
      const execution = completedRun.observability?.execution;

      if (execution) {
        execution.heartbeatAt = completedAt;
        execution.finishedAt = completedAt;
      }

      completedRun.metrics = {
        ...computeRunMetrics(
          normalizedRecord.graph,
          normalizedRecord.sources.length,
          normalizedRecord.snippets.length
        ),
        durationMs: Math.max(
          0,
          new Date(completedAt).getTime() - new Date(completedRun.createdAt).getTime()
        )
      };

      const persistedRun = await completeRunWithGraphCas({
        run: completedRun,
        expectedVersion: stored.version,
        expectedStatuses,
        workspaceId,
        record: normalizedRecord
      });

      if (persistedRun) {
        return {
          applied: true,
          run: clone(persistedRun),
          graph: clone(normalizedRecord)
        };
      }

      const currentRun = await getRunFromHosted(runId);
      const latestRun = await getLatestRunForWorkspaceFromHosted(workspaceId);

      if (
        !currentRun ||
        !isRunStage(currentRun.status) ||
        !expectedStatuses.includes(currentRun.status) ||
        latestRun?.id !== runId
      ) {
        return {
          applied: false,
          run: clone(currentRun ?? stored.run),
          graph: null
        };
      }
    }

    throw new Error("Graph completion conflicted repeatedly; retry the operation.");
  },
  async getWorkspaceGraphForRun(runId) {
    if (isSyntheticDemoRunId(runId)) {
      return clone(buildSyntheticDemoGraphRecord());
    }

    const record = await getWorkspaceGraphForRunFromHosted(runId);
    return record ? clone(record) : null;
  },
  async getWorkspaceGraphPayload(workspaceId) {
    if (isSyntheticDemoWorkspaceId(workspaceId)) {
      return buildSyntheticDemoGraphPayload();
    }

    const workspace = await getWorkspaceFromHosted(workspaceId);

    if (!workspace) {
      return null;
    }

    const graphRecord = await getGraphRecordFromHosted(workspaceId);

    if (!graphRecord) {
      return buildGraphPayload(workspaceId, buildStarterGraphRecord(workspace));
    }

    try {
      return await buildGraphPayload(workspaceId, graphRecord);
    } catch {
      return buildGraphPayload(workspaceId, buildStarterGraphRecord(workspace));
    }
  },
  async materializeStarterGraphForWorkspace(workspaceId) {
    return materializeStarterGraphForWorkspaceInHosted(workspaceId);
  },
  async saveEvidencePack(record) {
    const run = await getRunFromHosted(record.runId);

    if (!run) {
      throw new Error("Run not found.");
    }

    const normalizedRecord = normalizeEvidencePackRecord(record);
    await upsertArtifactRecordForActiveRun({
      id: `${run.workspaceId}:${run.id}:evidence_pack`,
      runId: run.id,
      expectedStatus: "gathering",
      artifactType: "evidence_pack",
      createdAt: normalizedRecord.createdAt,
      data: normalizedRecord
    });
    return clone(normalizedRecord);
  },
  async saveClaimInventory(record) {
    const run = await getRunFromHosted(record.runId);

    if (!run) {
      throw new Error("Run not found.");
    }

    const normalizedRecord = normalizeClaimInventoryRecord(record);
    await upsertArtifactRecordForActiveRun({
      id: `${run.workspaceId}:${run.id}:claim_inventory`,
      runId: run.id,
      expectedStatus: "extracting",
      artifactType: "claim_inventory",
      createdAt: normalizedRecord.createdAt,
      data: normalizedRecord
    });
    return clone(normalizedRecord);
  },
  async getEvidencePackForRun(runId) {
    if (isSyntheticDemoRunId(runId)) {
      return null;
    }

    const record = await getArtifactRecordForRun<unknown>(runId, "evidence_pack");
    return record ? tryNormalizeEvidencePackRecord(record).record : null;
  },
  async getClaimInventoryForRun(runId) {
    if (isSyntheticDemoRunId(runId)) {
      return null;
    }

    const record = await getArtifactRecordForRun<unknown>(runId, "claim_inventory");
    return record ? tryReadClaimInventoryRecord(record) : null;
  },
  async getLatestEvidencePack(workspaceId) {
    const record = await getLatestArtifactRecord<unknown>(
      workspaceId,
      "evidence_pack"
    );

    if (!record) {
      return null;
    }

    return tryNormalizeEvidencePackRecord(record).record;
  },
  async getLatestClaimInventory(workspaceId) {
    const record = await getLatestArtifactRecord<unknown>(
      workspaceId,
      "claim_inventory"
    );

    return record ? tryReadClaimInventoryRecord(record) : null;
  },
  async getWorkspaceAlphaAssessment(workspaceId) {
    return getLatestArtifactRecord<WorkspaceAlphaAssessment>(
      workspaceId,
      "workspace_alpha_assessment"
    );
  },
  async saveWorkspaceAlphaAssessment(workspaceId, assessment) {
    const workspace = await getWorkspaceFromHosted(workspaceId);

    if (!workspace) {
      throw new Error("Workspace not found.");
    }

    const existing = await hostedClaimGraphStore.getWorkspaceAlphaAssessment(workspaceId);
    const timestamp = nowIso();
    const nextAssessment: WorkspaceAlphaAssessment = {
      workspaceId,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      ...assessment
    };

    await upsertArtifactRecord({
      id: `${workspaceId}:workspace_alpha_assessment`,
      workspaceId,
      artifactType: "workspace_alpha_assessment",
      createdAt: timestamp,
      data: nextAssessment
    });

    return clone(nextAssessment);
  },
  async recordWorkspaceExportEvent(input: WorkspaceExportEventInput) {
    const event = {
      id: crypto.randomUUID(),
      format: input.format,
      mode: input.mode,
      createdAt: nowIso(),
      success: input.success,
      starterMode: input.starterMode,
      strongestOnly: input.strongestOnly,
      unresolvedOnly: input.unresolvedOnly,
      hiddenKinds: input.hiddenKinds,
      focusClusterId: input.focusClusterId,
      selectedNodeId: input.selectedNodeId,
      savedReviewStateId: input.savedReviewStateId,
      savedReviewStateLabel: input.savedReviewStateLabel,
      reviewBranchFilter: input.reviewBranchFilter,
      reviewSourceFilterId: input.reviewSourceFilterId,
      reviewSourceFilterLabel: input.reviewSourceFilterLabel,
      viewportWidth: input.viewportWidth,
      viewportHeight: input.viewportHeight,
      errorMessage: input.errorMessage,
      artifactStorageProvider: input.artifactStorageProvider,
      artifactKey: input.artifactKey,
      artifactSizeBytes: input.artifactSizeBytes,
      artifactContentType: input.artifactContentType
    };

    for (let attempt = 0; attempt < RUN_CAS_MAX_ATTEMPTS; attempt += 1) {
      const latestRun = await getLatestRunForWorkspaceFromHosted(input.workspaceId);

      if (!latestRun) {
        return null;
      }

      const result = await mutateRunWithCas(
        latestRun.id,
        (run) => {
          ensureRunObservability(run).exportEvents.push(event);
          return true;
        },
        { requireNewest: true }
      );

      if (result.applied) {
        return result.run;
      }
    }

    throw new Error("Export event conflicted repeatedly; retry the operation.");
  },
  async recordWorkspaceArtifactsInvalidated(workspaceId, input) {
    const workspace = await getWorkspaceFromHosted(workspaceId);

    if (!workspace) {
      throw new Error("Workspace not found.");
    }

    const now = nowIso();
    const graphRecord = buildStarterGraphRecord(workspace);
    const run: Run = {
      id: crypto.randomUUID(),
      workspaceId,
      status: "completed",
      createdAt: now,
      completedAt: now,
      statusMessage:
        input?.statusMessage ??
        "Workspace inputs changed. Previous live analysis artifacts were cleared. Run analysis again to rebuild from the remaining files and web sources.",
      metrics: {
        ...computeRunMetrics(
          graphRecord.graph,
          graphRecord.sources.length,
          graphRecord.snippets.length
        ),
        durationMs: 0
      },
      observability: {
        stages: [],
        exportEvents: [],
        retrievalCleanupEvents: input?.cleanupEvents ?? [],
        providerFailureEvents: [],
        fallbackReason: "workspace_inputs_changed"
      }
    };
    const normalizedGraphRecord = normalizeWorkspaceGraphRecord({
      ...graphRecord,
      createdAt: now,
      runId: run.id
    });
    validateClaimGraphArtifacts({
      graph: normalizedGraphRecord.graph,
      sources: normalizedGraphRecord.sources,
      snippets: normalizedGraphRecord.snippets
    });
    const updatedWorkspace = {
      ...workspace,
      updatedAt: now
    };
    const sql = await getReadySql();
    const transactionQueries = [
      sql.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [workspaceId]
      ),
      sql.query(
        `
          UPDATE claimgraph_runs AS active_run
          SET
            completed_at = $3,
            status = 'failed',
            status_message = 'Workspace inputs changed before this analysis could finish.',
            error_message = 'Workspace inputs changed.',
            observability = jsonb_set(
              coalesce(active_run.observability, '{}'::jsonb),
              '{fallbackReason}',
              to_jsonb('workspace_inputs_changed'::text),
              true
            ),
            execution = CASE
              WHEN active_run.execution IS NULL THEN null
              ELSE active_run.execution || jsonb_build_object(
                'heartbeatAt', ($3::timestamptz)::text,
                'finishedAt', ($3::timestamptz)::text
              )
            END,
            data = jsonb_set(
              active_run.data || jsonb_build_object(
                'status', 'failed',
                'completedAt', ($3::timestamptz)::text,
                'statusMessage', 'Workspace inputs changed before this analysis could finish.',
                'errorMessage', 'Workspace inputs changed.'
              ),
              '{observability}',
              coalesce(active_run.data->'observability', '{}'::jsonb) ||
                jsonb_build_object('fallbackReason', 'workspace_inputs_changed') ||
                CASE
                  WHEN active_run.data#>'{observability,execution}' IS NULL THEN '{}'::jsonb
                  ELSE jsonb_build_object(
                    'execution',
                    (active_run.data#>'{observability,execution}') ||
                      jsonb_build_object(
                        'heartbeatAt', ($3::timestamptz)::text,
                        'finishedAt', ($3::timestamptz)::text
                      )
                  )
                END,
              true
            ),
            version = active_run.version + 1
          WHERE active_run.workspace_id = $1
            AND active_run.status = ANY($2)
        `,
        [workspaceId, ACTIVE_RUN_STATUSES, now]
      ),
      sql.query(
        `
          UPDATE claimgraph_workspaces
          SET updated_at = $2, data = $3::jsonb
          WHERE id = $1 AND deleted_at IS NULL
        `,
        [workspaceId, now, encodeJson(updatedWorkspace)]
      ),
      sql.query(
        `
          INSERT INTO claimgraph_runs
            (
              id,
              workspace_id,
              created_at,
              completed_at,
              status,
              status_message,
              error_message,
              metrics,
              observability,
              execution,
              workflow_id,
              version,
              data
            )
          VALUES
            ($1, $2, $3, $4, $5, $6, null, $7::jsonb, $8::jsonb, null, null, 1, $9::jsonb)
        `,
        [
          run.id,
          workspaceId,
          run.createdAt,
          run.completedAt,
          run.status,
          run.statusMessage,
          encodeJson(run.metrics ?? null),
          encodeJson(run.observability ?? null),
          encodeJson(run)
        ]
      ),
      sql.query(
        `
          DELETE FROM claimgraph_artifact_records
          WHERE workspace_id = $1
            AND artifact_type IN ('evidence_pack', 'claim_inventory')
        `,
        [workspaceId]
      ),
      sql.query(
        `
          INSERT INTO claimgraph_graph_records
            (
              workspace_id,
              run_id,
              record_version,
              origin,
              mode,
              provider,
              backend,
              model,
              response_id,
              created_at,
              graph,
              sources,
              snippets,
              data
            )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb)
          ON CONFLICT(workspace_id) DO UPDATE SET
            run_id = excluded.run_id,
            record_version = excluded.record_version,
            origin = excluded.origin,
            mode = excluded.mode,
            provider = excluded.provider,
            backend = excluded.backend,
            model = excluded.model,
            response_id = excluded.response_id,
            created_at = excluded.created_at,
            graph = excluded.graph,
            sources = excluded.sources,
            snippets = excluded.snippets,
            data = excluded.data
        `,
        [
          workspaceId,
          run.id,
          normalizedGraphRecord.recordVersion ?? null,
          normalizedGraphRecord.origin,
          normalizedGraphRecord.mode,
          normalizedGraphRecord.provider,
          normalizedGraphRecord.backend ?? null,
          normalizedGraphRecord.model,
          normalizedGraphRecord.responseId ?? null,
          normalizedGraphRecord.createdAt,
          encodeJson(normalizedGraphRecord.graph),
          encodeJson(normalizedGraphRecord.sources),
          encodeJson(normalizedGraphRecord.snippets),
          encodeJson(normalizedGraphRecord)
        ]
      ),
      sql.query("DELETE FROM claimgraph_sources WHERE workspace_id = $1", [
        workspaceId
      ]),
      sql.query("DELETE FROM claimgraph_snippets WHERE workspace_id = $1", [
        workspaceId
      ]),
      ...normalizedGraphRecord.sources.map((source) =>
        sql.query(
          `
            INSERT INTO claimgraph_sources
              (
                id,
                workspace_id,
                run_id,
                source_type,
                source_kind,
                title,
                url,
                file_name,
                domain,
                published_at,
                is_primary,
                data
              )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
          `,
          [
            source.id,
            workspaceId,
            run.id,
            source.type,
            source.sourceKind ?? null,
            source.title,
            source.url ?? null,
            source.fileName ?? null,
            source.domain ?? null,
            normalizeHostedTimestampForColumn(source.publishedAt),
            source.isPrimary ?? null,
            encodeJson(source)
          ]
        )
      ),
      ...normalizedGraphRecord.snippets.map((snippet) =>
        sql.query(
          `
            INSERT INTO claimgraph_snippets
              (
                id,
                workspace_id,
                run_id,
                source_id,
                origin,
                location_label,
                page_number,
                offset_start,
                offset_end,
                relevance,
                text,
                rationale,
                data
              )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
          `,
          [
            snippet.id,
            workspaceId,
            run.id,
            snippet.sourceId,
            snippet.origin ?? null,
            snippet.locationLabel ?? null,
            snippet.pageNumber ?? null,
            snippet.offsetStart ?? null,
            snippet.offsetEnd ?? null,
            snippet.relevance,
            snippet.text,
            snippet.rationale,
            encodeJson(snippet)
          ]
        )
      )
    ];

    await sql.transaction(transactionQueries);

    return clone(run);
  }
};
