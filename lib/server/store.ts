import { buildStarterDataset } from "@/lib/demo/graph-template";
import { computeRunMetrics } from "@/lib/graph/score";
import { repairLiveGraphDisagreementClusters } from "@/lib/graph/live-assembly";
import { stabilizeClaimInventory } from "@/lib/pipeline/claim-inventory";
import { enhanceGraphReviewLabels } from "@/lib/provenance/source-notes";
import {
  withClaimGraphDatabase,
  type ClaimGraphDatabase as DatabaseSync
} from "@/lib/server/database";
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
import type {
  ClaimGraph,
  RetrievalArtifactRecord,
  ClaimInventoryRecord,
  EvidencePackRecord,
  ExportFormat,
  ExportMode,
  HostedOpenModelHealthCheck,
  NodeKind,
  ProviderFailureEvent,
  RetrievalCleanupEvent,
  Run,
  RunExecution,
  RunFallbackReason,
  RunStage,
  Snippet,
  Source,
  WorkspaceAlphaAssessment,
  Workspace,
  WorkspaceFile,
  WorkspaceGraphRecord,
  WorkspaceGraphPayload,
  WorkspaceSettings
} from "@/types/claimgraph";

export interface WorkspaceRetrievalFileBinding {
  workspaceFileId: string;
  openAIFileId: string;
  vectorStoreFileId: string;
  syncedAt: string;
}

export interface WorkspaceRetrievalState {
  workspaceId: string;
  vectorStoreId?: string;
  fileBindings: WorkspaceRetrievalFileBinding[];
  transientArtifacts?: RetrievalArtifactRecord[];
  pendingCleanup?: RetrievalCleanupEvent[];
  cleanupHistory?: RetrievalCleanupEvent[];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function nowIso() {
  return new Date().toISOString();
}

function parseJsonRow<T>(row: { data: string } | undefined | null) {
  return row ? (JSON.parse(row.data) as T) : null;
}

function parseJsonRows<T>(rows: Array<{ data: string }>) {
  return rows.map((row) => JSON.parse(row.data) as T);
}

function parseStoredArtifactJson(data: string) {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
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

function isRunStage(value: Run["status"]): value is RunStage {
  return value === "queued" ||
    value === "ingesting" ||
    value === "gathering" ||
    value === "extracting" ||
    value === "assembling";
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

function ensureWorkspaceRetrievalCollections(state: WorkspaceRetrievalState) {
  state.transientArtifacts ??= [];
  state.pendingCleanup ??= [];
  state.cleanupHistory ??= [];
  return state;
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

function getWorkspaceFromDb(db: DatabaseSync, workspaceId: string) {
  const row = db.prepare(`
    SELECT data FROM workspaces WHERE id = ?
  `).get(workspaceId) as { data: string } | undefined;

  const workspace = parseJsonRow<Workspace>(row);

  if (!workspace) {
    return null;
  }

  return {
    ...workspace,
    settings: {
      ...getClaimGraphRuntimeConfig().defaultWorkspaceSettings,
      ...(workspace.settings ?? {})
    },
    sourceUrls: Array.isArray(workspace.sourceUrls) ? workspace.sourceUrls : []
  } satisfies Workspace;
}

function upsertWorkspaceWriteCapabilityHash(
  db: DatabaseSync,
  workspaceId: string,
  writeCapabilityHash: string
) {
  db.prepare(`
    INSERT INTO workspace_capabilities
      (workspace_id, write_capability_hash, created_at)
    VALUES (?, ?, ?)
    ON CONFLICT(workspace_id) DO UPDATE SET
      write_capability_hash = excluded.write_capability_hash
  `).run(workspaceId, writeCapabilityHash, nowIso());
}

function matchesWorkspaceWriteCapabilityInDb(
  db: DatabaseSync,
  workspaceId: string,
  writeCapabilityHash: string
) {
  const row = db.prepare(`
    SELECT 1 AS matched
    FROM workspace_capabilities
    WHERE workspace_id = ? AND write_capability_hash = ?
    LIMIT 1
  `).get(workspaceId, writeCapabilityHash) as { matched: number } | undefined;

  return row?.matched === 1;
}

function listWorkspacesFromDb(db: DatabaseSync, limit: number) {
  const rows = db.prepare(`
    SELECT data
    FROM workspaces
    ORDER BY updated_at DESC, created_at DESC
    LIMIT ?
  `).all(limit) as Array<{ data: string }>;

  return parseJsonRows<Workspace>(rows).map((workspace) => ({
    ...workspace,
    settings: {
      ...getClaimGraphRuntimeConfig().defaultWorkspaceSettings,
      ...(workspace.settings ?? {})
    },
    sourceUrls: Array.isArray(workspace.sourceUrls) ? workspace.sourceUrls : []
  } satisfies Workspace));
}

function getRunFromDb(db: DatabaseSync, runId: string) {
  const row = db.prepare(`
    SELECT data FROM runs WHERE id = ?
  `).get(runId) as { data: string } | undefined;

  return parseJsonRow<Run>(row);
}

function getLatestRunForWorkspaceDb(db: DatabaseSync, workspaceId: string) {
  const row = db.prepare(`
    SELECT data
    FROM runs
    WHERE workspace_id = ?
    ORDER BY seq DESC
    LIMIT 1
  `).get(workspaceId) as { data: string } | undefined;

  return parseJsonRow<Run>(row);
}

function getActiveRunForWorkspaceDb(db: DatabaseSync, workspaceId: string) {
  const row = db.prepare(`
    SELECT data
    FROM runs
    WHERE workspace_id = ?
      AND status IN ('queued', 'ingesting', 'gathering', 'extracting', 'assembling')
    ORDER BY seq DESC
    LIMIT 1
  `).get(workspaceId) as { data: string } | undefined;

  return parseJsonRow<Run>(row);
}

function listRunsByStatusesFromDb(
  db: DatabaseSync,
  statuses: Run["status"][]
) {
  if (!statuses.length) {
    return [] as Run[];
  }

  const placeholders = statuses.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT data
    FROM runs
    WHERE status IN (${placeholders})
    ORDER BY seq DESC
  `).all(...statuses) as Array<{ data: string }>;

  return parseJsonRows<Run>(rows);
}

function getWorkspaceFilesFromDb(db: DatabaseSync, workspaceId: string) {
  const rows = db.prepare(`
    SELECT data
    FROM files
    WHERE workspace_id = ?
    ORDER BY uploaded_at ASC, seq ASC
  `).all(workspaceId) as Array<{ data: string }>;

  return parseJsonRows<WorkspaceFile>(rows);
}

function getWorkspaceFileFromDb(
  db: DatabaseSync,
  workspaceId: string,
  fileId: string
) {
  const row = db.prepare(`
    SELECT data
    FROM files
    WHERE workspace_id = ? AND id = ?
    LIMIT 1
  `).get(workspaceId, fileId) as { data: string } | undefined;

  return parseJsonRow<WorkspaceFile>(row);
}

function getEvidencePackFromDb(db: DatabaseSync, runId: string) {
  const row = db.prepare(`
    SELECT data FROM evidence_packs WHERE run_id = ?
  `).get(runId) as { data: string } | undefined;

  if (!row) {
    return null;
  }

  const parsed = parseStoredArtifactJson(row.data);
  return parsed ? tryNormalizeEvidencePackRecord(parsed).record : null;
}

function getLatestEvidencePackForWorkspaceDb(db: DatabaseSync, workspaceId: string) {
  const row = db.prepare(`
    SELECT ep.data
    FROM evidence_packs ep
    JOIN runs r ON r.id = ep.run_id
    WHERE ep.workspace_id = ?
    ORDER BY r.seq DESC
    LIMIT 1
  `).get(workspaceId) as { data: string } | undefined;

  if (!row) {
    return null;
  }

  const parsed = parseStoredArtifactJson(row.data);
  return parsed ? tryNormalizeEvidencePackRecord(parsed).record : null;
}

function getClaimInventoryFromDb(db: DatabaseSync, runId: string) {
  const row = db.prepare(`
    SELECT data FROM claim_inventories WHERE run_id = ?
  `).get(runId) as { data: string } | undefined;

  if (!row) {
    return null;
  }

  const parsed = parseStoredArtifactJson(row.data);
  return parsed ? tryReadClaimInventoryRecord(parsed) : null;
}

function getLatestClaimInventoryForWorkspaceDb(db: DatabaseSync, workspaceId: string) {
  const row = db.prepare(`
    SELECT ci.data
    FROM claim_inventories ci
    JOIN runs r ON r.id = ci.run_id
    WHERE ci.workspace_id = ?
    ORDER BY r.seq DESC
    LIMIT 1
  `).get(workspaceId) as { data: string } | undefined;

  if (!row) {
    return null;
  }

  const parsed = parseStoredArtifactJson(row.data);
  return parsed ? tryReadClaimInventoryRecord(parsed) : null;
}

function getWorkspaceRetrievalStateFromDb(db: DatabaseSync, workspaceId: string) {
  const row = db.prepare(`
    SELECT data FROM retrieval_states WHERE workspace_id = ?
  `).get(workspaceId) as { data: string } | undefined;

  return parseJsonRow<WorkspaceRetrievalState>(row);
}

function getGraphRecordFromDb(db: DatabaseSync, workspaceId: string) {
  const row = db.prepare(`
    SELECT data FROM graphs WHERE workspace_id = ?
  `).get(workspaceId) as { data: string } | undefined;

  if (!row) {
    return null;
  }

  const parsed = parseStoredArtifactJson(row.data);
  return parsed ? tryNormalizeWorkspaceGraphRecord(parsed).record : null;
}

function getWorkspaceGraphForRunFromDb(db: DatabaseSync, runId: string) {
  const row = db.prepare(`
    SELECT data
    FROM graphs
    WHERE run_id = ?
    LIMIT 1
  `).get(runId) as { data: string } | undefined;

  if (!row) {
    return null;
  }

  const parsed = parseStoredArtifactJson(row.data);
  const record = parsed ? tryNormalizeWorkspaceGraphRecord(parsed).record : null;
  return record?.runId === runId ? record : null;
}

function getWorkspaceAlphaAssessmentFromDb(db: DatabaseSync, workspaceId: string) {
  const row = db.prepare(`
    SELECT data
    FROM workspace_alpha_assessments
    WHERE workspace_id = ?
  `).get(workspaceId) as { data: string } | undefined;

  return parseJsonRow<WorkspaceAlphaAssessment>(row);
}

function upsertWorkspace(db: DatabaseSync, workspace: Workspace) {
  db.prepare(`
    INSERT INTO workspaces (id, question, created_at, updated_at, data)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      question = excluded.question,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      data = excluded.data
  `).run(
    workspace.id,
    workspace.question,
    workspace.createdAt,
    workspace.updatedAt,
    JSON.stringify(workspace)
  );
}

function upsertRun(db: DatabaseSync, run: Run) {
  db.prepare(`
    INSERT INTO runs (id, workspace_id, created_at, status, data)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      workspace_id = excluded.workspace_id,
      created_at = excluded.created_at,
      status = excluded.status,
      version = runs.version + 1,
      data = excluded.data
  `).run(
    run.id,
    run.workspaceId,
    run.createdAt,
    run.status,
    JSON.stringify(run)
  );
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

function isNewestRunForWorkspace(db: DatabaseSync, run: Run) {
  return getLatestRunForWorkspaceDb(db, run.workspaceId)?.id === run.id;
}

function upsertFile(db: DatabaseSync, file: WorkspaceFile) {
  db.prepare(`
    INSERT INTO files (id, workspace_id, uploaded_at, data)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      workspace_id = excluded.workspace_id,
      uploaded_at = excluded.uploaded_at,
      data = excluded.data
  `).run(file.id, file.workspaceId, file.uploadedAt, JSON.stringify(file));
}

function deleteWorkspaceFileFromDb(
  db: DatabaseSync,
  workspaceId: string,
  fileId: string
) {
  db.prepare(`
    DELETE FROM files
    WHERE workspace_id = ? AND id = ?
  `).run(workspaceId, fileId);
}

function deleteWorkspaceArtifactsFromDb(db: DatabaseSync, workspaceId: string) {
  db.prepare(`
    DELETE FROM evidence_packs
    WHERE workspace_id = ?
  `).run(workspaceId);

  db.prepare(`
    DELETE FROM claim_inventories
    WHERE workspace_id = ?
  `).run(workspaceId);
}

function deleteWorkspaceFromDb(db: DatabaseSync, workspaceId: string) {
  deleteWorkspaceArtifactsFromDb(db, workspaceId);

  db.prepare(`
    DELETE FROM workspace_alpha_assessments
    WHERE workspace_id = ?
  `).run(workspaceId);

  db.prepare(`
    DELETE FROM retrieval_states
    WHERE workspace_id = ?
  `).run(workspaceId);

  db.prepare(`
    DELETE FROM graphs
    WHERE workspace_id = ?
  `).run(workspaceId);

  db.prepare(`
    DELETE FROM files
    WHERE workspace_id = ?
  `).run(workspaceId);

  db.prepare(`
    DELETE FROM runs
    WHERE workspace_id = ?
  `).run(workspaceId);

  db.prepare(`
    DELETE FROM workspaces
    WHERE id = ?
  `).run(workspaceId);
}

function upsertEvidencePack(
  db: DatabaseSync,
  workspaceId: string,
  record: EvidencePackRecord
) {
  db.prepare(`
    INSERT INTO evidence_packs (run_id, workspace_id, created_at, data)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      workspace_id = excluded.workspace_id,
      created_at = excluded.created_at,
      data = excluded.data
  `).run(record.runId, workspaceId, record.createdAt, JSON.stringify(record));
}

function upsertClaimInventory(
  db: DatabaseSync,
  workspaceId: string,
  record: ClaimInventoryRecord
) {
  db.prepare(`
    INSERT INTO claim_inventories (run_id, workspace_id, created_at, data)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      workspace_id = excluded.workspace_id,
      created_at = excluded.created_at,
      data = excluded.data
  `).run(record.runId, workspaceId, record.createdAt, JSON.stringify(record));
}

function upsertRetrievalState(db: DatabaseSync, state: WorkspaceRetrievalState) {
  db.prepare(`
    INSERT INTO retrieval_states (workspace_id, data)
    VALUES (?, ?)
    ON CONFLICT(workspace_id) DO UPDATE SET
      data = excluded.data
  `).run(state.workspaceId, JSON.stringify(state));
}

function upsertGraphRecord(
  db: DatabaseSync,
  workspaceId: string,
  graphRecord: WorkspaceGraphRecord
) {
  db.prepare(`
    INSERT INTO graphs (workspace_id, created_at, origin, run_id, data)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id) DO UPDATE SET
      created_at = excluded.created_at,
      origin = excluded.origin,
      run_id = excluded.run_id,
      data = excluded.data
  `).run(
    workspaceId,
    graphRecord.createdAt,
    graphRecord.origin,
    graphRecord.runId ?? null,
    JSON.stringify(graphRecord)
  );
}

function upsertWorkspaceAlphaAssessment(
  db: DatabaseSync,
  assessment: WorkspaceAlphaAssessment
) {
  db.prepare(`
    INSERT INTO workspace_alpha_assessments (workspace_id, updated_at, data)
    VALUES (?, ?, ?)
    ON CONFLICT(workspace_id) DO UPDATE SET
      updated_at = excluded.updated_at,
      data = excluded.data
  `).run(
    assessment.workspaceId,
    assessment.updatedAt,
    JSON.stringify(assessment)
  );
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

function buildGraphPayload(
  db: DatabaseSync,
  workspaceId: string,
  graphRecord: WorkspaceGraphRecord
) {
  const workspace = getWorkspaceFromDb(db, workspaceId);

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
  const latestRun = getLatestRunForWorkspaceDb(db, workspaceId);
  const activeRun = getActiveRunForWorkspaceDb(db, workspaceId);
  const graphRunId = effectiveGraphRecord.runId;
  const claimInventory = graphRunId
    ? getClaimInventoryFromDb(db, graphRunId)
    : null;
  const repairedGraph = repairLiveGraphDisagreementClusters({
    graph: effectiveGraphRecord.graph,
    claimInventory: claimInventory?.claimInventory ?? null
  });
  const reviewGraph = enhanceGraphReviewLabels({
    graph: repairedGraph,
    sources: effectiveGraphRecord.sources,
    snippets: effectiveGraphRecord.snippets
  });
  const graph = validateClaimGraphArtifacts({
    graph: reviewGraph,
    sources: effectiveGraphRecord.sources,
    snippets: effectiveGraphRecord.snippets
  });
  const graphRun = graphRunId ? getRunFromDb(db, graphRunId) : null;
  const latestRunArtifacts =
    latestRun && latestRun.id !== graphRun?.id
      ? {
          runId: latestRun.id,
          evidence: getEvidencePackFromDb(db, latestRun.id),
          claimInventory: getClaimInventoryFromDb(db, latestRun.id)
        }
      : null;
  const inProgressArtifacts = activeRun
    ? {
        runId: activeRun.id,
        evidence: getEvidencePackFromDb(db, activeRun.id),
        claimInventory: getClaimInventoryFromDb(db, activeRun.id)
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
    files: getWorkspaceFilesFromDb(db, workspaceId),
    evidence: graphRunId ? getEvidencePackFromDb(db, graphRunId) : null,
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

function materializeStarterGraphForWorkspaceInDb(
  db: DatabaseSync,
  workspaceId: string
) {
  const workspace = getWorkspaceFromDb(db, workspaceId);

  if (!workspace) {
    throw new Error("Workspace not found.");
  }

  const graphRecord = buildStarterGraphRecord(workspace);
  upsertGraphRecord(db, workspaceId, graphRecord);

  return buildGraphPayload(db, workspaceId, graphRecord);
}

export function resetStoreForTests() {
  // No in-memory store state is cached anymore.
}

export function createWorkspace(
  question: string,
  settings?: Partial<WorkspaceSettings>,
  sourceUrls: string[] = [],
  options?: {
    writeCapabilityHash?: string;
  }
) {
  return withClaimGraphDatabase((db) => {
    const create = db.transaction(() => {
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

      upsertWorkspace(db, workspace);

      if (options?.writeCapabilityHash) {
        upsertWorkspaceWriteCapabilityHash(
          db,
          workspace.id,
          options.writeCapabilityHash
        );
      }

      return clone(workspace);
    });

    return create();
  });
}

export function getWorkspace(workspaceId: string) {
  return withClaimGraphDatabase((db) => {
    const workspace = getWorkspaceFromDb(db, workspaceId);
    return workspace ? clone(workspace) : null;
  });
}

export function matchesWorkspaceWriteCapability(
  workspaceId: string,
  writeCapabilityHash: string
) {
  if (!writeCapabilityHash) {
    return false;
  }

  return withClaimGraphDatabase((db) =>
    matchesWorkspaceWriteCapabilityInDb(
      db,
      workspaceId,
      writeCapabilityHash
    )
  );
}

export function listWorkspaces(limit = 25) {
  return withClaimGraphDatabase((db) =>
    clone(listWorkspacesFromDb(db, Math.max(1, Math.min(limit, 100))))
  );
}

export function createRun(
  workspaceId: string,
  options?: {
    staleAfterMs?: number;
  }
) {
  return acquireActiveRun(workspaceId, options).run;
}

export function acquireActiveRun(
  workspaceId: string,
  options?: {
    staleAfterMs?: number;
  }
) {
  return withClaimGraphDatabase((db) =>
    db.transaction(() => {
      const workspace = getWorkspaceFromDb(db, workspaceId);

      if (!workspace) {
        throw new Error("Workspace not found.");
      }

      const activeRun = getActiveRunForWorkspaceDb(db, workspaceId);
      const latestRun = getLatestRunForWorkspaceDb(db, workspaceId);

      if (activeRun && latestRun?.id === activeRun.id) {
        return {
          run: clone(activeRun),
          created: false
        };
      }

      if (activeRun) {
        const supersededAt = nowIso();
        activeRun.status = "failed";
        activeRun.completedAt = supersededAt;
        activeRun.errorMessage =
          "A newer workspace run superseded this analysis before it could finish.";
        activeRun.statusMessage =
          "Run superseded by a newer workspace state.";
        closeOpenStage(activeRun, supersededAt);
        const execution = activeRun.observability?.execution;

        if (execution) {
          execution.heartbeatAt = supersededAt;
          execution.finishedAt = supersededAt;
        }

        upsertRun(db, activeRun);
      }

      const run = buildQueuedRun(workspaceId, options?.staleAfterMs ?? 90_000);
      upsertRun(db, run);
      return {
        run: clone(run),
        created: true
      };
    }).immediate()
  );
}

export function getRun(runId: string) {
  return withClaimGraphDatabase((db) => {
    const run = getRunFromDb(db, runId);
    return run ? clone(run) : null;
  });
}

export function getLatestRunForWorkspace(workspaceId: string) {
  return withClaimGraphDatabase((db) => {
    const run = getLatestRunForWorkspaceDb(db, workspaceId);
    return run ? clone(run) : null;
  });
}

export function getActiveRunForWorkspace(workspaceId: string) {
  return withClaimGraphDatabase((db) => {
    const run = getActiveRunForWorkspaceDb(db, workspaceId);
    return run ? clone(run) : null;
  });
}

export function listRunsByStatuses(statuses: Run["status"][]) {
  return withClaimGraphDatabase((db) => {
    return clone(listRunsByStatusesFromDb(db, statuses));
  });
}

export function updateRunStatus(runId: string, status: Run["status"], statusMessage?: string) {
  return transitionRunStatus(runId, {
    expectedStatuses: ["queued", "ingesting", "gathering", "extracting", "assembling"],
    nextStatus: status,
    statusMessage
  }).run;
}

export function transitionRunStatus(
  runId: string,
  input: {
    expectedStatuses: Run["status"][];
    nextStatus: Run["status"];
    statusMessage?: string;
    errorMessage?: string;
    fallbackReason?: RunFallbackReason;
  }
) {
  return withClaimGraphDatabase((db) =>
    db.transaction(() => {
      const run = getRunFromDb(db, runId);

      if (!run) {
        throw new Error("Run not found.");
      }

      if (
        !isRunStage(run.status) ||
        !input.expectedStatuses.includes(run.status) ||
        !isNewestRunForWorkspace(db, run)
      ) {
        return {
          applied: false,
          run: clone(run)
        };
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

      upsertRun(db, run);
      return {
        applied: true,
        run: clone(run)
      };
    }).immediate()
  );
}

export function markRunExecutionStarted(
  runId: string,
  input: {
    ownerId: string;
    startedAt?: string;
    heartbeatAt?: string;
    staleAfterMs?: number;
  }
) {
  return withClaimGraphDatabase((db) => {
    const run = getRunFromDb(db, runId);

    if (!run) {
      throw new Error("Run not found.");
    }

    const startedAt = input.startedAt ?? nowIso();
    const execution = ensureRunExecution(run, input.staleAfterMs ?? 90_000);
    execution.ownerId = input.ownerId;
    execution.startedAt = startedAt;
    execution.heartbeatAt = input.heartbeatAt ?? startedAt;
    execution.finishedAt = undefined;
    upsertRun(db, run);

    return clone(run);
  });
}

export function heartbeatRunExecution(
  runId: string,
  input?: {
    heartbeatAt?: string;
    staleAfterMs?: number;
  }
) {
  return withClaimGraphDatabase((db) => {
    const run = getRunFromDb(db, runId);

    if (!run) {
      throw new Error("Run not found.");
    }

    if (!isRunStage(run.status)) {
      return clone(run);
    }

    const execution = ensureRunExecution(run, input?.staleAfterMs ?? 90_000);

    if (!execution.startedAt) {
      execution.startedAt = run.createdAt;
    }

    execution.heartbeatAt = input?.heartbeatAt ?? nowIso();
    upsertRun(db, run);

    return clone(run);
  });
}

export function recordRunWorkflowDispatch(
  runId: string,
  input: {
    workflowRunId: string;
    scheduledAt?: string;
  }
) {
  return withClaimGraphDatabase((db) => {
    const run = getRunFromDb(db, runId);

    if (!run) {
      throw new Error("Run not found.");
    }

    const scheduledAt = input.scheduledAt ?? nowIso();
    const execution = ensureRunExecution(run, run.observability?.execution?.staleAfterMs ?? 90_000);
    execution.mode = "vercel_workflow";
    execution.workflowRunId = input.workflowRunId;
    execution.scheduledAt = scheduledAt;
    execution.heartbeatAt = scheduledAt;
    execution.finishedAt = undefined;
    upsertRun(db, run);

    return clone(run);
  });
}

export function recordRunHostedOpenModelHealth(
  runId: string,
  hostedOpenModelHealth: HostedOpenModelHealthCheck
) {
  return withClaimGraphDatabase((db) => {
    const run = getRunFromDb(db, runId);

    if (!run) {
      throw new Error("Run not found.");
    }

    const observability = ensureRunObservability(run);
    observability.hostedOpenModelHealth = hostedOpenModelHealth;
    upsertRun(db, run);

    return clone(run);
  });
}

export function getWorkspaceFiles(workspaceId: string) {
  return withClaimGraphDatabase((db) => clone(getWorkspaceFilesFromDb(db, workspaceId)));
}

export function getWorkspaceFile(workspaceId: string, fileId: string) {
  return withClaimGraphDatabase((db) => {
    const file = getWorkspaceFileFromDb(db, workspaceId, fileId);
    return file ? clone(file) : null;
  });
}

export function addWorkspaceFiles(workspaceId: string, files: WorkspaceFile[]) {
  return withClaimGraphDatabase((db) => {
    const workspace = getWorkspaceFromDb(db, workspaceId);

    if (!workspace) {
      throw new Error("Workspace not found.");
    }

    const now = nowIso();
    workspace.updatedAt = now;
    upsertWorkspace(db, workspace);

    for (const file of files) {
      upsertFile(db, file);
    }

    return clone(getWorkspaceFilesFromDb(db, workspaceId));
  });
}

export function addWorkspaceFilesIfNoActiveRun(
  workspaceId: string,
  files: WorkspaceFile[]
) {
  if (files.some((file) => file.workspaceId !== workspaceId)) {
    throw new Error("Workspace file belongs to a different workspace.");
  }

  return withClaimGraphDatabase((db) =>
    db.transaction(() => {
      const workspace = getWorkspaceFromDb(db, workspaceId);

      if (!workspace) {
        throw new Error("Workspace not found.");
      }

      const activeRun = getActiveRunForWorkspaceDb(db, workspaceId);

      if (activeRun) {
        return {
          applied: false as const,
          reason: "active_run" as const,
          activeRun: clone(activeRun)
        };
      }

      workspace.updatedAt = nowIso();
      upsertWorkspace(db, workspace);

      for (const file of files) {
        upsertFile(db, file);
      }

      return {
        applied: true as const,
        files: clone(getWorkspaceFilesFromDb(db, workspaceId))
      };
    }).immediate()
  );
}

export function removeWorkspaceFile(workspaceId: string, fileId: string) {
  return withClaimGraphDatabase((db) => {
    const workspace = getWorkspaceFromDb(db, workspaceId);

    if (!workspace) {
      throw new Error("Workspace not found.");
    }

    const file = getWorkspaceFileFromDb(db, workspaceId, fileId);

    if (!file) {
      throw new Error("Workspace file not found.");
    }

    workspace.updatedAt = nowIso();
    upsertWorkspace(db, workspace);
    deleteWorkspaceFileFromDb(db, workspaceId, fileId);

    return clone(file);
  });
}

export function removeWorkspaceFileIfNoActiveRun(
  workspaceId: string,
  fileId: string,
  options?: {
    invalidateArtifacts?: boolean;
    statusMessage?: string;
    cleanupEvents?: RetrievalCleanupEvent[];
  }
) {
  return withClaimGraphDatabase((db) =>
    db.transaction(() => {
      const workspace = getWorkspaceFromDb(db, workspaceId);

      if (!workspace) {
        throw new Error("Workspace not found.");
      }

      const activeRun = getActiveRunForWorkspaceDb(db, workspaceId);

      if (activeRun) {
        return {
          applied: false as const,
          reason: "active_run" as const,
          activeRun: clone(activeRun)
        };
      }

      const file = getWorkspaceFileFromDb(db, workspaceId, fileId);

      if (!file) {
        throw new Error("Workspace file not found.");
      }

      workspace.updatedAt = nowIso();
      upsertWorkspace(db, workspace);
      deleteWorkspaceFileFromDb(db, workspaceId, fileId);
      let invalidationRunId: string | undefined;

      if (options?.invalidateArtifacts) {
        invalidationRunId = invalidateWorkspaceArtifactsInDb(db, workspace, {
          statusMessage: options.statusMessage,
          cleanupEvents: options.cleanupEvents
        }).id;
      }

      return {
        applied: true as const,
        file: clone(file),
        files: clone(getWorkspaceFilesFromDb(db, workspaceId)),
        artifactsInvalidated: options?.invalidateArtifacts === true,
        invalidationRunId
      };
    }).immediate()
  );
}

export function saveEvidencePack(record: EvidencePackRecord) {
  return withClaimGraphDatabase((db) =>
    db.transaction(() => {
      const run = getRunFromDb(db, record.runId);

      if (!run) {
        throw new Error("Run not found.");
      }

      if (run.status !== "gathering" || !isNewestRunForWorkspace(db, run)) {
        throw new Error(
          "Evidence pack write rejected because the run left gathering or was superseded."
        );
      }

      const normalizedRecord = normalizeEvidencePackRecord(record);
      upsertEvidencePack(db, run.workspaceId, normalizedRecord);
      return clone(normalizedRecord);
    }).immediate()
  );
}

export function getEvidencePack(runId: string) {
  return withClaimGraphDatabase((db) => {
    const record = getEvidencePackFromDb(db, runId);
    return record ? clone(record) : null;
  });
}

export function getEvidencePackForRun(runId: string) {
  return getEvidencePack(runId);
}

export function getLatestEvidencePack(workspaceId: string) {
  return withClaimGraphDatabase((db) => {
    const record = getLatestEvidencePackForWorkspaceDb(db, workspaceId);
    return record ? clone(record) : null;
  });
}

export function saveClaimInventory(record: ClaimInventoryRecord) {
  return withClaimGraphDatabase((db) =>
    db.transaction(() => {
      const run = getRunFromDb(db, record.runId);

      if (!run) {
        throw new Error("Run not found.");
      }

      if (run.status !== "extracting" || !isNewestRunForWorkspace(db, run)) {
        throw new Error(
          "Claim inventory write rejected because the run left extracting or was superseded."
        );
      }

      const normalizedRecord = normalizeClaimInventoryRecord(record);
      upsertClaimInventory(db, run.workspaceId, normalizedRecord);
      return clone(normalizedRecord);
    }).immediate()
  );
}

export function getClaimInventory(runId: string) {
  return withClaimGraphDatabase((db) => {
    const record = getClaimInventoryFromDb(db, runId);
    return record ? clone(record) : null;
  });
}

export function getClaimInventoryForRun(runId: string) {
  return getClaimInventory(runId);
}

export function getLatestClaimInventory(workspaceId: string) {
  return withClaimGraphDatabase((db) => {
    const record = getLatestClaimInventoryForWorkspaceDb(db, workspaceId);
    return record ? clone(record) : null;
  });
}

export function getWorkspaceRetrievalState(workspaceId: string) {
  return withClaimGraphDatabase((db) => {
    const state = getWorkspaceRetrievalStateFromDb(db, workspaceId);
    return state ? clone(ensureWorkspaceRetrievalCollections(state)) : null;
  });
}

export function getWorkspaceAlphaAssessment(workspaceId: string) {
  return withClaimGraphDatabase((db) => {
    const assessment = getWorkspaceAlphaAssessmentFromDb(db, workspaceId);
    return assessment ? clone(assessment) : null;
  });
}

export function saveWorkspaceAlphaAssessment(
  workspaceId: string,
  assessment: Omit<WorkspaceAlphaAssessment, "workspaceId" | "createdAt" | "updatedAt">
) {
  return withClaimGraphDatabase((db) => {
    const workspace = getWorkspaceFromDb(db, workspaceId);

    if (!workspace) {
      throw new Error("Workspace not found.");
    }

    const existing = getWorkspaceAlphaAssessmentFromDb(db, workspaceId);
    const timestamp = nowIso();
    const nextAssessment: WorkspaceAlphaAssessment = {
      workspaceId,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      ...assessment
    };

    upsertWorkspaceAlphaAssessment(db, nextAssessment);
    return clone(nextAssessment);
  });
}

export function saveWorkspaceRetrievalState(state: WorkspaceRetrievalState) {
  return withClaimGraphDatabase((db) => {
    const normalizedState = ensureWorkspaceRetrievalCollections({
      ...state
    });
    upsertRetrievalState(db, normalizedState);
    return clone(normalizedState);
  });
}

export function saveWorkspaceGraph(
  workspaceId: string,
  record: WorkspaceGraphRecord
) {
  return withClaimGraphDatabase((db) =>
    db.transaction(() => {
      const workspace = getWorkspaceFromDb(db, workspaceId);

      if (!workspace) {
        throw new Error("Workspace not found.");
      }

      if (record.runId) {
        const run = getRunFromDb(db, record.runId);

        if (
          !run ||
          run.workspaceId !== workspaceId ||
          !isRunStage(run.status) ||
          !isNewestRunForWorkspace(db, run)
        ) {
          throw new Error(
            "Graph write rejected because the run is missing, terminal, or superseded."
          );
        }
      } else if (record.origin === "live") {
        throw new Error("Live graph writes must be bound to a run.");
      }

      const normalizedRecord = normalizeWorkspaceGraphRecord(record);

      validateClaimGraphArtifacts({
        graph: normalizedRecord.graph,
        sources: normalizedRecord.sources,
        snippets: normalizedRecord.snippets
      });

      workspace.updatedAt = nowIso();
      upsertWorkspace(db, workspace);
      upsertGraphRecord(db, workspaceId, normalizedRecord);

      return clone(normalizedRecord);
    }).immediate()
  );
}

export function completeRunWithGraph(
  runId: string,
  workspaceId: string,
  record: WorkspaceGraphRecord,
  options?: {
    expectedStatuses?: Run["status"][];
    statusMessage?: string;
  }
) {
  return withClaimGraphDatabase((db) =>
    db.transaction(() => {
      const run = getRunFromDb(db, runId);
      const workspace = getWorkspaceFromDb(db, workspaceId);

      if (!run) {
        throw new Error("Run not found.");
      }

      if (!workspace) {
        throw new Error("Workspace not found.");
      }

      const expectedStatuses = options?.expectedStatuses ?? ["assembling"];

      if (
        run.workspaceId !== workspaceId ||
        record.runId !== runId ||
        !isRunStage(run.status) ||
        !expectedStatuses.includes(run.status) ||
        !isNewestRunForWorkspace(db, run)
      ) {
        return {
          applied: false,
          run: clone(run),
          graph: null
        };
      }

      const normalizedRecord = normalizeWorkspaceGraphRecord(record);
      validateClaimGraphArtifacts({
        graph: normalizedRecord.graph,
        sources: normalizedRecord.sources,
        snippets: normalizedRecord.snippets
      });

      const completedAt = nowIso();
      workspace.updatedAt = completedAt;
      upsertWorkspace(db, workspace);
      upsertGraphRecord(db, workspaceId, normalizedRecord);

      run.status = "completed";
      run.completedAt = completedAt;
      run.errorMessage = undefined;
      run.statusMessage = options?.statusMessage;
      closeOpenStage(run, completedAt);
      const execution = run.observability?.execution;

      if (execution) {
        execution.heartbeatAt = completedAt;
        execution.finishedAt = completedAt;
      }

      run.metrics = {
        ...computeRunMetrics(
          normalizedRecord.graph,
          normalizedRecord.sources.length,
          normalizedRecord.snippets.length
        ),
        durationMs: Math.max(
          0,
          new Date(completedAt).getTime() - new Date(run.createdAt).getTime()
        )
      };
      upsertRun(db, run);

      return {
        applied: true,
        run: clone(run),
        graph: clone(normalizedRecord)
      };
    }).immediate()
  );
}

export function getWorkspaceGraphForRun(runId: string) {
  return withClaimGraphDatabase((db) => {
    const record = getWorkspaceGraphForRunFromDb(db, runId);
    return record ? clone(record) : null;
  });
}

function invalidateWorkspaceArtifactsInDb(
  db: DatabaseSync,
  workspace: Workspace,
  input?: {
    statusMessage?: string;
    cleanupEvents?: RetrievalCleanupEvent[];
  }
) {
  const workspaceId = workspace.id;
  const now = nowIso();
  const activeRun = getActiveRunForWorkspaceDb(db, workspaceId);

  if (activeRun) {
    activeRun.status = "failed";
    activeRun.completedAt = now;
    activeRun.errorMessage = "Workspace inputs changed.";
    activeRun.statusMessage =
      "Workspace inputs changed before this analysis could finish.";
    ensureRunObservability(activeRun).fallbackReason = "workspace_inputs_changed";
    closeOpenStage(activeRun, now);
    const execution = activeRun.observability?.execution;

    if (execution) {
      execution.heartbeatAt = now;
      execution.finishedAt = now;
    }

    upsertRun(db, activeRun);
  }

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

  workspace.updatedAt = now;
  upsertWorkspace(db, workspace);
  deleteWorkspaceArtifactsFromDb(db, workspaceId);
  upsertRun(db, run);
  upsertGraphRecord(db, workspaceId, {
    ...graphRecord,
    createdAt: now,
    runId: run.id
  });

  return run;
}

export function recordWorkspaceArtifactsInvalidated(
  workspaceId: string,
  input?: {
    statusMessage?: string;
    cleanupEvents?: RetrievalCleanupEvent[];
  }
) {
  return withClaimGraphDatabase((db) =>
    db.transaction(() => {
      const workspace = getWorkspaceFromDb(db, workspaceId);

      if (!workspace) {
        throw new Error("Workspace not found.");
      }

      return clone(invalidateWorkspaceArtifactsInDb(db, workspace, input));
    }).immediate()
  );
}

export function deleteWorkspace(workspaceId: string) {
  return withClaimGraphDatabase((db) => {
    const workspace = getWorkspaceFromDb(db, workspaceId);

    if (!workspace) {
      return null;
    }

    deleteWorkspaceFromDb(db, workspaceId);

    return clone(workspace);
  });
}

export function deleteWorkspaceIfNoActiveRun(workspaceId: string) {
  return withClaimGraphDatabase((db) =>
    db.transaction(() => {
      const workspace = getWorkspaceFromDb(db, workspaceId);

      if (!workspace) {
        return {
          applied: false as const,
          reason: "not_found" as const
        };
      }

      const activeRun = getActiveRunForWorkspaceDb(db, workspaceId);

      if (activeRun) {
        return {
          applied: false as const,
          reason: "active_run" as const,
          activeRun: clone(activeRun)
        };
      }

      const files = getWorkspaceFilesFromDb(db, workspaceId);
      deleteWorkspaceFromDb(db, workspaceId);

      return {
        applied: true as const,
        workspace: clone(workspace),
        files: clone(files)
      };
    }).immediate()
  );
}

export function getStarterGraphPayload(workspaceId: string) {
  return withClaimGraphDatabase((db) => {
    const workspace = getWorkspaceFromDb(db, workspaceId);

    if (!workspace) {
      return null;
    }

    return buildGraphPayload(db, workspaceId, buildStarterGraphRecord(workspace));
  });
}

export function materializeStarterGraphForWorkspace(workspaceId: string) {
  return withClaimGraphDatabase((db) =>
    materializeStarterGraphForWorkspaceInDb(db, workspaceId)
  );
}

export function markRunCompleted(
  runId: string,
  graph: ClaimGraph,
  options?: {
    sourceCount?: number;
    snippetCount?: number;
    statusMessage?: string;
  }
) {
  return withClaimGraphDatabase((db) => {
    const run = getRunFromDb(db, runId);

    if (!run) {
      throw new Error("Run not found.");
    }

    if (!isRunStage(run.status) || !isNewestRunForWorkspace(db, run)) {
      return clone(run);
    }

    const payload = getGraphRecordFromDb(db, run.workspaceId);
    const sourceCount = options?.sourceCount ?? payload?.sources.length ?? 0;
    const snippetCount = options?.snippetCount ?? payload?.snippets.length ?? 0;
    const completedAt = nowIso();

    run.status = "completed";
    run.completedAt = completedAt;
    run.errorMessage = undefined;
    run.statusMessage = options?.statusMessage;
    closeOpenStage(run, completedAt);
    const execution = run.observability?.execution;

    if (execution) {
      execution.heartbeatAt = completedAt;
      execution.finishedAt = completedAt;
    }

    run.metrics = {
      ...computeRunMetrics(graph, sourceCount, snippetCount),
      durationMs: Math.max(
        0,
        new Date(completedAt).getTime() - new Date(run.createdAt).getTime()
      )
    };

    upsertRun(db, run);

    return clone(run);
  });
}

export function markRunInsufficientEvidence(
  runId: string,
  graph: ClaimGraph,
  options?: {
    sourceCount?: number;
    snippetCount?: number;
    statusMessage?: string;
    fallbackReason?: RunFallbackReason;
  }
) {
  return withClaimGraphDatabase((db) => {
    const run = getRunFromDb(db, runId);

    if (!run) {
      throw new Error("Run not found.");
    }

    if (!isRunStage(run.status) || !isNewestRunForWorkspace(db, run)) {
      return clone(run);
    }

    const payload = getGraphRecordFromDb(db, run.workspaceId);
    const sourceCount = options?.sourceCount ?? payload?.sources.length ?? 0;
    const snippetCount = options?.snippetCount ?? payload?.snippets.length ?? 0;
    const completedAt = nowIso();
    const observability = ensureRunObservability(run);

    run.status = "insufficient_evidence";
    run.completedAt = completedAt;
    run.errorMessage = undefined;
    run.statusMessage =
      options?.statusMessage ??
      "The run preserved too little grounded evidence to build a trustworthy live graph, so ClaimGraph kept the most recent safe graph path.";
    closeOpenStage(run, completedAt);

    if (options?.fallbackReason) {
      observability.fallbackReason = options.fallbackReason;
    }

    if (observability.execution) {
      observability.execution.heartbeatAt = completedAt;
      observability.execution.finishedAt = completedAt;
    }

    run.metrics = {
      ...computeRunMetrics(graph, sourceCount, snippetCount),
      durationMs: Math.max(
        0,
        new Date(completedAt).getTime() - new Date(run.createdAt).getTime()
      )
    };

    upsertRun(db, run);

    return clone(run);
  });
}

export function markRunFailed(
  runId: string,
  errorMessage: string,
  options?:
    | string
    | {
        statusMessage?: string;
        fallbackReason?: RunFallbackReason;
      }
) {
  return withClaimGraphDatabase((db) => {
    const run = getRunFromDb(db, runId);

    if (!run) {
      throw new Error("Run not found.");
    }

    if (!isRunStage(run.status) || !isNewestRunForWorkspace(db, run)) {
      return clone(run);
    }

    const statusMessage =
      typeof options === "string" ? options : options?.statusMessage;

    run.status = "failed";
    run.completedAt = nowIso();
    run.errorMessage = errorMessage;
    run.statusMessage = statusMessage;
    closeOpenStage(run, run.completedAt);
    const observability = ensureRunObservability(run);

    if (typeof options !== "string" && options?.fallbackReason) {
      observability.fallbackReason = options.fallbackReason;
    }

    if (observability.execution) {
      observability.execution.heartbeatAt = run.completedAt;
      observability.execution.finishedAt = run.completedAt;
    }

    if (run.metrics) {
      run.metrics.durationMs = Math.max(
        0,
        new Date(run.completedAt).getTime() - new Date(run.createdAt).getTime()
      );
    }

    upsertRun(db, run);

    return clone(run);
  });
}

export function markRunCanceled(
  runId: string,
  options?: {
    statusMessage?: string;
    fallbackReason?: RunFallbackReason;
    canceledAt?: string;
  }
) {
  return withClaimGraphDatabase((db) => {
    const run = getRunFromDb(db, runId);

    if (!run) {
      throw new Error("Run not found.");
    }

    if (!isRunStage(run.status) || !isNewestRunForWorkspace(db, run)) {
      return clone(run);
    }

    const canceledAt = options?.canceledAt ?? nowIso();

    run.status = "canceled";
    run.completedAt = canceledAt;
    run.errorMessage = undefined;
    run.statusMessage =
      options?.statusMessage ??
      "Analysis canceled. The workspace remains on the most recent safe graph path.";
    closeOpenStage(run, canceledAt);
    const observability = ensureRunObservability(run);

    if (options?.fallbackReason) {
      observability.fallbackReason = options.fallbackReason;
    }

    if (observability.execution) {
      observability.execution.cancelRequestedAt ??= canceledAt;
      observability.execution.heartbeatAt = canceledAt;
      observability.execution.finishedAt = canceledAt;
    }

    if (run.metrics) {
      run.metrics.durationMs = Math.max(
        0,
        new Date(canceledAt).getTime() - new Date(run.createdAt).getTime()
      );
    }

    upsertRun(db, run);

    return clone(run);
  });
}

export function recordRunStageModel(runId: string, stage: RunStage, model: string) {
  return withClaimGraphDatabase((db) =>
    db.transaction(() => {
      const run = getRunFromDb(db, runId);

      if (!run) {
        throw new Error("Run not found.");
      }

      if (run.status !== stage || !isNewestRunForWorkspace(db, run)) {
        return clone(run);
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

      upsertRun(db, run);

      return clone(run);
    }).immediate()
  );
}

export function setRunFallbackReason(runId: string, fallbackReason: RunFallbackReason) {
  return withClaimGraphDatabase((db) => {
    const run = getRunFromDb(db, runId);

    if (!run) {
      throw new Error("Run not found.");
    }

    const observability = ensureRunObservability(run);
    observability.fallbackReason = fallbackReason;
    upsertRun(db, run);

    return clone(run);
  });
}

export function recordRunRetrievalCleanupEvent(
  runId: string,
  event: RetrievalCleanupEvent
) {
  return withClaimGraphDatabase((db) => {
    const run = getRunFromDb(db, runId);

    if (!run) {
      throw new Error("Run not found.");
    }

    const observability = ensureRunObservability(run);
    observability.retrievalCleanupEvents ??= [];
    observability.retrievalCleanupEvents.push(event);
    upsertRun(db, run);

    return clone(run);
  });
}

export function recordRunProviderFailureEvent(
  runId: string,
  event: ProviderFailureEvent
) {
  return withClaimGraphDatabase((db) => {
    const run = getRunFromDb(db, runId);

    if (!run) {
      throw new Error("Run not found.");
    }

    const observability = ensureRunObservability(run);
    observability.providerFailureEvents ??= [];
    observability.providerFailureEvents.push(event);
    upsertRun(db, run);

    return clone(run);
  });
}

export function recordWorkspaceExportEvent(input: {
  workspaceId: string;
  format: ExportFormat;
  mode: ExportMode;
  success: boolean;
  starterMode: boolean;
  strongestOnly?: boolean;
  unresolvedOnly?: boolean;
  hiddenKinds?: NodeKind[];
  focusClusterId?: string | null;
  selectedNodeId?: string | null;
  savedReviewStateId?: string | null;
  savedReviewStateLabel?: string | null;
  reviewBranchFilter?: "all" | "left" | "right" | "unresolved";
  reviewSourceFilterId?: string | null;
  reviewSourceFilterLabel?: string | null;
  viewportWidth?: number;
  viewportHeight?: number;
  errorMessage?: string;
  artifactStorageProvider?: "local" | "vercel_blob";
  artifactKey?: string;
  artifactSizeBytes?: number;
  artifactContentType?: string;
}) {
  return withClaimGraphDatabase((db) =>
    db.transaction(() => {
      const run = getLatestRunForWorkspaceDb(db, input.workspaceId);

      if (!run) {
        return null;
      }

      const observability = ensureRunObservability(run);
      observability.exportEvents.push({
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
      });

      upsertRun(db, run);

      return clone(run);
    }).immediate()
  );
}

export function getWorkspaceGraphPayload(workspaceId: string): WorkspaceGraphPayload | null {
  return withClaimGraphDatabase((db) => {
    const workspace = getWorkspaceFromDb(db, workspaceId);

    if (!workspace) {
      return null;
    }

    const graphRecord = getGraphRecordFromDb(db, workspaceId);

    if (!graphRecord) {
      return buildGraphPayload(
        db,
        workspaceId,
        buildStarterGraphRecord(workspace)
      );
    }

    try {
      return buildGraphPayload(db, workspaceId, graphRecord);
    } catch {
      return buildGraphPayload(
        db,
        workspaceId,
        buildStarterGraphRecord(workspace)
      );
    }
  });
}
