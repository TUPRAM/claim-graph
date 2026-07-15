import { z } from "zod";
import { isSafePublicSourceUrl } from "@/lib/provenance/public-source-url";

const publicHttpUrlSchema = z.string().refine(
  isSafePublicSourceUrl,
  "Public source URLs must be safe, public, credential-free HTTP(S) URLs."
);

const publicRunMetricsSchema = z.object({
  sourceCount: z.number().int().nonnegative(),
  snippetCount: z.number().int().nonnegative(),
  claimCount: z.number().int().nonnegative(),
  counterclaimCount: z.number().int().nonnegative(),
  evidenceCount: z.number().int().nonnegative(),
  gapCount: z.number().int().nonnegative(),
  totalNodeCount: z.number().int().nonnegative(),
  strongestDisagreementScore: z.number().finite().min(0).max(1).optional(),
  durationMs: z.number().finite().nonnegative().optional()
}).strict();

export const publicRunSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  status: z.enum([
    "queued",
    "ingesting",
    "gathering",
    "extracting",
    "assembling",
    "canceled",
    "insufficient_evidence",
    "completed",
    "failed"
  ]),
  createdAt: z.string(),
  completedAt: z.string().optional(),
  statusMessage: z.string().optional(),
  metrics: publicRunMetricsSchema.optional()
}).strict();

const publicGraphNodeMetadataSchema = z.object({
  qualifiers: z.array(z.string()).optional(),
  gapType: z.enum([
    "missing_context",
    "insufficient_evidence",
    "mixed_evidence",
    "stale_evidence",
    "assumption_dependency"
  ]).optional(),
  importance: z.number().finite().min(0).max(1).optional(),
  sourceTitle: z.string().optional(),
  evidenceLabelDerivedFrom: z.literal("snippet").optional(),
  targetNodeId: z.string().optional(),
  sourceType: z.enum(["web", "file"]).optional(),
  rationale: z.string().optional()
}).strict();

export const publicGraphNodeSchema = z.object({
  id: z.string(),
  kind: z.enum(["question", "claim", "counterclaim", "evidence", "gap"]),
  title: z.string(),
  summary: z.string(),
  topic: z.string().optional(),
  stance: z.enum(["pro", "con", "mixed", "unknown"]).optional(),
  confidence: z.number().finite().min(0).max(1).optional(),
  sourceIds: z.array(z.string()),
  snippetIds: z.array(z.string()),
  metadata: publicGraphNodeMetadataSchema.optional()
}).strict();

const publicGraphEdgeSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  relation: z.enum(["supports", "refutes", "qualifies", "depends_on"]),
  strength: z.number().finite().min(0).max(1)
}).strict();

const publicDisagreementClusterSchema = z.object({
  id: z.string(),
  claimIds: z.tuple([z.string(), z.string()]),
  score: z.number().finite().min(0).max(1),
  title: z.string(),
  explanation: z.string(),
  sourceIds: z.array(z.string()),
  snippetIds: z.array(z.string())
}).strict();

const publicClaimGraphSchema = z.object({
  question: z.string(),
  nodes: z.array(publicGraphNodeSchema),
  edges: z.array(publicGraphEdgeSchema),
  disagreementClusters: z.array(publicDisagreementClusterSchema),
  primaryClusterId: z.string().optional(),
  graphSummary: z.string()
}).strict();

export const publicSourceSchema = z.object({
  id: z.string(),
  type: z.enum(["web", "file"]),
  title: z.string(),
  url: publicHttpUrlSchema.optional(),
  fileName: z.string().optional(),
  publishedAt: z.string().optional(),
  domain: z.string().optional(),
  sourceKind: z.enum([
    "government",
    "research",
    "news",
    "company",
    "ngo",
    "blog",
    "memo",
    "other"
  ]).optional(),
  isPrimary: z.boolean().optional()
}).strict();

export const publicSnippetSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  text: z.string(),
  rationale: z.string(),
  relevance: z.number().finite().min(0).max(1),
  origin: z.enum([
    "starter_curated",
    "file_search_result",
    "file_ingest_excerpt",
    "web_search_result_excerpt",
    "web_search_result_summary",
    "web_citation_summary_span",
    "url_ingest_excerpt",
    "unknown"
  ]).optional(),
  locationLabel: z.string().optional(),
  pageNumber: z.number().int().positive().optional()
}).strict();

const publicWorkspaceFileSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  originalName: z.string(),
  storedName: z.string(),
  mimeType: z.string(),
  extension: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  uploadedAt: z.string()
}).strict();

const publicWorkspaceSettingsSchema = z.object({
  maxWebSources: z.number().int().nonnegative(),
  maxFiles: z.number().int().nonnegative(),
  freshnessBias: z.enum(["low", "medium", "high"]),
  preferPrimarySources: z.boolean(),
  includeOpposingEvidence: z.boolean()
}).strict();

const publicWorkspaceSchema = z.object({
  id: z.string(),
  question: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  settings: publicWorkspaceSettingsSchema,
  sourceUrls: z.array(z.string())
}).strict();

export const publicWorkspaceGraphPayloadSchema = z.object({
  workspace: publicWorkspaceSchema,
  run: publicRunSchema.nullable(),
  latestRun: publicRunSchema.nullable(),
  activeRun: publicRunSchema.nullable(),
  graphRun: publicRunSchema.nullable(),
  graph: publicClaimGraphSchema,
  sources: z.array(publicSourceSchema),
  snippets: z.array(publicSnippetSchema),
  files: z.array(publicWorkspaceFileSchema),
  evidence: z.null(),
  claimInventory: z.null(),
  latestRunArtifacts: z.null(),
  inProgressArtifacts: z.null(),
  starterMode: z.boolean(),
  runtime: z.object({
    mode: z.literal("demo"),
    provider: z.literal("starter"),
    liveAnalysisEnabled: z.boolean(),
    supportsUrlIntake: z.boolean(),
    supportsWebSearch: z.boolean()
  }).strict(),
  graphBuild: z.object({
    origin: z.enum(["starter", "live"]),
    mode: z.literal("demo"),
    provider: z.literal("starter"),
    model: z.enum(["starter-map", "public-map"])
  }).strict(),
  canWrite: z.boolean()
}).strict();
