export type SourceType = "web" | "file";
export type Stance = "pro" | "con" | "mixed" | "unknown";
export type NodeKind = "question" | "claim" | "counterclaim" | "evidence" | "gap";
export type EdgeRelation = "supports" | "refutes" | "qualifies" | "depends_on";
export type ClaimGraphMode = "demo" | "open-model" | "full";
export type ClaimGraphProviderId = "starter" | "openai" | "open-model";
export type OpenModelBackend = "ollama" | "vllm" | "tgi";
export type RuntimeLaneStatus = "ready" | "configured" | "blocked";
export type RuntimeLaneId =
  | "selected_runtime"
  | "development_ollama"
  | "launch_vllm"
  | "premium_openai";
export type RunStage = "queued" | "ingesting" | "gathering" | "extracting" | "assembling";
export type SnippetOrigin =
  | "starter_curated"
  | "file_search_result"
  | "file_ingest_excerpt"
  | "web_search_result_excerpt"
  | "web_search_result_summary"
  | "web_citation_summary_span"
  | "url_ingest_excerpt"
  | "unknown";
export type EvidenceGroundingStatus = "grounded" | "insufficient_grounding";
export type RunStatus =
  | "queued"
  | "ingesting"
  | "gathering"
  | "extracting"
  | "assembling"
  | "canceled"
  | "insufficient_evidence"
  | "completed"
  | "failed";
export type RunFallbackReason =
  | "openai_api_key_missing"
  | "open_model_unavailable"
  | "open_model_misconfigured"
  | "insufficient_grounding"
  | "gathering_failed"
  | "extracting_failed"
  | "assembling_failed"
  | "analysis_canceled"
  | "analysis_stale"
  | "workspace_inputs_changed";
export type ExportFormat = "markdown" | "png";
export type ExportMode = "server_markdown" | "client_capture";
export type ReviewBranchFilter = "all" | "left" | "right" | "unresolved";
export type RetrievalArtifactKind = "vector_store" | "vector_store_file" | "openai_file";
export type RetrievalCleanupReason =
  | "run_canceled"
  | "analysis_stale"
  | "sync_failed"
  | "superseded"
  | "file_deleted"
  | "workspace_deleted";
export type RetrievalCleanupStatus = "pending" | "deleted" | "delete_failed" | "skipped";
export type HostedOpenModelCatalogStatus =
  | "succeeded"
  | "auth_rejected"
  | "timed_out"
  | "route_missing"
  | "unreachable"
  | "invalid_payload";
export type HostedOpenModelRequestStatus =
  | "not_started"
  | "succeeded"
  | "succeeded_after_validation_retry"
  | "timed_out"
  | "auth_rejected"
  | "route_missing"
  | "unreachable"
  | "invalid_payload"
  | "model_missing"
  | "response_error"
  | "validation_failed";
export type ProviderFailureReason =
  | "backend_unavailable"
  | "configuration_error"
  | "model_unavailable"
  | "request_timeout"
  | "response_validation_failed"
  | "runner_crash";
export type ProviderFailureCleanupStatus =
  | "not_required"
  | "best_effort_pending"
  | "best_effort_completed"
  | "best_effort_failed";
export type AlphaReviewerRole =
  | "product"
  | "policy"
  | "research"
  | "technical"
  | "other";
export type AlphaAssessmentVerdict =
  | "ready_to_share"
  | "useful_with_notes"
  | "not_ready";

export interface WorkspaceSettings {
  maxWebSources: number;
  maxFiles: number;
  freshnessBias: "low" | "medium" | "high";
  preferPrimarySources: boolean;
  includeOpposingEvidence: boolean;
}

export interface Workspace {
  id: string;
  question: string;
  createdAt: string;
  updatedAt: string;
  settings: WorkspaceSettings;
  sourceUrls: string[];
}

export interface WorkspaceFile {
  id: string;
  workspaceId: string;
  originalName: string;
  storedName: string;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  uploadedAt: string;
  storageProvider?: "local" | "vercel_blob";
  blobKey?: string;
}

export interface RunMetrics {
  sourceCount: number;
  snippetCount: number;
  claimCount: number;
  counterclaimCount: number;
  evidenceCount: number;
  gapCount: number;
  totalNodeCount: number;
  strongestDisagreementScore?: number;
  durationMs?: number;
}

export interface RunStageObservation {
  stage: RunStage;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  model?: string;
}

export interface RunExportEvent {
  id: string;
  format: ExportFormat;
  mode: ExportMode;
  createdAt: string;
  success: boolean;
  starterMode: boolean;
  strongestOnly?: boolean;
  unresolvedOnly?: boolean;
  hiddenKinds?: NodeKind[];
  focusClusterId?: string | null;
  selectedNodeId?: string | null;
  savedReviewStateId?: string | null;
  savedReviewStateLabel?: string | null;
  reviewBranchFilter?: ReviewBranchFilter;
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

export interface WorkspaceReviewStateSnapshot {
  strongestOnly: boolean;
  unresolvedOnly: boolean;
  hiddenKinds: NodeKind[];
  focusClusterId: string | null;
  selectedNodeId: string | null;
  branchFilter: ReviewBranchFilter;
  sourceFilterId: string;
}

export interface WorkspaceSavedReviewState extends WorkspaceReviewStateSnapshot {
  id: string;
  label: string;
  savedAt: string;
}

export interface WorkspaceAlphaAssessment {
  workspaceId: string;
  createdAt: string;
  updatedAt: string;
  reviewerRole: AlphaReviewerRole;
  verdict: AlphaAssessmentVerdict;
  wouldRevisit: boolean;
  wouldShareExport: boolean;
  strongestDisagreementRating: 1 | 2 | 3 | 4 | 5;
  provenanceTrustRating: 1 | 2 | 3 | 4 | 5;
  confusionPoints: string;
  blockerNotes: string;
  followUpQuestion: string;
}

export interface RunExecution {
  mode: "in_process" | "vercel_workflow";
  ownerId?: string;
  workflowRunId?: string;
  scheduledAt: string;
  startedAt?: string;
  heartbeatAt?: string;
  finishedAt?: string;
  staleAfterMs: number;
  cancelRequestedAt?: string;
}

export interface HostedOpenModelHealthCheck {
  backend: "vllm";
  apiBaseUrl: string;
  model: string;
  checkedAt: string;
  timeoutMs: number;
  catalogRoute: string;
  catalogStatus: HostedOpenModelCatalogStatus;
  catalogCache: "hit" | "miss";
  advertisedModelCount?: number;
  completionRoute: string;
  requestStatus: HostedOpenModelRequestStatus;
  requestAttempt?: number;
  requestMaxAttempts?: number;
  lastErrorMessage?: string;
}

export interface ProviderFailureEvent {
  id: string;
  provider: ClaimGraphProviderId;
  backend?: OpenModelBackend;
  stage: RunStage | "runtime";
  createdAt: string;
  reason: ProviderFailureReason;
  message: string;
  cleanupStatus: ProviderFailureCleanupStatus;
  cleanupMessage?: string;
}

export interface RetrievalCleanupEvent {
  id: string;
  kind: RetrievalArtifactKind;
  remoteId: string;
  vectorStoreId?: string;
  workspaceFileId?: string;
  runId?: string;
  reason: RetrievalCleanupReason;
  status: RetrievalCleanupStatus;
  createdAt: string;
  attemptedAt?: string;
  completedAt?: string;
  errorMessage?: string;
}

export interface RetrievalCleanupSummary {
  attemptedCount: number;
  deletedCount: number;
  skippedCount: number;
  failedCount: number;
  pendingCount: number;
  events: RetrievalCleanupEvent[];
}

export interface RetrievalArtifactRecord {
  id: string;
  kind: RetrievalArtifactKind;
  remoteId: string;
  vectorStoreId?: string;
  workspaceFileId?: string;
  runId?: string;
  createdAt: string;
}

export interface RunObservability {
  stages: RunStageObservation[];
  exportEvents: RunExportEvent[];
  retrievalCleanupEvents?: RetrievalCleanupEvent[];
  providerFailureEvents?: ProviderFailureEvent[];
  fallbackReason?: RunFallbackReason;
  execution?: RunExecution;
  hostedOpenModelHealth?: HostedOpenModelHealthCheck;
}

export interface Run {
  id: string;
  workspaceId: string;
  status: RunStatus;
  createdAt: string;
  completedAt?: string;
  errorMessage?: string;
  statusMessage?: string;
  metrics?: RunMetrics;
  observability?: RunObservability;
}

export interface Source {
  id: string;
  type: SourceType;
  title: string;
  url?: string;
  fileName?: string;
  publishedAt?: string;
  domain?: string;
  sourceKind?: "government" | "research" | "news" | "company" | "ngo" | "blog" | "memo" | "other";
  isPrimary?: boolean;
}

export interface Snippet {
  id: string;
  sourceId: string;
  text: string;
  rationale: string;
  relevance: number;
  origin?: SnippetOrigin;
  locationLabel?: string;
  pageNumber?: number;
  offsetStart?: number;
  offsetEnd?: number;
}

export interface EvidencePack {
  question: string;
  summary: string;
  groundingStatus?: EvidenceGroundingStatus;
  subquestions: string[];
  evidenceAxes: Array<{
    id: string;
    label: string;
    description: string;
    snippetIds: string[];
  }>;
  sources: Source[];
  snippets: Snippet[];
  openQuestions: string[];
  warnings: string[];
}

export interface EvidencePackRecord {
  recordVersion?: number;
  runId: string;
  createdAt: string;
  model: string;
  responseId: string;
  vectorStoreId?: string;
  evidencePack: EvidencePack;
}

export interface ClaimUnit {
  id: string;
  kind: "claim" | "counterclaim";
  title: string;
  summary: string;
  topic: string;
  stance: Stance;
  confidence: number;
  evidenceQuality: "high" | "medium" | "low";
  sourceIds: string[];
  snippetIds: string[];
  qualifiers: string[];
  dependsOnGapIds: string[];
}

export interface ContradictionPair {
  id: string;
  leftClaimId: string;
  rightClaimId: string;
  contradictionStrength: number;
  explanation: string;
}

export interface GapUnit {
  id: string;
  title: string;
  summary: string;
  gapType:
    | "missing_context"
    | "insufficient_evidence"
    | "mixed_evidence"
    | "stale_evidence"
    | "assumption_dependency";
  sourceIds: string[];
  snippetIds: string[];
  importance: number;
}

export interface ClaimInventory {
  question: string;
  claims: ClaimUnit[];
  contradictionPairs: ContradictionPair[];
  unresolvedGaps: GapUnit[];
}

export interface ClaimInventoryRecord {
  recordVersion?: number;
  runId: string;
  createdAt: string;
  model: string;
  responseId: string;
  claimInventory: ClaimInventory;
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  title: string;
  summary: string;
  topic?: string;
  stance?: Stance;
  confidence?: number;
  sourceIds: string[];
  snippetIds: string[];
  metadata?: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  relation: EdgeRelation;
  strength: number;
}

export interface DisagreementCluster {
  id: string;
  claimIds: [string, string];
  score: number;
  title: string;
  explanation: string;
  sourceIds: string[];
  snippetIds: string[];
}

export interface ClaimGraph {
  question: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  disagreementClusters: DisagreementCluster[];
  primaryClusterId?: string;
  graphSummary: string;
}

export interface WorkspaceGraphRecord {
  recordVersion?: number;
  origin: "starter" | "live";
  mode: ClaimGraphMode;
  provider: ClaimGraphProviderId;
  backend?: OpenModelBackend;
  createdAt: string;
  model: string;
  responseId?: string;
  runId?: string;
  graph: ClaimGraph;
  sources: Source[];
  snippets: Snippet[];
}

export interface ClaimGraphRuntimeInfo {
  mode: ClaimGraphMode;
  provider: ClaimGraphProviderId;
  liveAnalysisEnabled: boolean;
  supportsUrlIntake: boolean;
  supportsWebSearch: boolean;
  openModelBackend?: OpenModelBackend;
  openModelModel?: string;
}

export interface RuntimeLaneReadiness {
  id: RuntimeLaneId;
  label: string;
  mode: ClaimGraphMode | "advisory";
  backend: OpenModelBackend | "openai" | "starter";
  model?: string;
  status: RuntimeLaneStatus;
  summary: string;
  details: string[];
  nextAction?: string;
}

export interface RuntimeReadinessSummary {
  checkedAt: string;
  productPromise: string;
  selectedMode: ClaimGraphMode;
  overallStatus: RuntimeLaneStatus;
  overallSummary: string;
  nextAction: string;
  lanes: RuntimeLaneReadiness[];
}

export interface GraphBuildInfo {
  origin: "starter" | "live";
  mode: ClaimGraphMode;
  provider: ClaimGraphProviderId;
  backend?: OpenModelBackend;
  model: string;
  responseId?: string;
  runId?: string;
}

export interface RunArtifactSnapshot {
  runId: string;
  evidence: EvidencePackRecord | null;
  claimInventory: ClaimInventoryRecord | null;
}

export interface WorkspaceGraphPayload {
  workspace: Workspace;
  /**
   * Compatibility alias for graphRun. Status and metrics on this run always
   * describe the graph, evidence, and claim inventory in this payload.
   */
  run: Run | null;
  latestRun: Run | null;
  activeRun: Run | null;
  graphRun: Run | null;
  graph: ClaimGraph;
  sources: Source[];
  snippets: Snippet[];
  files: WorkspaceFile[];
  evidence: EvidencePackRecord | null;
  claimInventory: ClaimInventoryRecord | null;
  latestRunArtifacts: RunArtifactSnapshot | null;
  inProgressArtifacts: RunArtifactSnapshot | null;
  starterMode: boolean;
  runtime: ClaimGraphRuntimeInfo;
  graphBuild: GraphBuildInfo;
  /**
   * Present only on the public API projection. It reflects whether the
   * current request carries this workspace's mutation capability (or a
   * protected developer session); it is never persisted.
   */
  canWrite?: boolean;
}

export interface PublicWorkspace {
  id: string;
  question: string;
  createdAt: string;
  updatedAt: string;
  settings: PublicWorkspaceSettings;
  sourceUrls: string[];
}

export interface PublicWorkspaceSettings {
  maxWebSources: number;
  maxFiles: number;
  freshnessBias: "low" | "medium" | "high";
  preferPrimarySources: boolean;
  includeOpposingEvidence: boolean;
}

export interface PublicRunMetrics {
  sourceCount: number;
  snippetCount: number;
  claimCount: number;
  counterclaimCount: number;
  evidenceCount: number;
  gapCount: number;
  totalNodeCount: number;
  strongestDisagreementScore?: number;
  durationMs?: number;
}

export interface PublicRun {
  id: string;
  workspaceId: string;
  status: RunStatus;
  createdAt: string;
  completedAt?: string;
  statusMessage?: string;
  metrics?: PublicRunMetrics;
}

export interface PublicGraphNodeMetadata {
  qualifiers?: string[];
  gapType?:
    | "missing_context"
    | "insufficient_evidence"
    | "mixed_evidence"
    | "stale_evidence"
    | "assumption_dependency";
  importance?: number;
  sourceTitle?: string;
  evidenceLabelDerivedFrom?: "snippet";
  targetNodeId?: string;
  sourceType?: SourceType;
  rationale?: string;
}

export interface PublicGraphNode {
  id: string;
  kind: NodeKind;
  title: string;
  summary: string;
  topic?: string;
  stance?: Stance;
  confidence?: number;
  sourceIds: string[];
  snippetIds: string[];
  metadata?: PublicGraphNodeMetadata;
}

export interface PublicGraphEdge {
  id: string;
  from: string;
  to: string;
  relation: EdgeRelation;
  strength: number;
}

export interface PublicDisagreementCluster {
  id: string;
  claimIds: [string, string];
  score: number;
  title: string;
  explanation: string;
  sourceIds: string[];
  snippetIds: string[];
}

export interface PublicClaimGraph {
  question: string;
  nodes: PublicGraphNode[];
  edges: PublicGraphEdge[];
  disagreementClusters: PublicDisagreementCluster[];
  primaryClusterId?: string;
  graphSummary: string;
}

export interface PublicSource {
  id: string;
  type: SourceType;
  title: string;
  url?: string;
  fileName?: string;
  publishedAt?: string;
  domain?: string;
  sourceKind?: Source["sourceKind"];
  isPrimary?: boolean;
}

export interface PublicSnippet {
  id: string;
  sourceId: string;
  text: string;
  rationale: string;
  relevance: number;
  origin?: SnippetOrigin;
  locationLabel?: string;
  pageNumber?: number;
}

export interface PublicWorkspaceFile {
  id: string;
  workspaceId: string;
  originalName: string;
  storedName: string;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  uploadedAt: string;
}

export interface PublicWorkspaceGraphPayload {
  workspace: PublicWorkspace;
  run: PublicRun | null;
  latestRun: PublicRun | null;
  activeRun: PublicRun | null;
  graphRun: PublicRun | null;
  graph: PublicClaimGraph;
  sources: PublicSource[];
  snippets: PublicSnippet[];
  files: PublicWorkspaceFile[];
  evidence: null;
  claimInventory: null;
  latestRunArtifacts: null;
  inProgressArtifacts: null;
  starterMode: boolean;
  runtime: {
    mode: "demo";
    provider: "starter";
    liveAnalysisEnabled: boolean;
    supportsUrlIntake: boolean;
    supportsWebSearch: boolean;
  };
  graphBuild: {
    origin: "starter" | "live";
    mode: "demo";
    provider: "starter";
    model: "starter-map" | "public-map";
  };
  canWrite: boolean;
}
