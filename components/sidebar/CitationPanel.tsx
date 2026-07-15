"use client";

import { useEffect, useMemo } from "react";
import {
  buildNodeReviewFlags,
  buildNodeReviewNotes,
  getNodeQualifiers
} from "@/lib/review/citation-context";
import { buildNodeProvenanceCallout } from "@/lib/provenance/starter-demo";
import { getInspectionCluster, getNodeProvenance, getRelatedNodes } from "@/lib/sidebar/inspection";
import type {
  ClaimGraph,
  EdgeRelation,
  GraphNode,
  ReviewBranchFilter,
  Snippet,
  Source,
  WorkspaceSavedReviewState
} from "@/types/claimgraph";
import { SnippetList } from "./SnippetList";
import { SourceCard } from "./SourceCard";

interface BranchComparisonCard {
  id: "left" | "right" | "unresolved";
  label: string;
  title: string;
  summary: string;
  detail: string;
  sourceCount: number;
  snippetCount: number;
  scopeLabel: string;
  active: boolean;
  inspectNodeId?: string;
}

function formatCount(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function buildNodeExplanation(node: GraphNode | null) {
  if (!node) {
    return "Select a node to inspect its role, grounding, and supporting evidence.";
  }

  switch (node.kind) {
    case "question":
      return "The question node anchors the argument map and should remain singular and neutral.";
    case "claim":
      return "This claim represents a grounded supporting branch of the question.";
    case "counterclaim":
      return "This counterclaim keeps the opposing branch explicit instead of flattening disagreement into summary prose.";
    case "evidence":
      return "This evidence node grounds a nearby branch in a specific cited snippet.";
    case "gap":
      return "This gap node marks unresolved context or mixed evidence that blocks a stronger conclusion.";
  }
}

function buildNodeWhyItExists(node: GraphNode | null) {
  if (!node) {
    return "The inspector becomes active once a node is selected.";
  }

  const sourceCount = node.sourceIds.length;
  const snippetCount = node.snippetIds.length;

  switch (node.kind) {
    case "question":
      return "Every branch in the map traces back to this root question.";
    case "claim":
    case "counterclaim":
      return `This branch is grounded in ${snippetCount} snippet${snippetCount === 1 ? "" : "s"} across ${sourceCount} source${sourceCount === 1 ? "" : "s"}.`;
    case "evidence":
      return "Evidence nodes keep the source trail inspectable without forcing the user to leave the graph.";
    case "gap":
      return "Gap nodes are first-class output because missing context and mixed evidence are part of the answer.";
  }
}

function buildSelectedNodeSourceTrailSummary({
  node,
  sources,
  snippets
}: {
  node: GraphNode | null;
  sources: Source[];
  snippets: Snippet[];
}) {
  if (!node || node.kind === "question") {
    return null;
  }

  if (!sources.length && !snippets.length) {
    return "Source trail missing: this node has no direct cited source attached yet.";
  }

  const sourceCount = formatCount(sources.length, "source");
  const snippetCount = formatCount(snippets.length, "snippet");

  return `Source trail visible: ${sourceCount} and ${snippetCount} are attached. See Evidence and Sources below for snippets, source details, and links.`;
}

function buildNodeKindLabel(kind: GraphNode["kind"] | undefined) {
  switch (kind) {
    case "question":
      return "Question";
    case "claim":
      return "Claim";
    case "counterclaim":
      return "Counterclaim";
    case "evidence":
      return "Evidence";
    case "gap":
      return "Open gap";
    default:
      return "Node";
  }
}

function buildSummaryHeading(node: GraphNode | null) {
  switch (node?.kind) {
    case "evidence":
      return "What this evidence says";
    case "gap":
      return "What is still uncertain";
    case "question":
      return "Question focus";
    default:
      return "Summary";
  }
}

function buildEvidenceHeading(node: GraphNode | null) {
  switch (node?.kind) {
    case "evidence":
      return "Cited snippet";
    case "gap":
      return "Signals behind the gap";
    default:
      return "Evidence";
  }
}

function buildEvidenceEmptyMessage(node: GraphNode | null, sourceFilterId: string) {
  const baseMessage =
    node?.kind === "gap"
      ? "No snippets are attached to this gap yet."
      : node?.kind === "question"
        ? "Question nodes do not carry direct evidence. Inspect a claim, counterclaim, evidence, or gap node."
        : "No snippets attached to this node.";

  return buildEmptyFilterMessage(baseMessage, sourceFilterId);
}

function buildMetadataPills(node: GraphNode | null, sources: Source[] = []) {
  if (!node) {
    return [] as string[];
  }

  const pills: string[] = [buildNodeKindLabel(node.kind)];

  if (node.topic) {
    pills.push(node.topic);
  }

  if (node.stance) {
    pills.push(node.stance);
  }

  if (typeof node.confidence === "number") {
    pills.push(`${Math.round(node.confidence * 100)}% grounding`);
  }

  pills.push(`${node.sourceIds.length} source${node.sourceIds.length === 1 ? "" : "s"}`);
  pills.push(`${node.snippetIds.length} snippet${node.snippetIds.length === 1 ? "" : "s"}`);
  pills.push(...buildNodeReviewFlags(node, sources));

  return pills;
}

function relationLabel(direction: "incoming" | "outgoing", relation: string) {
  return direction === "incoming" ? `${relation} this node` : `this node ${relation}`;
}

function relationGroupLabel(direction: "incoming" | "outgoing", relation: EdgeRelation) {
  switch (relation) {
    case "supports":
      return direction === "incoming" ? "Supported by" : "Supports";
    case "refutes":
      return direction === "incoming" ? "Refuted by" : "Refutes";
    case "qualifies":
      return direction === "incoming" ? "Qualified by" : "Qualifies";
    case "depends_on":
      return direction === "incoming" ? "Needed by" : "Depends on";
  }
}

function relationSentence(direction: "incoming" | "outgoing", relation: EdgeRelation) {
  switch (relation) {
    case "supports":
      return direction === "incoming"
        ? "This node is supported by the linked item."
        : "This node supports the linked item.";
    case "refutes":
      return direction === "incoming"
        ? "This node is challenged by the linked item."
        : "This node challenges the linked item.";
    case "qualifies":
      return direction === "incoming"
        ? "This node is qualified by the linked item."
        : "This node qualifies the linked item.";
    case "depends_on":
      return direction === "incoming"
        ? "The linked item depends on this node."
        : "This node depends on the linked item.";
  }
}

function buildConflictSummary(
  clusterInspection: NonNullable<ReturnType<typeof getInspectionCluster>>
) {
  const unresolvedCount = clusterInspection.unresolvedNodes.length;

  if (!clusterInspection.leftClaim || !clusterInspection.rightClaim) {
    return clusterInspection.cluster.explanation;
  }

  return [
    `${clusterInspection.leftClaim.title} and ${clusterInspection.rightClaim.title} conflict because ${clusterInspection.cluster.explanation}`,
    unresolvedCount
      ? `${unresolvedCount} unresolved ${unresolvedCount === 1 ? "dependency still qualifies" : "dependencies still qualify"} this disagreement.`
      : "No direct unresolved dependency is currently attached to this disagreement cluster."
  ].join(" ");
}

function buildSelectedFrameLabel(
  selectedFrame: NonNullable<ReturnType<typeof getInspectionCluster>>["selectedFrame"]
) {
  switch (selectedFrame) {
    case "left":
      return "Selected node is on Claim A's branch";
    case "right":
      return "Selected node is on Claim B's branch";
    case "unresolved":
      return "Selected node is part of the unresolved branch";
    default:
      return null;
  }
}

function dedupeById<T extends { id: string }>(values: T[]) {
  const map = new Map<string, T>();

  for (const value of values) {
    if (!map.has(value.id)) {
      map.set(value.id, value);
    }
  }

  return [...map.values()];
}

function collectProvenanceFromNodes(nodes: GraphNode[], sources: Source[], snippets: Snippet[]) {
  const sourceIds = new Set<string>();
  const snippetIds = new Set<string>();

  for (const node of nodes) {
    node.sourceIds.forEach((sourceId) => sourceIds.add(sourceId));
    node.snippetIds.forEach((snippetId) => snippetIds.add(snippetId));
  }

  return {
    sources: sources.filter((source) => sourceIds.has(source.id)),
    snippets: snippets.filter((snippet) => snippetIds.has(snippet.id))
  };
}

function filterSourcesBySourceId(sources: Source[], sourceFilterId: string) {
  if (sourceFilterId === "all") {
    return sources;
  }

  return sources.filter((source) => source.id === sourceFilterId);
}

function filterSnippetsBySourceId(snippets: Snippet[], sourceFilterId: string) {
  if (sourceFilterId === "all") {
    return snippets;
  }

  return snippets.filter((snippet) => snippet.sourceId === sourceFilterId);
}

function buildSourceFilterLabel(source: Source) {
  const detail = source.fileName ?? source.domain ?? source.type;
  return `${source.title} (${detail})`;
}

function buildBranchFilterLabel(branchFilter: ReviewBranchFilter) {
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

function buildEmptyFilterMessage(
  baseMessage: string,
  sourceFilterId: string
) {
  return sourceFilterId === "all"
    ? baseMessage
    : "No attached evidence remains after the current source filter.";
}

function getNodeSources(node: GraphNode | null, sources: Source[]) {
  if (!node) {
    return [] as Source[];
  }

  const sourceIds = new Set(node.sourceIds);
  return sources.filter((source) => sourceIds.has(source.id));
}

export interface CitationPanelProps {
  graph: ClaimGraph;
  selectedNode: GraphNode | null;
  sources: Source[];
  snippets: Snippet[];
  strongestOnly: boolean;
  focusClusterId?: string | null;
  branchFilter: ReviewBranchFilter;
  onBranchFilterChange: (branchFilter: ReviewBranchFilter) => void;
  sourceFilterId: string;
  onSourceFilterChange: (sourceFilterId: string) => void;
  savedReviewStates: WorkspaceSavedReviewState[];
  matchedSavedReviewStateId?: string | null;
  onSaveReviewState: () => void;
  onApplySavedReviewState: (savedReviewStateId: string) => void;
  onDeleteSavedReviewState: (savedReviewStateId: string) => void;
  onSelectNode: (nodeId: string) => void;
  variant?: "standard" | "drawer";
}

export function CitationPanel({
  graph,
  selectedNode,
  sources,
  snippets,
  strongestOnly,
  focusClusterId,
  branchFilter,
  onBranchFilterChange,
  sourceFilterId,
  onSourceFilterChange,
  savedReviewStates,
  matchedSavedReviewStateId,
  onSaveReviewState,
  onApplySavedReviewState,
  onDeleteSavedReviewState,
  onSelectNode,
  variant = "standard"
}: CitationPanelProps) {
  const nodeProvenance = getNodeProvenance({
    node: selectedNode,
    sources,
    snippets
  });
  const relatedNodes = getRelatedNodes(graph, selectedNode?.id ?? null);
  const clusterInspection = getInspectionCluster({
    graph,
    selectedNodeId: selectedNode?.id ?? null,
    focusClusterId,
    strongestOnly,
    sources,
    snippets
  });
  const clusterIndex = clusterInspection
    ? graph.disagreementClusters.findIndex(
        (cluster) => cluster.id === clusterInspection.cluster.id
      )
    : -1;

  const leftBranchNodes = useMemo(() => {
    if (!clusterInspection?.leftClaim) {
      return [] as GraphNode[];
    }

    return dedupeById([
      clusterInspection.leftClaim,
      ...clusterInspection.leftContext.map((item) => item.node)
    ]);
  }, [clusterInspection]);
  const rightBranchNodes = useMemo(() => {
    if (!clusterInspection?.rightClaim) {
      return [] as GraphNode[];
    }

    return dedupeById([
      clusterInspection.rightClaim,
      ...clusterInspection.rightContext.map((item) => item.node)
    ]);
  }, [clusterInspection]);
  const unresolvedBranchNodes = clusterInspection?.unresolvedNodes ?? [];
  const leftBranchProvenance = useMemo(() => {
    return collectProvenanceFromNodes(leftBranchNodes, sources, snippets);
  }, [leftBranchNodes, snippets, sources]);
  const rightBranchProvenance = useMemo(() => {
    return collectProvenanceFromNodes(rightBranchNodes, sources, snippets);
  }, [rightBranchNodes, snippets, sources]);
  const unresolvedBranchProvenance = useMemo(() => {
    return collectProvenanceFromNodes(unresolvedBranchNodes, sources, snippets);
  }, [snippets, sources, unresolvedBranchNodes]);
  const availableReviewSources = useMemo(() => {
    return dedupeById([
      ...nodeProvenance.sources,
      ...(clusterInspection?.sources ?? [])
    ]).sort((left, right) => left.title.localeCompare(right.title));
  }, [clusterInspection?.sources, nodeProvenance.sources]);
  const sourceFilterOptions = useMemo(() => {
    return [
      {
        id: "all",
        label: "All sources"
      },
      ...availableReviewSources.map((source) => ({
        id: source.id,
        label: buildSourceFilterLabel(source)
      }))
    ];
  }, [availableReviewSources]);

  useEffect(() => {
    if (!clusterInspection && branchFilter !== "all") {
      onBranchFilterChange("all");
      return;
    }

    if (branchFilter === "unresolved" && !clusterInspection?.unresolvedNodes.length) {
      onBranchFilterChange("all");
    }
  }, [branchFilter, clusterInspection, onBranchFilterChange]);

  useEffect(() => {
    if (sourceFilterOptions.some((option) => option.id === sourceFilterId)) {
      return;
    }

    onSourceFilterChange("all");
  }, [onSourceFilterChange, sourceFilterId, sourceFilterOptions]);

  const selectedFrameLabel = clusterInspection
    ? buildSelectedFrameLabel(clusterInspection.selectedFrame)
    : null;
  const filteredNodeSnippets = filterSnippetsBySourceId(
    nodeProvenance.snippets,
    sourceFilterId
  );
  const filteredNodeSources = filterSourcesBySourceId(
    nodeProvenance.sources,
    sourceFilterId
  );
  const nodeProvenanceCallout = buildNodeProvenanceCallout({
    node: selectedNode,
    sources: filteredNodeSources,
    snippets: filteredNodeSnippets
  });
  const selectedNodeSources = getNodeSources(selectedNode, sources);
  const selectedNodeQualifiers = getNodeQualifiers(selectedNode);
  const selectedNodeReviewNotes = buildNodeReviewNotes(selectedNode, selectedNodeSources);
  const activeClusterProvenance = useMemo(() => {
    if (!clusterInspection) {
      return {
        sources: [] as Source[],
        snippets: [] as Snippet[]
      };
    }

    switch (branchFilter) {
      case "left":
        return leftBranchProvenance;
      case "right":
        return rightBranchProvenance;
      case "unresolved":
        return unresolvedBranchProvenance;
      default:
        return {
          sources: clusterInspection.sources,
          snippets: clusterInspection.snippets
        };
    }
  }, [
    branchFilter,
    clusterInspection,
    leftBranchProvenance,
    rightBranchProvenance,
    unresolvedBranchProvenance
  ]);
  const filteredClusterSources = filterSourcesBySourceId(
    activeClusterProvenance.sources,
    sourceFilterId
  );
  const filteredClusterSnippets = filterSnippetsBySourceId(
    activeClusterProvenance.snippets,
    sourceFilterId
  );
  const filteredLeftSnippets = filterSnippetsBySourceId(
    clusterInspection?.leftSnippets ?? [],
    sourceFilterId
  );
  const filteredLeftSources = filterSourcesBySourceId(
    leftBranchProvenance.sources,
    sourceFilterId
  );
  const filteredRightSnippets = filterSnippetsBySourceId(
    clusterInspection?.rightSnippets ?? [],
    sourceFilterId
  );
  const filteredRightSources = filterSourcesBySourceId(
    rightBranchProvenance.sources,
    sourceFilterId
  );
  const filteredUnresolvedSnippets = filterSnippetsBySourceId(
    unresolvedBranchProvenance.snippets,
    sourceFilterId
  );
  const filteredUnresolvedSources = filterSourcesBySourceId(
    unresolvedBranchProvenance.sources,
    sourceFilterId
  );
  const matchedSavedReviewState = savedReviewStates.find(
    (savedReviewState) => savedReviewState.id === matchedSavedReviewStateId
  ) ?? null;
  const activeSourceFilterLabel =
    sourceFilterOptions.find((option) => option.id === sourceFilterId)?.label ?? "All sources";
  const snippetCountsBySourceId = new Map<string, number>();
  const clusterSnippetCountsBySourceId = new Map<string, number>();
  const showLeftBranch =
    Boolean(clusterInspection?.leftClaim) && (branchFilter === "all" || branchFilter === "left");
  const showRightBranch =
    Boolean(clusterInspection?.rightClaim) && (branchFilter === "all" || branchFilter === "right");
  const showUnresolvedBranch =
    branchFilter === "all" || branchFilter === "unresolved";
  const branchComparisonCards = useMemo(() => {
    if (!clusterInspection) {
      return [] as BranchComparisonCard[];
    }

    const cards: BranchComparisonCard[] = [];

    if (clusterInspection.leftClaim) {
      cards.push({
        id: "left",
        label: "Claim A",
        title: clusterInspection.leftClaim.title,
        summary: clusterInspection.leftClaim.summary,
        detail: clusterInspection.leftContext.length
          ? `${formatCount(clusterInspection.leftContext.length, "linked node")} ${clusterInspection.leftContext.length === 1 ? "remains" : "remain"} attached to this branch.`
          : "No direct branch context was preserved for this side.",
        sourceCount: filteredLeftSources.length,
        snippetCount: filteredLeftSnippets.length,
        scopeLabel: formatCount(clusterInspection.leftContext.length, "linked node"),
        active: branchFilter === "left",
        inspectNodeId: clusterInspection.leftClaim.id
      });
    }

    if (clusterInspection.rightClaim) {
      cards.push({
        id: "right",
        label: "Claim B",
        title: clusterInspection.rightClaim.title,
        summary: clusterInspection.rightClaim.summary,
        detail: clusterInspection.rightContext.length
          ? `${formatCount(clusterInspection.rightContext.length, "linked node")} ${clusterInspection.rightContext.length === 1 ? "remains" : "remain"} attached to this branch.`
          : "No direct branch context was preserved for this side.",
        sourceCount: filteredRightSources.length,
        snippetCount: filteredRightSnippets.length,
        scopeLabel: formatCount(clusterInspection.rightContext.length, "linked node"),
        active: branchFilter === "right",
        inspectNodeId: clusterInspection.rightClaim.id
      });
    }

    cards.push({
      id: "unresolved",
      label: "Unresolved",
      title: clusterInspection.unresolvedNodes.length
        ? formatCount(clusterInspection.unresolvedNodes.length, "blocking gap")
        : "No attached gap nodes",
      summary: clusterInspection.unresolvedNodes.length
        ? clusterInspection.unresolvedNodes[0]!.summary
        : "This disagreement cluster currently has no direct gap node attached.",
      detail: clusterInspection.unresolvedNodes.length
        ? `${formatCount(clusterInspection.unresolvedNodes.length, "blocker")} ${clusterInspection.unresolvedNodes.length === 1 ? "still qualifies" : "still qualify"} the disagreement.`
        : "The disagreement is explicit, but no dedicated blocker node is attached to it yet.",
      sourceCount: filteredUnresolvedSources.length,
      snippetCount: filteredUnresolvedSnippets.length,
      scopeLabel: formatCount(clusterInspection.unresolvedNodes.length, "blocker"),
      active: branchFilter === "unresolved"
    });

    return cards;
  }, [
    branchFilter,
    clusterInspection,
    filteredLeftSnippets.length,
    filteredLeftSources.length,
    filteredRightSnippets.length,
    filteredRightSources.length,
    filteredUnresolvedSnippets.length,
    filteredUnresolvedSources.length
  ]);

  for (const snippet of filteredNodeSnippets) {
    snippetCountsBySourceId.set(
      snippet.sourceId,
      (snippetCountsBySourceId.get(snippet.sourceId) ?? 0) + 1
    );
  }

  for (const snippet of filteredClusterSnippets) {
    clusterSnippetCountsBySourceId.set(
      snippet.sourceId,
      (clusterSnippetCountsBySourceId.get(snippet.sourceId) ?? 0) + 1
    );
  }

  const isDrawerVariant = variant === "drawer";
  const selectedNodeKindLabel = buildNodeKindLabel(selectedNode?.kind);
  const selectedNodeTone = selectedNode?.kind ?? "empty";
  const selectedNodeTitle = selectedNode?.title ?? "Select a box";
  const selectedNodeSummary = selectedNode?.summary ?? graph.graphSummary;
  const selectedNodePrimaryText = selectedNode
    ? buildNodeExplanation(selectedNode)
    : "Choose a node on the map to inspect what it means, why it matters, and which sources support it.";
  const selectedNodeSourceTrailSummary = buildSelectedNodeSourceTrailSummary({
    node: selectedNode,
    sources: filteredNodeSources,
    snippets: filteredNodeSnippets
  });
  const openGapNodes = selectedNode?.kind === "gap"
    ? dedupeById([selectedNode, ...unresolvedBranchNodes])
    : unresolvedBranchNodes;
  const openGapProvenance = collectProvenanceFromNodes(openGapNodes, sources, snippets);
  const filteredOpenGapSources = filterSourcesBySourceId(
    openGapProvenance.sources,
    sourceFilterId
  );
  const filteredOpenGapSnippets = filterSnippetsBySourceId(
    openGapProvenance.snippets,
    sourceFilterId
  );
  const relatedNodeGroups = relatedNodes.reduce(
    (groups, item) => {
      const label = relationGroupLabel(item.direction, item.relation);
      const group = groups.find((value) => value.label === label);

      if (group) {
        group.items.push(item);
      } else {
        groups.push({
          label,
          items: [item]
        });
      }

      return groups;
    },
    [] as Array<{ label: string; items: typeof relatedNodes }>
  );

  return (
    <div className={`node-inspector panel-stack${isDrawerVariant ? " panel-stack--drawer" : ""}`}>
      <section
        className={`panel-card node-inspector__hero node-inspector__hero--${selectedNodeTone}`}
        aria-label="Selected node details"
      >
        <div className="node-inspector__hero-top">
          <span className={`node-inspector__kind node-inspector__kind--${selectedNodeTone}`}>
            {selectedNodeKindLabel}
          </span>
          <div className="node-inspector__counts" aria-label="Selected node provenance counts">
            <span>{selectedNode?.sourceIds.length ?? 0} source{selectedNode?.sourceIds.length === 1 ? "" : "s"}</span>
            <span>{selectedNode?.snippetIds.length ?? 0} snippet{selectedNode?.snippetIds.length === 1 ? "" : "s"}</span>
          </div>
        </div>
        <h2>{selectedNodeTitle}</h2>
        <p className="node-inspector__lead">{selectedNodePrimaryText}</p>
        <div className="panel-card__chips">
          {buildMetadataPills(selectedNode, selectedNodeSources).map((pill) => (
            <span key={pill} className="pill pill--neutral">
              {pill}
            </span>
          ))}
        </div>
        <div className="node-inspector__provenance-callout">
          <span>Where this came from</span>
          <p>{nodeProvenanceCallout}</p>
          {selectedNodeSourceTrailSummary ? (
            <p className="node-inspector__source-trail-summary">
              {selectedNodeSourceTrailSummary}
            </p>
          ) : null}
        </div>
      </section>

      <section className="panel-card node-inspector__section" aria-label="Summary">
        <div className="node-inspector__section-heading">
          <p className="eyebrow">Summary</p>
          <h2>{buildSummaryHeading(selectedNode)}</h2>
        </div>
        <p>{selectedNodeSummary}</p>
        <p className="muted">{buildNodeWhyItExists(selectedNode)}</p>
        {selectedFrameLabel ? (
          <p className="node-inspector__inline-note">{selectedFrameLabel}</p>
        ) : null}
        {selectedNodeQualifiers.length ? (
          <div className="node-inspector__note-list" aria-label="Scope and caveats">
            {selectedNodeQualifiers.map((qualifier) => (
              <p key={qualifier} className="node-inspector__note">
                {qualifier}
              </p>
            ))}
          </div>
        ) : null}
        {selectedNodeReviewNotes.length ? (
          <details className="node-inspector__disclosure">
            <summary>Grounding notes</summary>
            <div className="node-inspector__note-list">
              {selectedNodeReviewNotes.map((note) => (
                <p key={note} className="node-inspector__note">
                  {note}
                </p>
              ))}
            </div>
          </details>
        ) : null}
      </section>

      <section className="panel-card node-inspector__section" aria-label="Evidence">
        <div className="node-inspector__section-heading node-inspector__section-heading--row">
          <div>
            <p className="eyebrow">Evidence</p>
            <h2>{buildEvidenceHeading(selectedNode)}</h2>
          </div>
          <span className="pill pill--neutral">
            {selectedNode ? filteredNodeSnippets.length : 0} visible
          </span>
        </div>
        <SnippetList
          snippets={filteredNodeSnippets}
          sources={sources}
          emptyMessage={buildEvidenceEmptyMessage(selectedNode, sourceFilterId)}
        />
      </section>

      <section className="panel-card node-inspector__section" aria-label="Sources">
        <div className="node-inspector__section-heading node-inspector__section-heading--row">
          <div>
            <p className="eyebrow">Sources</p>
            <h2>Where this comes from</h2>
          </div>
          <span className="pill pill--neutral">
            {selectedNode ? filteredNodeSources.length : 0} visible
          </span>
        </div>
        <div className="source-list">
          {filteredNodeSources.length ? (
            filteredNodeSources.map((source) => (
              <SourceCard
                key={source.id}
                source={source}
                snippets={filteredNodeSnippets.filter(
                  (snippet) => snippet.sourceId === source.id
                )}
                snippetCount={snippetCountsBySourceId.get(source.id) ?? 0}
              />
            ))
          ) : (
            <p className="muted">
              {sourceFilterId === "all"
                ? "This node currently has no direct sources."
                : "No sources remain after the current source filter."}
            </p>
          )}
        </div>
      </section>

      <section className="panel-card node-inspector__section" aria-label="Related nodes">
        <div className="node-inspector__section-heading node-inspector__section-heading--row">
          <div>
            <p className="eyebrow">Related</p>
            <h2>Connected map items</h2>
          </div>
          <span className="pill pill--neutral">{relatedNodes.length} linked</span>
        </div>
        {relatedNodeGroups.length ? (
          <div className="node-inspector__related-groups">
            {relatedNodeGroups.map((group) => (
              <div key={group.label} className="node-inspector__related-group">
                <p className="node-inspector__group-label">{group.label}</p>
                <div className="panel-card__related-list">
                  {group.items.map((item) => (
                    <article
                      key={`${item.direction}:${item.relation}:${item.node.id}`}
                      className="panel-card__related-item node-inspector__related-item"
                    >
                      <div className="panel-card__related-row">
                        <div>
                          <p className="panel-card__related-title">{item.node.title}</p>
                          <p className="muted">{relationSentence(item.direction, item.relation)}</p>
                        </div>
                        <div className="panel-card__chips">
                          <span className="pill pill--neutral">
                            {buildNodeKindLabel(item.node.kind)}
                          </span>
                          <button
                            type="button"
                            className="button button--ghost button--small"
                            onClick={() => onSelectNode(item.node.id)}
                            disabled={selectedNode?.id === item.node.id}
                          >
                            {selectedNode?.id === item.node.id ? "Inspecting" : "Inspect"}
                          </button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">Select a node to inspect its immediate graph context.</p>
        )}
      </section>

      <section className="panel-card node-inspector__section" aria-label="Open gaps">
        <div className="node-inspector__section-heading node-inspector__section-heading--row">
          <div>
            <p className="eyebrow">Open gaps</p>
            <h2>
              {openGapNodes.length
                ? formatCount(openGapNodes.length, "attached gap")
                : "No direct gap nodes"}
            </h2>
          </div>
          <div className="panel-card__chips">
            <span className="pill pill--neutral">
              {formatCount(filteredOpenGapSources.length, "source")}
            </span>
            <span className="pill pill--neutral">
              {formatCount(filteredOpenGapSnippets.length, "snippet")}
            </span>
          </div>
        </div>
        <p className="muted">
          {selectedNode?.kind === "gap"
            ? "This gap marks missing context that should stay visible before the map is treated as settled."
            : "Gap nodes keep unresolved dependencies visible instead of hiding them inside a summary."}
        </p>
        {openGapNodes.length ? (
          <div className="panel-card__blocker-list node-inspector__gap-list">
            {openGapNodes.map((node) => {
              const nodeSources = getNodeSources(node, sources);
              const reviewNotes = buildNodeReviewNotes(node, nodeSources);

              return (
                <article key={node.id} className="panel-card__summary-item node-inspector__gap-item">
                  <div className="panel-card__related-row">
                    <div>
                      <p className="eyebrow">Gap</p>
                      <h3>{node.title}</h3>
                    </div>
                    <button
                      type="button"
                      className="button button--ghost button--small"
                      onClick={() => onSelectNode(node.id)}
                      disabled={selectedNode?.id === node.id}
                    >
                      {selectedNode?.id === node.id ? "Inspecting" : "Inspect"}
                    </button>
                  </div>
                  <p>{node.summary}</p>
                  {reviewNotes.length ? (
                    <p className="muted">{reviewNotes.join(" ")}</p>
                  ) : null}
                </article>
              );
            })}
          </div>
        ) : (
          <p className="muted">This conflict currently has no direct gap node attached to it.</p>
        )}
      </section>

      <details className="panel-card panel-card--disclosure node-inspector__secondary" open={!isDrawerVariant}>
        <summary className="panel-card__disclosure-summary">
          <div>
            <p className="eyebrow">View controls</p>
            <h2>Map controls</h2>
          </div>
          <div className="panel-card__chips">
            {matchedSavedReviewState ? (
              <span className="pill pill--accent">{matchedSavedReviewState.label}</span>
            ) : null}
            <span className="pill pill--neutral">
              {buildBranchFilterLabel(branchFilter)}
            </span>
            <span className="pill pill--neutral">
              {filteredClusterSnippets.length} conflict snippet{filteredClusterSnippets.length === 1 ? "" : "s"}
            </span>
          </div>
        </summary>
        <div className="panel-card__disclosure-body">
          <div className="inspection-controls">
            <div className="inspection-controls__group">
              <span className="toolbar__group-label">Saved views</span>
              <div className="inspection-controls__buttons">
                <button
                  type="button"
                  className="button button--ghost button--small"
                  onClick={onSaveReviewState}
                >
                  {matchedSavedReviewState ? "Saved view active" : "Save view"}
                </button>
              </div>
              {savedReviewStates.length ? (
                <div className="inspection-controls__saved-list">
                  {savedReviewStates.map((savedReviewState) => {
                    const isActive = savedReviewState.id === matchedSavedReviewStateId;

                    return (
                      <div
                        key={savedReviewState.id}
                        className="inspection-controls__saved-item"
                      >
                        <button
                          type="button"
                          className={
                            isActive
                              ? "button button--primary button--small"
                              : "button button--ghost button--small"
                          }
                          onClick={() => onApplySavedReviewState(savedReviewState.id)}
                          aria-pressed={isActive}
                        >
                          {savedReviewState.label}
                        </button>
                        <button
                          type="button"
                          className="button button--ghost button--small"
                          onClick={() => onDeleteSavedReviewState(savedReviewState.id)}
                          aria-label={`Remove saved view ${savedReviewState.label}`}
                        >
                          Remove
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="muted">
                  Save the current graph and inspector focus when you want to return to the same view later.
                </p>
              )}
            </div>

            {clusterInspection ? (
              <div className="inspection-controls__group">
                <span className="toolbar__group-label">Main conflict</span>
                <div className="inspection-controls__buttons">
                  <button
                    type="button"
                    className={
                      branchFilter === "all"
                        ? "button button--primary button--small"
                        : "button button--ghost button--small"
                    }
                    onClick={() => onBranchFilterChange("all")}
                  >
                    All branches
                  </button>
                  {clusterInspection.leftClaim ? (
                    <button
                      type="button"
                      className={
                        branchFilter === "left"
                          ? "button button--primary button--small"
                          : "button button--ghost button--small"
                      }
                      onClick={() => onBranchFilterChange("left")}
                    >
                      Claim A
                    </button>
                  ) : null}
                  {clusterInspection.rightClaim ? (
                    <button
                      type="button"
                      className={
                        branchFilter === "right"
                          ? "button button--primary button--small"
                          : "button button--ghost button--small"
                      }
                      onClick={() => onBranchFilterChange("right")}
                    >
                      Claim B
                    </button>
                  ) : null}
                  {clusterInspection.unresolvedNodes.length ? (
                    <button
                      type="button"
                      className={
                        branchFilter === "unresolved"
                          ? "button button--primary button--small"
                          : "button button--ghost button--small"
                      }
                      onClick={() => onBranchFilterChange("unresolved")}
                    >
                      Unresolved
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {availableReviewSources.length > 1 ? (
              <label className="toolbar__select inspection-controls__select">
                <span className="toolbar__select-label">Source filter</span>
                <select
                  aria-label="Source filter"
                  value={sourceFilterId}
                  onChange={(event) => onSourceFilterChange(event.target.value)}
                >
                  {sourceFilterOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <p className="muted">
                The current view only has one source, so no source filter is available yet.
              </p>
            )}
          </div>
          <p className="muted">
            These controls narrow the inspector and can be saved with exports.
          </p>
        </div>
      </details>

      {clusterInspection ? (
        <details className="panel-card panel-card--disclosure panel-card--conflict node-inspector__secondary" open={!isDrawerVariant}>
          <summary className="panel-card__disclosure-summary">
            <div>
              <p className="eyebrow">Main conflict</p>
              <h2>{clusterInspection.cluster.title}</h2>
            </div>
            <div className="panel-card__chips">
              {clusterIndex >= 0 ? (
                <span className="pill pill--neutral">
                  conflict {clusterIndex + 1} / {graph.disagreementClusters.length}
                </span>
              ) : null}
              <span className="pill pill--neutral">
                {buildBranchFilterLabel(branchFilter)}
              </span>
              <span className="pill pill--accent">
                {Math.round(clusterInspection.cluster.score * 100)}% score
              </span>
            </div>
          </summary>
          <div className="panel-card__disclosure-body">
              <p>{buildConflictSummary(clusterInspection)}</p>

            <section
              className="panel-card__section panel-card__section--dense"
              role="region"
              aria-label="Branch comparison overview"
            >
              <div className="panel-card__header panel-card__header--compact">
                <div>
                  <p className="eyebrow">Compare sides</p>
                  <h2>Why the branches conflict</h2>
                </div>
                <div className="panel-card__chips">
                  {branchFilter !== "all" ? (
                    <span className="pill pill--accent">
                      Focused: {buildBranchFilterLabel(branchFilter)}
                    </span>
                  ) : null}
                  {sourceFilterId !== "all" ? (
                    <span className="pill pill--neutral">
                      Source filter: {activeSourceFilterLabel}
                    </span>
                  ) : null}
                </div>
              </div>
              <p className="muted">
                Compare the two sides first, then inspect evidence and open gaps below.
              </p>
              <div className="panel-card__overview-grid">
                {branchComparisonCards.map((card) => (
                  <article
                    key={card.id}
                    className="panel-card__summary-item"
                    aria-label={`${card.label} comparison summary`}
                  >
                    <div className="panel-card__related-row">
                      <div>
                        <p className="eyebrow">{card.label}</p>
                        <h3>{card.title}</h3>
                      </div>
                      {card.inspectNodeId ? (
                        <button
                          type="button"
                          className="button button--ghost button--small"
                          onClick={() => onSelectNode(card.inspectNodeId!)}
                          disabled={selectedNode?.id === card.inspectNodeId}
                        >
                          {selectedNode?.id === card.inspectNodeId ? "Inspecting" : "Inspect node"}
                        </button>
                      ) : null}
                    </div>
                    <p>{card.summary}</p>
                    <p className="muted">{card.detail}</p>
                    <div className="panel-card__chips">
                      {card.active ? <span className="pill pill--accent">Active view</span> : null}
                      <span className="pill pill--neutral">{card.scopeLabel}</span>
                      <span className="pill pill--neutral">
                        {formatCount(card.sourceCount, "source")}
                      </span>
                      <span className="pill pill--neutral">
                        {formatCount(card.snippetCount, "snippet")}
                      </span>
                    </div>
                  </article>
                ))}
              </div>
            </section>

          {(showLeftBranch || showRightBranch) ? (
            <section
              className="panel-card__section panel-card__section--dense"
              role="region"
              aria-label="Branch detail"
            >
              <div className="panel-card__header panel-card__header--compact">
                <div>
                  <p className="eyebrow">Branch detail</p>
                  <h2>Inspect each side</h2>
                </div>
              </div>
              <div className="panel-card__compare-grid">
                {showLeftBranch && clusterInspection.leftClaim ? (
                  <article
                    className="panel-card__compare-item"
                    role="region"
                    aria-label="Claim A branch"
                  >
                    <p className="eyebrow">Claim A</p>
                    <div className="panel-card__related-row">
                      <h3>{clusterInspection.leftClaim.title}</h3>
                      <button
                        type="button"
                        className="button button--ghost button--small"
                        onClick={() => onSelectNode(clusterInspection.leftClaim!.id)}
                        disabled={selectedNode?.id === clusterInspection.leftClaim!.id}
                      >
                        {selectedNode?.id === clusterInspection.leftClaim.id
                          ? "Inspecting"
                          : "Inspect node"}
                      </button>
                    </div>
                    <p>{clusterInspection.leftClaim.summary}</p>
                    {clusterInspection.leftContext.length ? (
                      <div className="panel-card__context-list">
                        {clusterInspection.leftContext.map((item) => (
                          <div
                            key={`${item.direction}:${item.relation}:${item.node.id}`}
                            className="panel-card__context-row"
                          >
                            <div>
                              <p className="panel-card__context-title">{item.node.title}</p>
                              <p className="muted">
                                {item.node.kind} - {relationLabel(item.direction, item.relation)}
                              </p>
                            </div>
                            <button
                              type="button"
                              className="button button--ghost button--small"
                              onClick={() => onSelectNode(item.node.id)}
                              disabled={selectedNode?.id === item.node.id}
                            >
                              {selectedNode?.id === item.node.id ? "Inspecting" : "Inspect"}
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="muted">No direct related nodes are attached to this side.</p>
                    )}
                    <SnippetList
                      snippets={filteredLeftSnippets}
                      sources={sources}
                      emptyMessage={buildEmptyFilterMessage(
                        "No direct snippets were preserved for this side.",
                        sourceFilterId
                      )}
                    />
                  </article>
                ) : null}

                {showRightBranch && clusterInspection.rightClaim ? (
                  <article
                    className="panel-card__compare-item"
                    role="region"
                    aria-label="Claim B branch"
                  >
                    <p className="eyebrow">Claim B</p>
                    <div className="panel-card__related-row">
                      <h3>{clusterInspection.rightClaim.title}</h3>
                      <button
                        type="button"
                        className="button button--ghost button--small"
                        onClick={() => onSelectNode(clusterInspection.rightClaim!.id)}
                        disabled={selectedNode?.id === clusterInspection.rightClaim!.id}
                      >
                        {selectedNode?.id === clusterInspection.rightClaim.id
                          ? "Inspecting"
                          : "Inspect node"}
                      </button>
                    </div>
                    <p>{clusterInspection.rightClaim.summary}</p>
                    {clusterInspection.rightContext.length ? (
                      <div className="panel-card__context-list">
                        {clusterInspection.rightContext.map((item) => (
                          <div
                            key={`${item.direction}:${item.relation}:${item.node.id}`}
                            className="panel-card__context-row"
                          >
                            <div>
                              <p className="panel-card__context-title">{item.node.title}</p>
                              <p className="muted">
                                {item.node.kind} - {relationLabel(item.direction, item.relation)}
                              </p>
                            </div>
                            <button
                              type="button"
                              className="button button--ghost button--small"
                              onClick={() => onSelectNode(item.node.id)}
                              disabled={selectedNode?.id === item.node.id}
                            >
                              {selectedNode?.id === item.node.id ? "Inspecting" : "Inspect"}
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="muted">No direct related nodes are attached to this side.</p>
                    )}
                    <SnippetList
                      snippets={filteredRightSnippets}
                      sources={sources}
                      emptyMessage={buildEmptyFilterMessage(
                        "No direct snippets were preserved for this side.",
                        sourceFilterId
                      )}
                    />
                  </article>
                ) : null}
              </div>
            </section>
          ) : null}

          {showUnresolvedBranch ? (
            <section
              className="panel-card__section panel-card__section--dense"
              role="region"
              aria-label="Conflict gaps"
            >
              <div className="panel-card__header panel-card__header--compact">
                <div>
                  <p className="eyebrow">Conflict gaps</p>
                  <h2>
                    {clusterInspection.unresolvedNodes.length
                      ? `${formatCount(clusterInspection.unresolvedNodes.length, "attached gap")}`
                      : "No direct gap nodes"}
                  </h2>
                </div>
                <div className="panel-card__chips">
                  <span className="pill pill--neutral">
                    {formatCount(filteredUnresolvedSources.length, "source")}
                  </span>
                  <span className="pill pill--neutral">
                    {formatCount(filteredUnresolvedSnippets.length, "snippet")}
                  </span>
                </div>
              </div>
              <p className="muted">
                {branchFilter === "unresolved"
                  ? "The inspector is narrowed to open gaps for this conflict."
                  : "These gap nodes still qualify the disagreement and keep the current conclusion open."}
              </p>
              {clusterInspection.unresolvedNodes.length ? (
                <SnippetList
                  snippets={filteredUnresolvedSnippets}
                  sources={sources}
                  emptyMessage={buildEmptyFilterMessage(
                    "No gap snippets were preserved for this disagreement cluster.",
                    sourceFilterId
                  )}
                />
              ) : (
                <p className="muted">This conflict currently has no direct gap node attached to it.</p>
              )}
            </section>
          ) : null}

          <div className="panel-card__section">
            <div className="panel-card__header panel-card__header--compact">
              <div>
                <p className="eyebrow">Conflict sources</p>
                <h2>Visible evidence</h2>
              </div>
              <div className="panel-card__chips">
                <span className="pill pill--neutral">
                  {filteredClusterSources.length} source{filteredClusterSources.length === 1 ? "" : "s"}
                </span>
                <span className="pill pill--neutral">
                  {filteredClusterSnippets.length} snippet{filteredClusterSnippets.length === 1 ? "" : "s"}
                </span>
              </div>
            </div>
            <div className="source-list">
              {filteredClusterSources.length ? (
                filteredClusterSources.map((source) => (
                  <SourceCard
                    key={source.id}
                    source={source}
                    snippets={filteredClusterSnippets.filter(
                      (snippet) => snippet.sourceId === source.id
                    )}
                    snippetCount={clusterSnippetCountsBySourceId.get(source.id) ?? 0}
                  />
                ))
              ) : (
                <p className="muted">
                  No conflict sources remain after the current source filter.
                </p>
              )}
            </div>
          </div>
          </div>
        </details>
      ) : null}
    </div>
  );
}
