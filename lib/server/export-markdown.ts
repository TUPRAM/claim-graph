import { getPrimaryCluster } from "@/lib/graph/score";
import { assessPublicGraphQuality } from "@/lib/graph/public-quality";
import { getInspectionCluster } from "@/lib/sidebar/inspection";
import {
  getSnippetOriginDescription,
  getSnippetOriginLabel,
  resolveSnippetOrigin
} from "@/lib/provenance/snippets";
import {
  buildPublicGraphSourceLimitations,
  formatPublicProseText,
  formatPublicSnippetRationale,
  getSnippetPublicText
} from "@/lib/provenance/public-provenance";
import {
  buildSourceNoteLimitationSummary,
  getSnippetsForSource,
  getSourceNoteLimitation
} from "@/lib/provenance/source-notes";
import {
  getStarterDemoSourceNotice,
  getStarterDemoSnippetNotice,
  isStarterDemoSource
} from "@/lib/provenance/starter-demo";
import {
  getGraphSourceMode,
  getGraphSourceModeExportDescription,
  getGraphSourceModeLabel
} from "@/lib/provenance/graph-source-mode";
import {
  buildNodeReviewNotes,
  buildSourceReviewFlags,
  formatGapTypeLabel,
  formatSourceReference,
  getNodeGapImportance,
  getNodeGapType,
  getNodeQualifiers
} from "@/lib/review/citation-context";
import type {
  GraphNode,
  ReviewBranchFilter,
  Snippet,
  Source,
  WorkspaceAlphaAssessment,
  WorkspaceGraphPayload
} from "@/types/claimgraph";

function byKind(nodes: GraphNode[], kind: GraphNode["kind"]) {
  return nodes.filter((node) => node.kind === kind);
}

function formatReviewBranchFilter(branchFilter: ReviewBranchFilter) {
  switch (branchFilter) {
    case "left":
      return "Claim A";
    case "right":
      return "Claim B";
    case "unresolved":
      return "Unresolved";
    default:
      return "All branches";
  }
}

function formatCount(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function getSourceById(sources: Source[]) {
  return new Map(sources.map((source) => [source.id, source]));
}

function getSnippetById(snippets: Snippet[]) {
  return new Map(snippets.map((snippet) => [snippet.id, snippet]));
}

function getSourcesForNode(node: GraphNode, sourceById: Map<string, Source>) {
  return node.sourceIds
    .map((sourceId) => sourceById.get(sourceId))
    .filter((source): source is Source => Boolean(source));
}

function filterExportReviewNotes(notes: string[]) {
  return notes.filter(
    (note) => !note.startsWith("Some source metadata is limited:")
  );
}

function formatExportRunStatusMessage(run: NonNullable<WorkspaceGraphPayload["run"]>) {
  switch (run.status) {
    case "queued":
    case "ingesting":
    case "gathering":
    case "extracting":
    case "assembling":
      return "The graph was being built when this export was requested.";
    case "completed":
      return "The map was ready to inspect when this export was created.";
    case "canceled":
      return "The latest build was canceled.";
    case "insufficient_evidence":
      return "The graph could not be rebuilt because the available evidence was not strong enough.";
    case "failed":
      return "The graph could not be rebuilt from the current sources.";
  }
}

function formatExportProse(value: string) {
  return formatPublicProseText(value) || value;
}

function appendSnippetLines(input: {
  lines: string[];
  snippet: Snippet;
  source?: Source;
}) {
  const origin = resolveSnippetOrigin(input.snippet, input.source);
  const sourceNoteLimitation = input.source
    ? getSourceNoteLimitation(input.source, [input.snippet])
    : null;
  const starterDemoSnippetNotice = getStarterDemoSnippetNotice(input.snippet);
  const starterDemoSourceNotice = input.source
    ? getStarterDemoSourceNotice(input.source, [input.snippet])
    : null;
  const snippetText = getSnippetPublicText(input.snippet, { maxLength: 520 });
  const rationale = formatPublicSnippetRationale(input.snippet.rationale, origin);

  input.lines.push(`- "${snippetText}"`);
  input.lines.push(`  Why it matters: ${rationale}`);
  if (starterDemoSnippetNotice) {
    input.lines.push(`  Starter note: ${starterDemoSnippetNotice}`);
  }
  input.lines.push(
    `  Source: ${input.source ? input.source.title : input.snippet.sourceId}`
  );
  if (input.source) {
    input.lines.push(`  Source detail: ${formatSourceReference(input.source)}`);

    if (sourceNoteLimitation) {
      input.lines.push(`  Source limitation: ${sourceNoteLimitation}`);
    }
    if (starterDemoSourceNotice) {
      input.lines.push(`  Source limitation: ${starterDemoSourceNotice}`);
    }
  }
  if (input.snippet.locationLabel) {
    input.lines.push(`  Location: ${input.snippet.locationLabel}`);
  }
  if (typeof input.snippet.pageNumber === "number") {
    input.lines.push(`  Page: ${input.snippet.pageNumber}`);
  }
  if (
    typeof input.snippet.offsetStart === "number" &&
    typeof input.snippet.offsetEnd === "number"
  ) {
    input.lines.push(`  Offset: ${input.snippet.offsetStart}-${input.snippet.offsetEnd}`);
  }
  input.lines.push(`  Provenance: ${getSnippetOriginLabel(origin)}`);
  input.lines.push(`  Note: ${getSnippetOriginDescription(origin)}`);
}

function appendNodeSection(input: {
  lines: string[];
  title: string;
  nodes: GraphNode[];
  sourceById: Map<string, Source>;
  snippetById: Map<string, Snippet>;
}) {
  if (!input.nodes.length) {
    return;
  }

  input.lines.push(`## ${input.title}`);
  input.lines.push("");

  for (const node of input.nodes) {
    const nodeSources = getSourcesForNode(node, input.sourceById);
    const qualifiers = getNodeQualifiers(node);
    const gapType = getNodeGapType(node);
    const gapImportance = getNodeGapImportance(node);
    const reviewNotes = filterExportReviewNotes(
      buildNodeReviewNotes(node, nodeSources)
    );

    input.lines.push(`### ${node.title}`);
    input.lines.push("");
    input.lines.push(formatExportProse(node.summary));
    input.lines.push("");

    const metadata: string[] = [];

    if (node.topic) {
      metadata.push(`Topic: ${node.topic}`);
    }

    if (node.stance) {
      metadata.push(`Stance: ${node.stance}`);
    }

    if (typeof node.confidence === "number") {
      metadata.push(`Confidence: ${Math.round(node.confidence * 100)}%`);
    }

    if (gapType) {
      metadata.push(`Gap type: ${formatGapTypeLabel(gapType)}`);
    }

    if (typeof gapImportance === "number") {
      metadata.push(`Gap importance: ${Math.round(gapImportance * 100)}%`);
    }

    if (metadata.length) {
      input.lines.push(metadata.join(" | "));
      input.lines.push("");
    }

    if (qualifiers.length) {
      input.lines.push("Qualifiers:");
      for (const qualifier of qualifiers) {
        input.lines.push(`- ${qualifier}`);
      }
      input.lines.push("");
    }

    if (reviewNotes.length) {
      input.lines.push("Review notes:");
      for (const note of reviewNotes) {
        input.lines.push(`- ${note}`);
      }
      input.lines.push("");
    }

    if (node.sourceIds.length) {
      input.lines.push("Sources:");
      for (const sourceId of node.sourceIds) {
        const source = input.sourceById.get(sourceId);

        if (!source) {
          continue;
        }

        input.lines.push(`- ${source.title} (${formatSourceReference(source)})`);
        const nodeSourceSnippets = node.snippetIds
          .map((snippetId) => input.snippetById.get(snippetId))
          .filter(
            (snippet): snippet is Snippet =>
              snippet?.sourceId === source.id
          );
        const sourceNoteLimitation = getSourceNoteLimitation(
          source,
          nodeSourceSnippets
        );
        const starterDemoSourceNotice = getStarterDemoSourceNotice(
          source,
          nodeSourceSnippets
        );

        if (source.url) {
          input.lines.push(`  Link: ${source.url}`);
        }

        if (sourceNoteLimitation) {
          input.lines.push(`  Source limitation: ${sourceNoteLimitation}`);
        }
        if (starterDemoSourceNotice) {
          input.lines.push(`  Source limitation: ${starterDemoSourceNotice}`);
        }
      }
      input.lines.push("");
    }

    if (node.snippetIds.length) {
      input.lines.push("Snippets:");
      for (const snippetId of node.snippetIds) {
        const snippet = input.snippetById.get(snippetId);

        if (!snippet) {
          continue;
        }

        const source = input.sourceById.get(snippet.sourceId);
        appendSnippetLines({
          lines: input.lines,
          snippet,
          source
        });
      }
      input.lines.push("");
    }
  }
}

function appendFocusedReviewSection(input: {
  lines: string[];
  graph: WorkspaceGraphPayload["graph"];
  sources: Source[];
  snippets: Snippet[];
  exportMode: {
    strongestOnly?: boolean;
    focusClusterId?: string | null;
    selectedNodeId?: string | null;
    reviewBranchFilter?: ReviewBranchFilter;
    reviewSourceFilterLabel?: string | null;
  };
}) {
  const clusterInspection = getInspectionCluster({
    graph: input.graph,
    selectedNodeId: input.exportMode.selectedNodeId ?? null,
    focusClusterId: input.exportMode.focusClusterId ?? null,
    strongestOnly: Boolean(input.exportMode.strongestOnly),
    sources: input.sources,
    snippets: input.snippets
  });

  if (!clusterInspection) {
    return;
  }

  input.lines.push("## Focused disagreement review");
  input.lines.push("");
  input.lines.push(`**${clusterInspection.cluster.title}**`);
  input.lines.push("");
  input.lines.push(clusterInspection.cluster.explanation);
  input.lines.push("");

  const reviewNotes: string[] = [];

  if (input.exportMode.reviewBranchFilter && input.exportMode.reviewBranchFilter !== "all") {
    reviewNotes.push(
      `Sidebar review emphasis at export time: ${formatReviewBranchFilter(input.exportMode.reviewBranchFilter)}`
    );
  }

  if (input.exportMode.reviewSourceFilterLabel) {
    reviewNotes.push(
      `Sidebar source emphasis at export time: ${input.exportMode.reviewSourceFilterLabel}`
    );
  }

  if (reviewNotes.length) {
    input.lines.push(reviewNotes.join(" | "));
    input.lines.push("");
  }

  input.lines.push("### Branch comparison");
  input.lines.push("");

  const sourceById = getSourceById(input.sources);

  if (clusterInspection.leftClaim) {
    const leftSources = getSourcesForNode(clusterInspection.leftClaim, sourceById);
    const leftQualifiers = getNodeQualifiers(clusterInspection.leftClaim);
    const leftReviewNotes = buildNodeReviewNotes(
      clusterInspection.leftClaim,
      leftSources
    );
    const filteredLeftReviewNotes = filterExportReviewNotes(leftReviewNotes);

    input.lines.push(`- Claim A: ${clusterInspection.leftClaim.title}`);
    input.lines.push(`  Summary: ${formatExportProse(clusterInspection.leftClaim.summary)}`);
    input.lines.push(
      `  Grounding: ${formatCount(clusterInspection.leftClaim.sourceIds.length, "source")} / ${formatCount(clusterInspection.leftClaim.snippetIds.length, "snippet")}`
    );
    input.lines.push(
      `  Direct linked nodes: ${formatCount(clusterInspection.leftContext.length, "linked node")}`
    );
    if (leftQualifiers.length) {
      input.lines.push(`  Caveats: ${leftQualifiers.join("; ")}`);
    }
    if (filteredLeftReviewNotes.length) {
      input.lines.push(`  Review notes: ${filteredLeftReviewNotes.join(" ")}`);
    }
  }

  if (clusterInspection.rightClaim) {
    const rightSources = getSourcesForNode(clusterInspection.rightClaim, sourceById);
    const rightQualifiers = getNodeQualifiers(clusterInspection.rightClaim);
    const rightReviewNotes = buildNodeReviewNotes(
      clusterInspection.rightClaim,
      rightSources
    );
    const filteredRightReviewNotes = filterExportReviewNotes(rightReviewNotes);

    input.lines.push(`- Claim B: ${clusterInspection.rightClaim.title}`);
    input.lines.push(`  Summary: ${formatExportProse(clusterInspection.rightClaim.summary)}`);
    input.lines.push(
      `  Grounding: ${formatCount(clusterInspection.rightClaim.sourceIds.length, "source")} / ${formatCount(clusterInspection.rightClaim.snippetIds.length, "snippet")}`
    );
    input.lines.push(
      `  Direct linked nodes: ${formatCount(clusterInspection.rightContext.length, "linked node")}`
    );
    if (rightQualifiers.length) {
      input.lines.push(`  Caveats: ${rightQualifiers.join("; ")}`);
    }
    if (filteredRightReviewNotes.length) {
      input.lines.push(`  Review notes: ${filteredRightReviewNotes.join(" ")}`);
    }
  }

  input.lines.push(
    clusterInspection.unresolvedNodes.length
      ? `- Unresolved: ${formatCount(clusterInspection.unresolvedNodes.length, "attached gap")} ${clusterInspection.unresolvedNodes.length === 1 ? "still qualifies" : "still qualify"} the disagreement.`
      : "- Unresolved: no direct blocker nodes are attached to this disagreement cluster."
  );
  input.lines.push("");

  input.lines.push("### Resolution blockers");
  input.lines.push("");

  if (!clusterInspection.unresolvedNodes.length) {
    input.lines.push(
      "No dedicated gap nodes are attached to the focused disagreement cluster right now."
    );
    input.lines.push("");
    return;
  }

  for (const node of clusterInspection.unresolvedNodes) {
    const gapSources = getSourcesForNode(node, sourceById);
    const gapReviewNotes = filterExportReviewNotes(
      buildNodeReviewNotes(node, gapSources)
    );
    const gapType = getNodeGapType(node);
    const gapImportance = getNodeGapImportance(node);

    input.lines.push(`- ${node.title}`);
    input.lines.push(`  Summary: ${formatExportProse(node.summary)}`);
    input.lines.push(
      `  Grounding: ${formatCount(node.sourceIds.length, "source")} / ${formatCount(node.snippetIds.length, "snippet")}`
    );
    if (gapType) {
      input.lines.push(`  Gap type: ${formatGapTypeLabel(gapType)}`);
    }
    if (typeof gapImportance === "number") {
      input.lines.push(`  Gap importance: ${Math.round(gapImportance * 100)}%`);
    }
    if (gapReviewNotes.length) {
      input.lines.push(`  Review notes: ${gapReviewNotes.join(" ")}`);
    }
  }
  input.lines.push("");
}

function appendAlphaAssessmentSection(
  lines: string[],
  assessment: WorkspaceAlphaAssessment | null | undefined
) {
  if (!assessment) {
    return;
  }

  lines.push("## Alpha assessment");
  lines.push("");
  lines.push(`Reviewer role: ${assessment.reviewerRole}`);
  lines.push(`Verdict: ${assessment.verdict.replaceAll("_", " ")}`);
  lines.push(
    `Would revisit: ${assessment.wouldRevisit ? "yes" : "no"} | Would share export: ${assessment.wouldShareExport ? "yes" : "no"}`
  );
  lines.push(
    `Strongest disagreement clarity: ${assessment.strongestDisagreementRating}/5 | Provenance trust: ${assessment.provenanceTrustRating}/5`
  );
  if (assessment.confusionPoints) {
    lines.push("");
    lines.push("Confusion points:");
    lines.push(assessment.confusionPoints);
  }
  if (assessment.blockerNotes) {
    lines.push("");
    lines.push("Blockers:");
    lines.push(assessment.blockerNotes);
  }
  if (assessment.followUpQuestion) {
    lines.push("");
    lines.push("Follow-up question:");
    lines.push(assessment.followUpQuestion);
  }
  lines.push("");
}

type GraphMarkdownExportContext = {
  strongestOnly?: boolean;
  unresolvedOnly?: boolean;
  hiddenKinds?: GraphNode["kind"][];
  focusClusterId?: string | null;
  selectedNodeId?: string | null;
  savedReviewStateId?: string | null;
  savedReviewStateLabel?: string | null;
  reviewBranchFilter?: ReviewBranchFilter;
  reviewSourceFilterId?: string | null;
  reviewSourceFilterLabel?: string | null;
};

function buildGraphMarkdownDocument(
  payload: WorkspaceGraphPayload,
  assessment?: WorkspaceAlphaAssessment | null,
  exportContext?: GraphMarkdownExportContext
) {
  const { workspace, graph, sources, snippets, starterMode, run } = payload;
  const exportMode = exportContext ?? {};
  const claims = byKind(graph.nodes, "claim");
  const counterclaims = byKind(graph.nodes, "counterclaim");
  const evidenceNodes = byKind(graph.nodes, "evidence");
  const gapNodes = byKind(graph.nodes, "gap");
  const primaryCluster = getPrimaryCluster(graph);
  const sourceById = getSourceById(sources);
  const snippetById = getSnippetById(snippets);
  const sourceNoteLimitations = buildSourceNoteLimitationSummary(sources, snippets);
  const webSourceLimitations = buildPublicGraphSourceLimitations(sources);
  const graphSourceMode = getGraphSourceMode(payload);
  const graphSourceLabel = getGraphSourceModeLabel(graphSourceMode);
  const publicGraphQuality = assessPublicGraphQuality(payload);
  const selectedNode = exportMode.selectedNodeId
    ? graph.nodes.find((node) => node.id === exportMode.selectedNodeId) ?? null
    : null;
  const lines: string[] = [];

  lines.push("# ClaimGraph Export");
  lines.push("");
  lines.push("## Mode");
  lines.push("");
  lines.push(graphSourceLabel);
  lines.push("");
  lines.push(getGraphSourceModeExportDescription(graphSourceMode));
  lines.push("");

  if (
    graphSourceMode === "web_sourced" ||
    graphSourceMode === "mixed" ||
    publicGraphQuality.label !== "Graph complete"
  ) {
    lines.push("## Graph quality");
    lines.push("");
    lines.push(publicGraphQuality.label);
    lines.push("");
    lines.push(publicGraphQuality.exportNote);
    lines.push("");
  }

  if (starterMode) {
    lines.push("## Starter source notice");
    lines.push("");
    lines.push(
      "Every non-question starter node is linked to visible sample snippets so the UI can be inspected. These sample snippets are not fetched external citations and should not be used as evidence for the real-world question."
    );
    lines.push("");
  }

  if (sourceNoteLimitations || webSourceLimitations.length) {
    lines.push("## Source limitations");
    lines.push("");

    if (sourceNoteLimitations) {
      lines.push(sourceNoteLimitations.message);
      lines.push("");
      for (const source of sourceNoteLimitations.sources) {
        const linkedSnippetCount = getSnippetsForSource(source, snippets).length;
        lines.push(
          `- ${source.title}: uploaded source-note file with ${formatCount(linkedSnippetCount, "linked snippet")}.`
        );
      }
      lines.push("");
    }

    for (const limitation of webSourceLimitations) {
      lines.push(`- ${limitation}`);
    }
    lines.push("");
  }

  if (
    exportMode.strongestOnly ||
    exportMode.unresolvedOnly ||
    (exportMode.hiddenKinds?.length ?? 0) > 0 ||
    Boolean(exportMode.savedReviewStateLabel) ||
    Boolean(exportMode.reviewSourceFilterLabel) ||
    Boolean(exportMode.reviewBranchFilter && exportMode.reviewBranchFilter !== "all") ||
    Boolean(selectedNode)
  ) {
    lines.push("## Export context");
    lines.push("");
    lines.push(
      "This markdown export describes the persisted workspace graph. The notes below capture the graph and review state that were visible in the browser at export time, but the export does not trim the content down to only the filtered viewport or sidebar inspection scope."
    );
    lines.push("");
    lines.push(
      `Focused disagreement mode: ${exportMode.strongestOnly ? "on" : "off"}`
    );
    lines.push(
      `Unresolved-only mode: ${exportMode.unresolvedOnly ? "on" : "off"}`
    );
    if (exportMode.focusClusterId) {
      lines.push(`Focused cluster id: ${exportMode.focusClusterId}`);
    }
    if (exportMode.hiddenKinds?.length) {
      lines.push(`Hidden node kinds in the browser view: ${exportMode.hiddenKinds.join(", ")}`);
    }
    if (selectedNode) {
      lines.push(`Selected node in the browser view: ${selectedNode.title}`);
    }
    if (exportMode.savedReviewStateLabel) {
      lines.push(`Saved review state: ${exportMode.savedReviewStateLabel}`);
    }
    if (exportMode.reviewBranchFilter && exportMode.reviewBranchFilter !== "all") {
      lines.push(
        `Sidebar branch filter: ${formatReviewBranchFilter(exportMode.reviewBranchFilter)}`
      );
    }
    if (exportMode.reviewSourceFilterLabel) {
      lines.push(`Sidebar source filter: ${exportMode.reviewSourceFilterLabel}`);
    }
    lines.push("");
  }

  if (run?.status) {
    lines.push("## Run status");
    lines.push("");
    lines.push(`Status: ${run.status}`);
    lines.push(formatExportRunStatusMessage(run));
    lines.push("");
  }

  appendAlphaAssessmentSection(lines, assessment);

  lines.push("## Question");
  lines.push("");
  lines.push(workspace.question);
  lines.push("");
  lines.push("## Executive summary");
  lines.push("");
  lines.push(formatExportProse(graph.graphSummary));
  lines.push("");

  if (primaryCluster) {
    const leftClaim = graph.nodes.find(
      (node) => node.id === primaryCluster.claimIds[0]
    );
    const rightClaim = graph.nodes.find(
      (node) => node.id === primaryCluster.claimIds[1]
    );
    const clusterSnippets = primaryCluster.snippetIds
      .map((snippetId) => snippetById.get(snippetId))
      .filter((snippet): snippet is Snippet => Boolean(snippet));

    lines.push("## Strongest disagreement");
    lines.push("");
    lines.push(`**${primaryCluster.title}**`);
    lines.push("");
    lines.push(formatExportProse(primaryCluster.explanation));
    lines.push("");
    if (leftClaim) {
      lines.push(`Claim A: ${leftClaim.title}`);
    }
    if (rightClaim) {
      lines.push(`Claim B: ${rightClaim.title}`);
    }
    lines.push(`Cluster score: ${Math.round(primaryCluster.score * 100)}%`);
    lines.push("");

    if (clusterSnippets.length) {
      lines.push("Relevant disagreement snippets:");
      for (const snippet of clusterSnippets) {
        const source = sourceById.get(snippet.sourceId);
        appendSnippetLines({
          lines,
          snippet,
          source
        });
      }
      lines.push("");
    }
  }

  appendFocusedReviewSection({
    lines,
    graph,
    sources,
    snippets,
    exportMode: {
      strongestOnly: exportMode.strongestOnly,
      focusClusterId: exportMode.focusClusterId,
      selectedNodeId: exportMode.selectedNodeId,
      reviewBranchFilter: exportMode.reviewBranchFilter,
      reviewSourceFilterLabel: exportMode.reviewSourceFilterLabel
    }
  });

  appendNodeSection({
    lines,
    title: "Major claims",
    nodes: claims,
    sourceById,
    snippetById
  });
  appendNodeSection({
    lines,
    title: "Major counterclaims",
    nodes: counterclaims,
    sourceById,
    snippetById
  });
  appendNodeSection({
    lines,
    title: "Evidence nodes",
    nodes: evidenceNodes,
    sourceById,
    snippetById
  });
  appendNodeSection({
    lines,
    title: "What is still unresolved",
    nodes: gapNodes,
    sourceById,
    snippetById
  });

  lines.push("## Sources");
  lines.push("");
  sources.forEach((source, index) => {
    const sourceSnippets = getSnippetsForSource(source, snippets);
    const sourceReviewFlags = buildSourceReviewFlags(source);
    const sourceNoteLimitation = getSourceNoteLimitation(
      source,
      sourceSnippets
    );
    const starterDemoSource = isStarterDemoSource(source, sourceSnippets);
    const starterDemoSourceNotice = getStarterDemoSourceNotice(source, sourceSnippets);

    lines.push(`${index + 1}. ${source.title}`);
    lines.push(`   ${formatSourceReference(source)}`);
    lines.push(`   Source id: ${source.id}`);
    if (starterDemoSource) {
      lines.push("   Source type: sample starter source");
    }
    if (source.url) {
      lines.push(`   Link: ${source.url}`);
    }
    if (sourceReviewFlags.length) {
      lines.push(`   Limitations: ${sourceReviewFlags.join("; ")}`);
    }
    if (sourceNoteLimitation) {
      lines.push(`   Source limitation: ${sourceNoteLimitation}`);
    }
    if (starterDemoSourceNotice) {
      lines.push(`   Source limitation: ${starterDemoSourceNotice}`);
    }
  });
  lines.push("");

  return lines.join("\n");
}

/**
 * Owner-facing exports intentionally exclude protected alpha assessments and
 * reviewer notes. Ownership authorizes workspace mutation and export
 * persistence; it does not make developer-only review records public data.
 */
export function buildPublicGraphMarkdown(
  payload: WorkspaceGraphPayload,
  exportContext?: GraphMarkdownExportContext
) {
  return buildGraphMarkdownDocument(payload, null, exportContext);
}

/** Protected developer tooling may opt into assessment notes explicitly. */
export function buildDeveloperGraphMarkdown(
  payload: WorkspaceGraphPayload,
  assessment: WorkspaceAlphaAssessment | null,
  exportContext?: GraphMarkdownExportContext
) {
  return buildGraphMarkdownDocument(payload, assessment, exportContext);
}
