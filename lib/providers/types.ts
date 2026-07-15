import type {
  ClaimGraph,
  EvidenceGroundingStatus,
  ClaimGraphMode,
  ClaimGraphProviderId,
  ClaimInventory,
  EvidencePack,
  HostedOpenModelHealthCheck,
  OpenModelBackend,
  Workspace,
  WorkspaceFile
} from "@/types/claimgraph";

export interface EvidenceRequest {
  workspace: Workspace;
  files: WorkspaceFile[];
  runId: string;
  signal?: AbortSignal;
}

export interface ClaimExtractionRequest {
  workspace: Workspace;
  evidencePack: EvidencePack;
  signal?: AbortSignal;
}

export interface GraphAssemblyRequest {
  workspace: Workspace;
  evidencePack: EvidencePack;
  claimInventory: ClaimInventory;
  signal?: AbortSignal;
}

export interface GatheredEvidenceArtifact {
  model: string;
  responseId: string;
  vectorStoreId?: string;
  evidencePack: EvidencePack;
  groundingStatus: EvidenceGroundingStatus;
  hostedOpenModelHealth?: HostedOpenModelHealthCheck;
}

export interface ExtractedClaimInventoryArtifact {
  model: string;
  responseId: string;
  claimInventory: ClaimInventory;
  hostedOpenModelHealth?: HostedOpenModelHealthCheck;
}

export interface AssembledGraphArtifact {
  model: string;
  responseId: string;
  graph: ClaimGraph;
  hostedOpenModelHealth?: HostedOpenModelHealthCheck;
}

export interface ClaimGraphProvider {
  readonly id: ClaimGraphProviderId;
  readonly mode: ClaimGraphMode;
  readonly backend?: OpenModelBackend;
  gatherEvidence(input: EvidenceRequest): Promise<GatheredEvidenceArtifact>;
  extractClaims(input: ClaimExtractionRequest): Promise<ExtractedClaimInventoryArtifact>;
  assembleGraph(input: GraphAssemblyRequest): Promise<AssembledGraphArtifact>;
}
