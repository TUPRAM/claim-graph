import { z } from "zod";
import { claimGraphSchema } from "@/lib/validation/claim-graph";
import type {
  ClaimInventoryRecord,
  EvidencePackRecord,
  Snippet,
  SnippetOrigin,
  Source,
  WorkspaceGraphRecord
} from "@/types/claimgraph";

export const CURRENT_EVIDENCE_PACK_RECORD_VERSION = 2;
export const CURRENT_CLAIM_INVENTORY_RECORD_VERSION = 2;
export const CURRENT_WORKSPACE_GRAPH_RECORD_VERSION = 3;

const sourceTypeSchema = z.enum(["web", "file"]);
const snippetOriginSchema = z.enum([
  "starter_curated",
  "file_search_result",
  "file_ingest_excerpt",
  "web_search_result_excerpt",
  "web_search_result_summary",
  "web_citation_summary_span",
  "url_ingest_excerpt",
  "unknown"
]);
const stanceSchema = z.enum(["pro", "con", "mixed", "unknown"]);
const evidenceQualitySchema = z.enum(["high", "medium", "low"]);
const gapTypeSchema = z.enum([
  "missing_context",
  "insufficient_evidence",
  "mixed_evidence",
  "stale_evidence",
  "assumption_dependency"
]);

const sourceSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    type: sourceTypeSchema,
    title: z.string().trim().min(1).max(300),
    url: z.string().trim().url().optional(),
    fileName: z.string().trim().min(1).max(300).optional(),
    publishedAt: z.string().trim().min(1).max(120).optional(),
    domain: z.string().trim().min(1).max(255).optional(),
    sourceKind: z
      .enum(["government", "research", "news", "company", "ngo", "blog", "memo", "other"])
      .optional(),
    isPrimary: z.boolean().optional()
  })
  .strict();

const snippetSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    sourceId: z.string().trim().min(1).max(80),
    text: z.string().trim().min(1).max(4000),
    rationale: z.string().trim().min(1).max(1000),
    relevance: z.number().min(0).max(1),
    origin: snippetOriginSchema.optional(),
    locationLabel: z.string().trim().min(1).max(120).optional(),
    pageNumber: z.number().int().min(1).optional(),
    offsetStart: z.number().int().min(0).optional(),
    offsetEnd: z.number().int().min(0).optional()
  })
  .strict();

const evidenceAxisSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    label: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(240),
    snippetIds: z.array(z.string().trim().min(1).max(80)).max(12)
  })
  .strict();

const evidencePackSchema = z
  .object({
    question: z.string().trim().min(1).max(600),
    summary: z.string().trim().min(1).max(1600),
    groundingStatus: z.enum(["grounded", "insufficient_grounding"]).optional(),
    subquestions: z.array(z.string().trim().min(1).max(240)).max(6),
    evidenceAxes: z.array(evidenceAxisSchema).max(6),
    sources: z.array(sourceSchema).max(40),
    snippets: z.array(snippetSchema).max(120),
    openQuestions: z.array(z.string().trim().min(1).max(240)).max(6),
    warnings: z.array(z.string().trim().min(1).max(600)).max(12)
  })
  .strict();

const evidencePackRecordSchema = z
  .object({
    recordVersion: z.literal(CURRENT_EVIDENCE_PACK_RECORD_VERSION),
    runId: z.string().trim().min(1).max(80),
    createdAt: z.string().trim().min(1).max(120),
    model: z.string().trim().min(1).max(120),
    responseId: z.string().trim().min(1).max(120),
    vectorStoreId: z.string().trim().min(1).max(120).optional(),
    evidencePack: evidencePackSchema
  })
  .strict();

const claimUnitSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    kind: z.enum(["claim", "counterclaim"]),
    title: z.string().trim().min(1).max(160),
    summary: z.string().trim().min(1).max(480),
    topic: z.string().trim().min(1).max(120),
    stance: stanceSchema,
    confidence: z.number().min(0).max(1),
    evidenceQuality: evidenceQualitySchema,
    sourceIds: z.array(z.string().trim().min(1).max(80)).max(12),
    snippetIds: z.array(z.string().trim().min(1).max(80)).max(12),
    qualifiers: z.array(z.string().trim().min(1).max(160)).max(8),
    dependsOnGapIds: z.array(z.string().trim().min(1).max(80)).max(8)
  })
  .strict();

const contradictionPairSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    leftClaimId: z.string().trim().min(1).max(80),
    rightClaimId: z.string().trim().min(1).max(80),
    contradictionStrength: z.number().min(0).max(1),
    explanation: z.string().trim().min(1).max(320)
  })
  .strict();

const gapUnitSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    title: z.string().trim().min(1).max(160),
    summary: z.string().trim().min(1).max(320),
    gapType: gapTypeSchema,
    sourceIds: z.array(z.string().trim().min(1).max(80)).max(12),
    snippetIds: z.array(z.string().trim().min(1).max(80)).max(12),
    importance: z.number().min(0).max(1)
  })
  .strict();

const claimInventorySchema = z
  .object({
    question: z.string().trim().min(1).max(600),
    claims: z.array(claimUnitSchema).max(20),
    contradictionPairs: z.array(contradictionPairSchema).max(12),
    unresolvedGaps: z.array(gapUnitSchema).max(10)
  })
  .strict();

const claimInventoryRecordSchema = z
  .object({
    recordVersion: z.literal(CURRENT_CLAIM_INVENTORY_RECORD_VERSION),
    runId: z.string().trim().min(1).max(80),
    createdAt: z.string().trim().min(1).max(120),
    model: z.string().trim().min(1).max(120),
    responseId: z.string().trim().min(1).max(120),
    claimInventory: claimInventorySchema
  })
  .strict();

const workspaceGraphRecordSchema = z
  .object({
    recordVersion: z.literal(CURRENT_WORKSPACE_GRAPH_RECORD_VERSION),
    origin: z.enum(["starter", "live"]),
    mode: z.enum(["demo", "open-model", "full"]),
    provider: z.enum(["starter", "openai", "open-model"]),
    backend: z.enum(["ollama", "vllm", "tgi"]).optional(),
    createdAt: z.string().trim().min(1).max(120),
    model: z.string().trim().min(1).max(120),
    responseId: z.string().trim().min(1).max(120).optional(),
    runId: z.string().trim().min(1).max(80).optional(),
    graph: claimGraphSchema,
    sources: z.array(sourceSchema).max(40),
    snippets: z.array(snippetSchema).max(120)
  })
  .strict();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeGeneratedText(value: unknown, maxLength: number) {
  if (typeof value !== "string") {
    return value;
  }

  const normalized = value.trim().replace(/\s+/g, " ");

  if (normalized.length <= maxLength) {
    return normalized;
  }

  const sliceLength = Math.max(0, maxLength - 3);
  return `${normalized.slice(0, sliceLength).trimEnd()}...`;
}

function normalizeGeneratedTextArray(
  value: unknown,
  options: { maxItems: number; maxLength: number }
) {
  if (!Array.isArray(value)) {
    return value;
  }

  const seen = new Set<string>();
  const normalizedItems: string[] = [];

  for (const item of value) {
    const normalized = normalizeGeneratedText(item, options.maxLength);

    if (typeof normalized !== "string" || normalized.length === 0) {
      continue;
    }

    const key = normalized.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalizedItems.push(normalized);

    if (normalizedItems.length >= options.maxItems) {
      break;
    }
  }

  return normalizedItems;
}

function normalizeClaimInventoryClaims(rawClaims: unknown) {
  if (!Array.isArray(rawClaims)) {
    return [];
  }

  return rawClaims.map((claim) => {
    if (!isRecord(claim)) {
      return claim;
    }

    return {
      ...claim,
      title: normalizeGeneratedText(claim.title, 160),
      summary: normalizeGeneratedText(claim.summary, 480),
      topic: normalizeGeneratedText(claim.topic, 120),
      qualifiers: normalizeGeneratedTextArray(claim.qualifiers, {
        maxItems: 8,
        maxLength: 160
      })
    };
  });
}

function normalizeClaimInventoryContradictions(rawPairs: unknown) {
  if (!Array.isArray(rawPairs)) {
    return [];
  }

  return rawPairs.map((pair) => {
    if (!isRecord(pair)) {
      return pair;
    }

    return {
      ...pair,
      explanation: normalizeGeneratedText(pair.explanation, 320)
    };
  });
}

function normalizeClaimInventoryGaps(rawGaps: unknown) {
  if (!Array.isArray(rawGaps)) {
    return [];
  }

  return rawGaps.map((gap) => {
    if (!isRecord(gap)) {
      return gap;
    }

    return {
      ...gap,
      title: normalizeGeneratedText(gap.title, 160),
      summary: normalizeGeneratedText(gap.summary, 320)
    };
  });
}

function getSupportedRecordVersion(
  input: Record<string, unknown>,
  currentVersion: number,
  label: string
) {
  const version = input.recordVersion;

  if (version === undefined) {
    return 1;
  }

  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new Error(`The persisted ${label} record version is invalid.`);
  }

  if (version > currentVersion) {
    throw new Error(
      `The persisted ${label} record uses unsupported future version ${version}.`
    );
  }

  return version;
}

function inferSnippetOrigin(input: {
  snippet: Record<string, unknown>;
  sourceById: Map<string, Source>;
}): SnippetOrigin {
  const origin = input.snippet.origin;

  if (typeof origin === "string") {
    const parsedOrigin = snippetOriginSchema.safeParse(origin);

    if (parsedOrigin.success) {
      return parsedOrigin.data;
    }
  }

  const sourceId =
    typeof input.snippet.sourceId === "string" ? input.snippet.sourceId : undefined;
  const source = sourceId ? input.sourceById.get(sourceId) : undefined;

  if (source?.type === "file") {
    return "file_search_result";
  }

  if (
    typeof input.snippet.offsetStart === "number" ||
    typeof input.snippet.offsetEnd === "number"
  ) {
    return "web_citation_summary_span";
  }

  return "unknown";
}

function normalizeSources(rawSources: unknown) {
  return sourceSchema.array().parse(Array.isArray(rawSources) ? rawSources : []);
}

function normalizeSnippets(rawSnippets: unknown, sources: Source[]) {
  const sourceById = new Map(sources.map((source) => [source.id, source]));

  if (!Array.isArray(rawSnippets)) {
    return [] as Snippet[];
  }

  return snippetSchema.array().parse(
    rawSnippets.map((snippet) => {
      if (!isRecord(snippet)) {
        return snippet;
      }

      return {
        ...snippet,
        origin: inferSnippetOrigin({
          snippet,
          sourceById
        })
      };
    })
  );
}

export function normalizeEvidencePackRecord(input: unknown): EvidencePackRecord {
  if (!isRecord(input)) {
    throw new Error("The persisted evidence pack record is malformed.");
  }

  getSupportedRecordVersion(
    input,
    CURRENT_EVIDENCE_PACK_RECORD_VERSION,
    "evidence pack"
  );

  if (!isRecord(input.evidencePack)) {
    throw new Error("The persisted evidence pack payload is malformed.");
  }

  const sources = normalizeSources(input.evidencePack.sources);
  const snippets = normalizeSnippets(input.evidencePack.snippets, sources);
  const groundingStatus =
    input.evidencePack.groundingStatus ??
    (sources.length > 0 && snippets.length > 0
      ? "grounded"
      : "insufficient_grounding");

  return evidencePackRecordSchema.parse({
    recordVersion: CURRENT_EVIDENCE_PACK_RECORD_VERSION,
    runId: input.runId,
    createdAt: input.createdAt,
    model: input.model,
    responseId: input.responseId,
    vectorStoreId: input.vectorStoreId,
    evidencePack: {
      question: input.evidencePack.question,
      summary: input.evidencePack.summary,
      groundingStatus,
      subquestions: input.evidencePack.subquestions ?? [],
      evidenceAxes: input.evidencePack.evidenceAxes ?? [],
      sources,
      snippets,
      openQuestions: input.evidencePack.openQuestions ?? [],
      warnings: input.evidencePack.warnings ?? []
    }
  });
}

export function normalizeClaimInventoryRecord(input: unknown): ClaimInventoryRecord {
  if (!isRecord(input)) {
    throw new Error("The persisted claim inventory record is malformed.");
  }

  getSupportedRecordVersion(
    input,
    CURRENT_CLAIM_INVENTORY_RECORD_VERSION,
    "claim inventory"
  );

  if (!isRecord(input.claimInventory)) {
    throw new Error("The persisted claim inventory payload is malformed.");
  }

  return claimInventoryRecordSchema.parse({
    recordVersion: CURRENT_CLAIM_INVENTORY_RECORD_VERSION,
    runId: input.runId,
    createdAt: input.createdAt,
    model: input.model,
    responseId: input.responseId,
    claimInventory: {
      question: input.claimInventory.question,
      claims: normalizeClaimInventoryClaims(input.claimInventory.claims),
      contradictionPairs: normalizeClaimInventoryContradictions(
        input.claimInventory.contradictionPairs
      ),
      unresolvedGaps: normalizeClaimInventoryGaps(
        input.claimInventory.unresolvedGaps
      )
    }
  });
}

export function normalizeWorkspaceGraphRecord(
  input: unknown
): WorkspaceGraphRecord {
  if (!isRecord(input)) {
    throw new Error("The persisted graph record is malformed.");
  }

  getSupportedRecordVersion(
    input,
    CURRENT_WORKSPACE_GRAPH_RECORD_VERSION,
    "graph"
  );

  const sources = normalizeSources(input.sources);
  const snippets = normalizeSnippets(input.snippets, sources);

  return workspaceGraphRecordSchema.parse({
    recordVersion: CURRENT_WORKSPACE_GRAPH_RECORD_VERSION,
    origin: input.origin,
    mode:
      input.mode ??
      (input.origin === "starter" ? "demo" : "full"),
    provider:
      input.provider ??
      (input.origin === "starter" ? "starter" : "openai"),
    backend: input.backend,
    createdAt: input.createdAt,
    model: input.model,
    responseId: input.responseId,
    runId: input.runId,
    graph: input.graph,
    sources,
    snippets
  });
}

export function tryNormalizeEvidencePackRecord(input: unknown) {
  const result = z.unknown().safeParse(input);

  if (!result.success) {
    return { record: null, error: "The persisted evidence pack JSON could not be read." };
  }

  try {
    return { record: normalizeEvidencePackRecord(result.data), error: null };
  } catch (error) {
    return {
      record: null,
      error: error instanceof Error ? error.message : "The persisted evidence pack is invalid."
    };
  }
}

export function tryNormalizeClaimInventoryRecord(input: unknown) {
  const result = z.unknown().safeParse(input);

  if (!result.success) {
    return { record: null, error: "The persisted claim inventory JSON could not be read." };
  }

  try {
    return { record: normalizeClaimInventoryRecord(result.data), error: null };
  } catch (error) {
    return {
      record: null,
      error:
        error instanceof Error
          ? error.message
          : "The persisted claim inventory is invalid."
    };
  }
}

export function tryNormalizeWorkspaceGraphRecord(input: unknown) {
  const result = z.unknown().safeParse(input);

  if (!result.success) {
    return { record: null, error: "The persisted graph JSON could not be read." };
  }

  try {
    return { record: normalizeWorkspaceGraphRecord(result.data), error: null };
  } catch (error) {
    return {
      record: null,
      error: error instanceof Error ? error.message : "The persisted graph is invalid."
    };
  }
}
