import {
  formatPublicProseText,
  formatPublicSnippetRationale,
  getSnippetPublicText
} from "@/lib/provenance/public-provenance";
import { sanitizePublicSourceUrl } from "@/lib/provenance/public-source-url";
import { resolveSnippetOrigin } from "@/lib/provenance/snippets";
import {
  publicRunSchema,
  publicWorkspaceGraphPayloadSchema
} from "@/lib/validation/public-workspace-payload";
import type {
  GraphNode,
  NodeKind,
  PublicClaimGraph,
  PublicGraphNode,
  PublicGraphNodeMetadata,
  PublicRun,
  PublicSnippet,
  PublicSource,
  PublicWorkspaceFile,
  RetrievalCleanupSummary,
  PublicWorkspaceGraphPayload,
  Run,
  Snippet,
  Source,
  WorkspaceFile,
  WorkspaceGraphPayload
} from "@/types/claimgraph";

const PUBLIC_QUESTION_SUMMARY =
  "The root question anchors the source-backed argument map and keeps every branch tied to the question.";
const WITHHELD_SOURCE_LABEL = "Source link withheld";

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function getWithheldSourceRedactionTerms(source: Source) {
  const terms = new Set<string>();
  const add = (value: string | null | undefined) => {
    const normalized = value?.trim();

    if (normalized) {
      terms.add(normalized);
    }
  };
  const addRawAndDecoded = (value: string | null | undefined) => {
    add(value);

    if (!value) {
      return;
    }

    try {
      add(decodeURIComponent(value.replace(/\+/gu, " ")));
    } catch {
      // The raw value remains covered when percent-decoding is invalid.
    }
  };

  add(source.title);
  add(source.url);
  add(source.domain);
  add(source.fileName);
  add(source.publishedAt);

  if (source.url) {
    try {
      const parsed = new URL(source.url);
      add(parsed.hostname.replace(/^\[|\]$/gu, ""));
      add(parsed.username);
      add(parsed.password);

      // URLSearchParams exposes decoded names and values. Keep those terms,
      // plus the raw names below, so encoded query keys cannot bypass public
      // redaction when they are copied into graph prose without the full URL.
      for (const [name, value] of parsed.searchParams.entries()) {
        add(name);
        add(value);
      }

      for (const pair of parsed.search.slice(1).split("&")) {
        const separatorIndex = pair.indexOf("=");
        const rawName = separatorIndex === -1
          ? pair
          : pair.slice(0, separatorIndex);
        addRawAndDecoded(rawName);
      }

      // Individual URL path segments can also be copied into generated source
      // labels. Terms shorter than four characters remain protected by the
      // exact-match rule without erasing common short prose substrings.
      for (const rawSegment of parsed.pathname.split("/")) {
        addRawAndDecoded(rawSegment);
      }
    } catch {
      // The full rejected URL remains a redaction term even when it cannot be
      // parsed as an HTTP(S) URL.
    }
  }

  return [...terms].sort((left, right) => right.length - left.length);
}

function sanitizeWithheldSourceProse(
  value: string,
  withheldSources: Source[],
  options?: {
    nodeKind?: NodeKind;
    exactReplacement?: string;
  }
) {
  let cleaned = sanitizePublicProse(value, { nodeKind: options?.nodeKind });
  const terms = withheldSources.flatMap(getWithheldSourceRedactionTerms);

  for (const term of terms) {
    if (cleaned.trim().localeCompare(term, undefined, { sensitivity: "accent" }) === 0) {
      return options?.exactReplacement ?? WITHHELD_SOURCE_LABEL;
    }

    // Very short source labels are too ambiguous for safe substring removal.
    // Exact matches above are still fail-closed without destroying ordinary
    // prose that happens to contain a one-character title or query value.
    if (term.length < 4) {
      continue;
    }

    cleaned = cleaned.replace(new RegExp(escapeRegExp(term), "giu"), "withheld source");
  }

  return cleaned.replace(/\s+/gu, " ").trim();
}

function buildPublicRunStatusMessage(run: Run) {
  switch (run.status) {
    case "queued":
    case "ingesting":
    case "gathering":
    case "extracting":
    case "assembling":
      return "The graph is being built.";
    case "completed":
      return "The map is ready to inspect.";
    case "canceled":
      return "The latest build was canceled.";
    case "insufficient_evidence":
    case "failed":
      return "The graph could not be rebuilt from the current sources.";
  }
}

function sanitizeRunMetricsForPublic(run: Run) {
  if (!run.metrics) {
    return undefined;
  }

  return {
    sourceCount: run.metrics.sourceCount,
    snippetCount: run.metrics.snippetCount,
    claimCount: run.metrics.claimCount,
    counterclaimCount: run.metrics.counterclaimCount,
    evidenceCount: run.metrics.evidenceCount,
    gapCount: run.metrics.gapCount,
    totalNodeCount: run.metrics.totalNodeCount,
    strongestDisagreementScore: run.metrics.strongestDisagreementScore,
    durationMs: run.metrics.durationMs
  };
}

export function sanitizeRunForPublic(run: Run | null): PublicRun | null {
  if (!run) {
    return null;
  }

  return publicRunSchema.parse({
    id: run.id,
    workspaceId: run.workspaceId,
    status: run.status,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
    statusMessage: buildPublicRunStatusMessage(run),
    metrics: sanitizeRunMetricsForPublic(run)
  });
}

export function sanitizeWorkspaceFileForPublic(
  file: WorkspaceFile
): PublicWorkspaceFile {
  return {
    id: file.id,
    workspaceId: file.workspaceId,
    originalName: file.originalName,
    storedName: file.originalName,
    mimeType: file.mimeType,
    extension: file.extension,
    sizeBytes: file.sizeBytes,
    uploadedAt: file.uploadedAt
  };
}

export function sanitizeCleanupSummaryForPublic(
  cleanup: RetrievalCleanupSummary
): RetrievalCleanupSummary {
  return {
    attemptedCount: cleanup.attemptedCount,
    deletedCount: cleanup.deletedCount,
    skippedCount: cleanup.skippedCount,
    failedCount: cleanup.failedCount,
    pendingCount: cleanup.pendingCount,
    // Provider object ids and provider error details remain in the protected
    // developer payload. Public mutation responses need only outcome counts.
    events: []
  };
}

function repairLegacyPublicProse(
  value: string,
  options?: {
    nodeKind?: NodeKind;
  }
) {
  if (!value) {
    return value;
  }

  if (
    options?.nodeKind === "question" &&
    /\b(claim inventory|evidence pack|live claim graph assembled)\b/i.test(value)
  ) {
    return PUBLIC_QUESTION_SUMMARY;
  }

  return value
    .replace(/\bsaved evidence pack\b/gi, "saved sources")
    .replace(/\bsaved claim inventory\b/gi, "saved source trails")
    .replace(/\bpersisted claim inventory\b/gi, "source trail")
    .replace(/\bclaim inventory\b/gi, "source trail")
    .replace(/\bevidence pack\b/gi, "source evidence");
}

function sanitizePublicProse(
  value: string,
  options?: {
    nodeKind?: NodeKind;
  }
) {
  const cleaned = formatPublicProseText(value) || value;
  return repairLegacyPublicProse(cleaned, options);
}

function sanitizeGraphNodeMetadataForPublic(
  node: GraphNode,
  withheldSources: Source[]
): PublicGraphNodeMetadata | undefined {
  const metadata = node.metadata;

  if (!metadata) {
    return undefined;
  }

  const publicMetadata: PublicGraphNodeMetadata = {};

  if (
    Array.isArray(metadata.qualifiers) &&
    metadata.qualifiers.every((value) => typeof value === "string")
  ) {
    publicMetadata.qualifiers = metadata.qualifiers.map((value) =>
      sanitizeWithheldSourceProse(value, withheldSources)
    );
  }

  if (
    metadata.gapType === "missing_context" ||
    metadata.gapType === "insufficient_evidence" ||
    metadata.gapType === "mixed_evidence" ||
    metadata.gapType === "stale_evidence" ||
    metadata.gapType === "assumption_dependency"
  ) {
    publicMetadata.gapType = metadata.gapType;
  }

  if (typeof metadata.importance === "number" && Number.isFinite(metadata.importance)) {
    publicMetadata.importance = metadata.importance;
  }

  if (typeof metadata.sourceTitle === "string") {
    publicMetadata.sourceTitle = withheldSources.length
      ? WITHHELD_SOURCE_LABEL
      : sanitizePublicProse(metadata.sourceTitle);
  }

  if (metadata.evidenceLabelDerivedFrom === "snippet") {
    publicMetadata.evidenceLabelDerivedFrom = "snippet";
  }

  if (typeof metadata.targetNodeId === "string") {
    publicMetadata.targetNodeId = metadata.targetNodeId;
  }

  if (metadata.sourceType === "web" || metadata.sourceType === "file") {
    publicMetadata.sourceType = metadata.sourceType;
  }

  if (typeof metadata.rationale === "string") {
    publicMetadata.rationale = sanitizeWithheldSourceProse(
      metadata.rationale,
      withheldSources,
      {
        exactReplacement:
          "This evidence is linked to a source whose public link is withheld."
      }
    );
  }

  return Object.keys(publicMetadata).length ? publicMetadata : undefined;
}

function sanitizeGraphNodeForPublic(
  node: GraphNode,
  withheldSources: Source[]
): PublicGraphNode {
  return {
    id: node.id,
    kind: node.kind,
    title: sanitizeWithheldSourceProse(node.title, withheldSources, {
      nodeKind: node.kind,
      exactReplacement:
        node.kind === "evidence"
          ? "Evidence from a source with a withheld link"
          : WITHHELD_SOURCE_LABEL
    }),
    summary: sanitizeWithheldSourceProse(node.summary, withheldSources, {
      nodeKind: node.kind,
      exactReplacement:
        "Details from a source with a withheld link were removed from this public view."
    }),
    topic: node.topic
      ? sanitizeWithheldSourceProse(node.topic, withheldSources)
      : undefined,
    stance: node.stance,
    confidence: node.confidence,
    sourceIds: [...node.sourceIds],
    snippetIds: [...node.snippetIds],
    metadata: sanitizeGraphNodeMetadataForPublic(node, withheldSources)
  };
}

function sanitizeGraphForPublic(
  graph: WorkspaceGraphPayload["graph"],
  withheldSources: Source[]
): PublicClaimGraph {
  return {
    question: sanitizeWithheldSourceProse(graph.question, withheldSources),
    graphSummary: sanitizeWithheldSourceProse(
      graph.graphSummary,
      withheldSources
    ),
    nodes: graph.nodes.map((node) =>
      sanitizeGraphNodeForPublic(node, withheldSources)
    ),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      relation: edge.relation,
      strength: edge.strength
    })),
    disagreementClusters: graph.disagreementClusters.map((cluster) => {
      return {
        id: cluster.id,
        claimIds: [cluster.claimIds[0], cluster.claimIds[1]],
        score: cluster.score,
        title: sanitizeWithheldSourceProse(cluster.title, withheldSources),
        explanation: sanitizeWithheldSourceProse(
          cluster.explanation,
          withheldSources
        ),
        sourceIds: [...cluster.sourceIds],
        snippetIds: [...cluster.snippetIds]
      };
    }),
    primaryClusterId: graph.primaryClusterId
  };
}

function sanitizeSourceForPublic(
  source: Source,
  rejectedSourceUrl: boolean
): PublicSource {
  const publicUrl = rejectedSourceUrl
    ? undefined
    : sanitizePublicSourceUrl(source.url);
  const publicTitle = rejectedSourceUrl
    ? WITHHELD_SOURCE_LABEL
    : sanitizePublicProse(source.title);
  const publicDomain = publicUrl
    ? new URL(publicUrl).hostname.toLowerCase()
    : undefined;

  return {
    id: source.id,
    type: source.type,
    title: publicTitle,
    url: publicUrl,
    fileName: rejectedSourceUrl ? undefined : source.fileName,
    publishedAt: rejectedSourceUrl ? undefined : source.publishedAt,
    domain: publicDomain,
    sourceKind: source.sourceKind,
    isPrimary: source.isPrimary
  };
}

function sanitizeSnippetForPublic(
  snippet: Snippet,
  sourceById: Map<string, Source>,
  withheldSources: Source[]
): PublicSnippet {
  const source = sourceById.get(snippet.sourceId);
  const origin = resolveSnippetOrigin(snippet, source);

  return {
    id: snippet.id,
    sourceId: snippet.sourceId,
    text: sanitizeWithheldSourceProse(
      getSnippetPublicText(snippet) || snippet.text,
      withheldSources,
      { exactReplacement: "Source excerpt withheld from the public view." }
    ),
    rationale: sanitizeWithheldSourceProse(
      formatPublicSnippetRationale(snippet.rationale, origin),
      withheldSources,
      {
        exactReplacement:
          "Supports this map using a source whose public link is withheld."
      }
    ),
    relevance: snippet.relevance,
    origin,
    locationLabel: snippet.locationLabel
      ? sanitizeWithheldSourceProse(snippet.locationLabel, withheldSources)
      : undefined,
    pageNumber: snippet.pageNumber
  };
}

export function sanitizeWorkspaceGraphPayloadForPublic(
  payload: WorkspaceGraphPayload,
  options?: { canWrite?: boolean }
): PublicWorkspaceGraphPayload {
  const withheldSources = payload.sources.filter(
    (source) => Boolean(source.url && !sanitizePublicSourceUrl(source.url))
  );
  const withheldSourceSet = new Set(withheldSources);
  const publicSources = payload.sources.map((source) =>
    sanitizeSourceForPublic(source, withheldSourceSet.has(source))
  );
  const sourceById = new Map(payload.sources.map((source) => [source.id, source]));
  const publicPayload: PublicWorkspaceGraphPayload = {
    workspace: {
      id: payload.workspace.id,
      question: sanitizeWithheldSourceProse(
        payload.workspace.question,
        withheldSources
      ),
      createdAt: payload.workspace.createdAt,
      updatedAt: payload.workspace.updatedAt,
      settings: {
        maxWebSources: payload.workspace.settings.maxWebSources,
        maxFiles: payload.workspace.settings.maxFiles,
        freshnessBias: payload.workspace.settings.freshnessBias,
        preferPrimarySources: payload.workspace.settings.preferPrimarySources,
        includeOpposingEvidence:
          payload.workspace.settings.includeOpposingEvidence
      },
      // Input URLs may include abandoned or rejected submissions. Public
      // sharing exposes only the sources actually bound to the displayed graph.
      sourceUrls: []
    },
    run: sanitizeRunForPublic(payload.run),
    latestRun: sanitizeRunForPublic(payload.latestRun),
    activeRun: sanitizeRunForPublic(payload.activeRun),
    graphRun: sanitizeRunForPublic(payload.graphRun),
    graph: sanitizeGraphForPublic(payload.graph, withheldSources),
    sources: publicSources,
    snippets: payload.snippets.map((snippet) =>
      sanitizeSnippetForPublic(snippet, sourceById, withheldSources)
    ),
    files: payload.files.map(sanitizeWorkspaceFileForPublic),
    evidence: null,
    claimInventory: null,
    latestRunArtifacts: null,
    inProgressArtifacts: null,
    starterMode: payload.starterMode,
    runtime: {
      mode: "demo",
      provider: "starter",
      liveAnalysisEnabled: payload.runtime.liveAnalysisEnabled,
      supportsUrlIntake: payload.runtime.supportsUrlIntake,
      supportsWebSearch: payload.runtime.supportsWebSearch
    },
    graphBuild: {
      origin: payload.graphBuild.origin,
      mode: "demo",
      provider: "starter",
      model: payload.starterMode ? "starter-map" : "public-map"
    },
    canWrite: options?.canWrite === true
  };

  return publicWorkspaceGraphPayloadSchema.parse(publicPayload);
}
