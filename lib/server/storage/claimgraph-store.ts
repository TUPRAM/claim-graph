import type {
  ClaimInventoryRecord,
  EvidencePackRecord,
  ExportFormat,
  ExportMode,
  NodeKind,
  RetrievalCleanupEvent,
  Run,
  RunFallbackReason,
  RunStage,
  Workspace,
  WorkspaceAlphaAssessment,
  WorkspaceFile,
  WorkspaceGraphPayload,
  WorkspaceGraphRecord,
  WorkspaceSettings
} from "@/types/claimgraph";

export interface WorkspaceExportEventInput {
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
}

export interface AcquireActiveRunResult {
  run: Run;
  created: boolean;
}

export type DeleteWorkspaceIfNoActiveRunResult =
  | {
      applied: true;
      workspace: Workspace;
      files: WorkspaceFile[];
      cleanupJobId?: string;
    }
  | {
      applied: false;
      reason: "active_run";
      activeRun: Run;
    }
  | {
      applied: false;
      reason: "not_found";
    };

export type GuardedWorkspaceFileAddResult =
  | {
      applied: true;
      files: WorkspaceFile[];
    }
  | {
      applied: false;
      reason: "active_run";
      activeRun: Run;
    };

export type GuardedWorkspaceFileRemoveResult =
  | {
      applied: true;
      file: WorkspaceFile;
      files: WorkspaceFile[];
      artifactsInvalidated: boolean;
      invalidationRunId?: string;
    }
  | {
      applied: false;
      reason: "active_run";
      activeRun: Run;
    };

export interface GuardedWorkspaceFileRemoveOptions {
  invalidateArtifacts?: boolean;
  statusMessage?: string;
  cleanupEvents?: RetrievalCleanupEvent[];
}

export interface RunStatusTransitionInput {
  expectedStatuses: Run["status"][];
  nextStatus: Run["status"];
  statusMessage?: string;
  errorMessage?: string;
  fallbackReason?: RunFallbackReason;
}

export interface RunStatusTransitionResult {
  applied: boolean;
  run: Run;
}

export interface CompleteRunWithGraphResult {
  applied: boolean;
  run: Run;
  graph: WorkspaceGraphRecord | null;
}

export interface CreateWorkspaceOptions {
  writeCapabilityHash?: string;
}

export interface ClaimGraphStore {
  createWorkspace(
    question: string,
    settings?: Partial<WorkspaceSettings>,
    sourceUrls?: string[],
    options?: CreateWorkspaceOptions
  ): Promise<Workspace>;
  getWorkspace(workspaceId: string): Promise<Workspace | null>;
  listWorkspaces(limit?: number): Promise<Workspace[]>;
  deleteWorkspace(workspaceId: string): Promise<Workspace | null>;
  deleteWorkspaceIfNoActiveRun(
    workspaceId: string
  ): Promise<DeleteWorkspaceIfNoActiveRunResult>;
  matchesWorkspaceWriteCapability(
    workspaceId: string,
    writeCapabilityHash: string
  ): Promise<boolean>;
  createRun(workspaceId: string, options?: { staleAfterMs?: number }): Promise<Run>;
  acquireActiveRun(
    workspaceId: string,
    options?: { staleAfterMs?: number }
  ): Promise<AcquireActiveRunResult>;
  getRun(runId: string): Promise<Run | null>;
  getLatestRunForWorkspace(workspaceId: string): Promise<Run | null>;
  getActiveRunForWorkspace(workspaceId: string): Promise<Run | null>;
  listRunsByStatuses(statuses: Run["status"][]): Promise<Run[]>;
  updateRunStatus(
    runId: string,
    status: Run["status"],
    statusMessage?: string
  ): Promise<Run>;
  transitionRunStatus(
    runId: string,
    input: RunStatusTransitionInput
  ): Promise<RunStatusTransitionResult>;
  recordRunHeartbeat(
    runId: string,
    input?: { heartbeatAt?: string; staleAfterMs?: number }
  ): Promise<Run>;
  recordRunWorkflowDispatch(
    runId: string,
    input: { workflowRunId: string; scheduledAt?: string }
  ): Promise<Run>;
  recordRunStageModel(
    runId: string,
    stage: RunStage,
    model: string
  ): Promise<Run>;
  setRunFallbackReason(
    runId: string,
    fallbackReason: RunFallbackReason
  ): Promise<Run>;
  addWorkspaceFiles(
    workspaceId: string,
    files: WorkspaceFile[]
  ): Promise<WorkspaceFile[]>;
  addWorkspaceFilesIfNoActiveRun(
    workspaceId: string,
    files: WorkspaceFile[]
  ): Promise<GuardedWorkspaceFileAddResult>;
  removeWorkspaceFile(
    workspaceId: string,
    fileId: string
  ): Promise<WorkspaceFile>;
  removeWorkspaceFileIfNoActiveRun(
    workspaceId: string,
    fileId: string,
    options?: GuardedWorkspaceFileRemoveOptions
  ): Promise<GuardedWorkspaceFileRemoveResult>;
  getWorkspaceFiles(workspaceId: string): Promise<WorkspaceFile[]>;
  saveWorkspaceGraph(
    workspaceId: string,
    record: WorkspaceGraphRecord
  ): Promise<WorkspaceGraphRecord>;
  completeRunWithGraph(
    runId: string,
    workspaceId: string,
    record: WorkspaceGraphRecord,
    options?: {
      expectedStatuses?: Run["status"][];
      statusMessage?: string;
    }
  ): Promise<CompleteRunWithGraphResult>;
  getWorkspaceGraphForRun(runId: string): Promise<WorkspaceGraphRecord | null>;
  getWorkspaceGraphPayload(
    workspaceId: string
  ): Promise<WorkspaceGraphPayload | null>;
  materializeStarterGraphForWorkspace(
    workspaceId: string
  ): Promise<WorkspaceGraphPayload>;
  saveEvidencePack(record: EvidencePackRecord): Promise<EvidencePackRecord>;
  saveClaimInventory(record: ClaimInventoryRecord): Promise<ClaimInventoryRecord>;
  getEvidencePackForRun(runId: string): Promise<EvidencePackRecord | null>;
  getClaimInventoryForRun(runId: string): Promise<ClaimInventoryRecord | null>;
  getLatestEvidencePack(workspaceId: string): Promise<EvidencePackRecord | null>;
  getLatestClaimInventory(
    workspaceId: string
  ): Promise<ClaimInventoryRecord | null>;
  getWorkspaceAlphaAssessment(
    workspaceId: string
  ): Promise<WorkspaceAlphaAssessment | null>;
  saveWorkspaceAlphaAssessment(
    workspaceId: string,
    assessment: Omit<
      WorkspaceAlphaAssessment,
      "workspaceId" | "createdAt" | "updatedAt"
    >
  ): Promise<WorkspaceAlphaAssessment>;
  recordWorkspaceExportEvent(
    input: WorkspaceExportEventInput
  ): Promise<Run | null>;
  recordWorkspaceArtifactsInvalidated(
    workspaceId: string,
    input?: {
      statusMessage?: string;
      cleanupEvents?: RetrievalCleanupEvent[];
    }
  ): Promise<Run>;
}
