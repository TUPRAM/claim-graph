import { getPrimaryCluster } from "@/lib/graph/score";
import type {
  ClaimGraph,
  DisagreementCluster,
  EdgeRelation,
  GraphNode,
  Snippet,
  Source
} from "@/types/claimgraph";

export interface RelatedNodeSummary {
  direction: "incoming" | "outgoing";
  relation: EdgeRelation;
  node: GraphNode;
}

export interface ClusterInspection {
  cluster: DisagreementCluster;
  leftClaim: GraphNode | null;
  rightClaim: GraphNode | null;
  sources: Source[];
  snippets: Snippet[];
  leftSnippets: Snippet[];
  rightSnippets: Snippet[];
  leftContext: RelatedNodeSummary[];
  rightContext: RelatedNodeSummary[];
  unresolvedNodes: GraphNode[];
  selectedFrame: "left" | "right" | "unresolved" | null;
}

function buildNodeMap(graph: ClaimGraph) {
  return new Map(graph.nodes.map((node) => [node.id, node]));
}

function byIds<T extends { id: string }>(values: T[], ids: string[]) {
  const idSet = new Set(ids);
  return values.filter((value) => idSet.has(value.id));
}

export function getNodeProvenance(input: {
  node: GraphNode | null;
  sources: Source[];
  snippets: Snippet[];
}) {
  if (!input.node) {
    return {
      sources: [] as Source[],
      snippets: [] as Snippet[]
    };
  }

  return {
    sources: byIds(input.sources, input.node.sourceIds),
    snippets: byIds(input.snippets, input.node.snippetIds)
  };
}

export function getRelatedNodes(graph: ClaimGraph, nodeId: string | null) {
  if (!nodeId) {
    return [] as RelatedNodeSummary[];
  }

  const nodeById = buildNodeMap(graph);
  const summaries: RelatedNodeSummary[] = [];
  const seen = new Set<string>();

  for (const edge of graph.edges) {
    if (edge.from === nodeId && nodeById.has(edge.to)) {
      const key = `outgoing:${edge.relation}:${edge.to}`;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      summaries.push({
        direction: "outgoing",
        relation: edge.relation,
        node: nodeById.get(edge.to)!
      });
    }

    if (edge.to === nodeId && nodeById.has(edge.from)) {
      const key = `incoming:${edge.relation}:${edge.from}`;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      summaries.push({
        direction: "incoming",
        relation: edge.relation,
        node: nodeById.get(edge.from)!
      });
    }
  }

  return summaries.sort(
    (left, right) =>
      left.node.kind.localeCompare(right.node.kind) ||
      left.node.title.localeCompare(right.node.title)
  );
}

function sortContextNodes(left: RelatedNodeSummary, right: RelatedNodeSummary) {
  const priority = {
    gap: 0,
    evidence: 1,
    claim: 2,
    counterclaim: 3,
    question: 4
  } satisfies Record<GraphNode["kind"], number>;

  return (
    priority[left.node.kind] - priority[right.node.kind] ||
    left.node.title.localeCompare(right.node.title)
  );
}

function getRelatedClusterContext(
  graph: ClaimGraph,
  nodeId: string,
  excludedNodeIds: string[]
) {
  const excluded = new Set(excludedNodeIds);

  return getRelatedNodes(graph, nodeId)
    .filter((item) => !excluded.has(item.node.id) && item.node.kind !== "question")
    .sort(sortContextNodes);
}

function findSelectionCluster(graph: ClaimGraph, selectedNodeId: string | null) {
  if (!selectedNodeId) {
    return null;
  }

  const directCluster = graph.disagreementClusters.find((cluster) =>
    cluster.claimIds.includes(selectedNodeId)
  );

  if (directCluster) {
    return directCluster;
  }

  const relatedNodeIds = new Set(
    getRelatedNodes(graph, selectedNodeId).map((item) => item.node.id)
  );

  return (
    [...graph.disagreementClusters]
      .sort((left, right) => right.score - left.score)
      .find((cluster) =>
        cluster.claimIds.some((claimId) => relatedNodeIds.has(claimId))
      ) ?? null
  );
}

export function getInspectionCluster(input: {
  graph: ClaimGraph;
  selectedNodeId: string | null;
  focusClusterId?: string | null;
  strongestOnly: boolean;
  sources: Source[];
  snippets: Snippet[];
}) {
  const nodeById = buildNodeMap(input.graph);
  const focusedCluster = input.focusClusterId
    ? input.graph.disagreementClusters.find((item) => item.id === input.focusClusterId) ?? null
    : null;
  const fallbackCluster = input.strongestOnly
    ? getPrimaryCluster(input.graph)
    : findSelectionCluster(input.graph, input.selectedNodeId);
  const cluster = focusedCluster ?? fallbackCluster;

  if (!cluster) {
    return null;
  }

  const leftClaim = nodeById.get(cluster.claimIds[0]) ?? null;
  const rightClaim = nodeById.get(cluster.claimIds[1]) ?? null;
  const sources = byIds(input.sources, cluster.sourceIds);
  const snippets = byIds(input.snippets, cluster.snippetIds);
  const leftSnippets = leftClaim ? byIds(input.snippets, leftClaim.snippetIds).slice(0, 2) : [];
  const rightSnippets = rightClaim ? byIds(input.snippets, rightClaim.snippetIds).slice(0, 2) : [];
  const leftContext = leftClaim
    ? getRelatedClusterContext(input.graph, leftClaim.id, [rightClaim?.id ?? ""])
    : [];
  const rightContext = rightClaim
    ? getRelatedClusterContext(input.graph, rightClaim.id, [leftClaim?.id ?? ""])
    : [];
  const unresolvedNodeMap = new Map<string, GraphNode>();

  [...leftContext, ...rightContext].forEach((item) => {
    if (item.node.kind === "gap") {
      unresolvedNodeMap.set(item.node.id, item.node);
    }
  });

  const unresolvedNodes = [...unresolvedNodeMap.values()].sort((left, right) =>
    left.title.localeCompare(right.title)
  );
  const leftContextIds = new Set(leftContext.map((item) => item.node.id));
  const rightContextIds = new Set(rightContext.map((item) => item.node.id));
  const unresolvedIds = new Set(unresolvedNodes.map((node) => node.id));
  const selectedFrame =
    input.selectedNodeId && unresolvedIds.has(input.selectedNodeId)
      ? "unresolved"
      : input.selectedNodeId &&
          (input.selectedNodeId === leftClaim?.id || leftContextIds.has(input.selectedNodeId))
        ? "left"
        : input.selectedNodeId &&
            (input.selectedNodeId === rightClaim?.id || rightContextIds.has(input.selectedNodeId))
          ? "right"
          : null;

  return {
    cluster,
    leftClaim,
    rightClaim,
    sources,
    snippets,
    leftSnippets,
    rightSnippets,
    leftContext,
    rightContext,
    unresolvedNodes,
    selectedFrame
  } satisfies ClusterInspection;
}
