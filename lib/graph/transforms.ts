import { Edge, MarkerType, Node, Position } from "@xyflow/react";
import { getPrimaryCluster } from "@/lib/graph/score";
import { layoutFlowGraph } from "@/lib/graph/layout";
import type {
  ClaimGraph,
  DisagreementCluster,
  EdgeRelation,
  GraphNode,
  NodeKind,
  Stance
} from "@/types/claimgraph";

export interface FlowNodeData extends Record<string, unknown> {
  kind: NodeKind;
  title: string;
  summary: string;
  stance?: Stance;
  confidence?: number;
  sourceCount: number;
  sourceIds: string[];
  snippetIds: string[];
  metadata?: Record<string, unknown>;
}

export type FlowNode = Node<FlowNodeData, NodeKind | undefined>;

const NODE_LAYOUT_ORDER: Record<NodeKind, number> = {
  question: 0,
  claim: 1,
  counterclaim: 2,
  gap: 3,
  evidence: 4
};

function compareNodesForLayout(left: GraphNode, right: GraphNode) {
  return (
    NODE_LAYOUT_ORDER[left.kind] - NODE_LAYOUT_ORDER[right.kind] ||
    left.title.localeCompare(right.title)
  );
}

function buildNodeMap(graph: ClaimGraph) {
  return new Map(graph.nodes.map((node) => [node.id, node]));
}

function buildAdjacentNodeIds(graph: ClaimGraph) {
  const adjacent = new Map<string, Set<string>>();

  function ensure(id: string) {
    if (!adjacent.has(id)) {
      adjacent.set(id, new Set());
    }

    return adjacent.get(id)!;
  }

  graph.nodes.forEach((node) => {
    ensure(node.id);
  });

  graph.edges.forEach((edge) => {
    ensure(edge.from).add(edge.to);
    ensure(edge.to).add(edge.from);
  });

  return adjacent;
}

function getQuestionNodeId(graph: ClaimGraph) {
  return graph.nodes.find((node) => node.kind === "question")?.id ?? null;
}

function intersectSets(left: Set<string>, right: Set<string>) {
  const intersection = new Set<string>();

  for (const id of left) {
    if (right.has(id)) {
      intersection.add(id);
    }
  }

  return intersection;
}

function getCluster(graph: ClaimGraph, clusterId?: string | null) {
  if (!clusterId) {
    return null;
  }

  return graph.disagreementClusters.find((cluster) => cluster.id === clusterId) ?? null;
}

function collectEvidenceForVisibleBranches(
  graph: ClaimGraph,
  visibleNodeIds: Set<string>
) {
  const nodeById = buildNodeMap(graph);
  const nextVisibleNodeIds = new Set(visibleNodeIds);

  graph.edges.forEach((edge) => {
    const sourceNode = nodeById.get(edge.from);
    const targetNode = nodeById.get(edge.to);

    if (!sourceNode || !targetNode) {
      return;
    }

    if (
      sourceNode.kind === "evidence" &&
      visibleNodeIds.has(edge.to) &&
      targetNode.kind !== "question"
    ) {
      nextVisibleNodeIds.add(sourceNode.id);
      return;
    }

    if (
      targetNode.kind === "evidence" &&
      visibleNodeIds.has(edge.from) &&
      sourceNode.kind !== "question"
    ) {
      nextVisibleNodeIds.add(targetNode.id);
    }
  });

  return nextVisibleNodeIds;
}

function relationLabel(relation: EdgeRelation) {
  switch (relation) {
    case "qualifies":
      return "qualifies";
    case "depends_on":
      return "depends on";
    default:
      return undefined;
  }
}

function relationStyle(relation: EdgeRelation, strength: number) {
  const baseWidth = Math.max(1.4, Math.round(strength * 3));
  switch (relation) {
    case "supports":
      return { stroke: "var(--color-support)", strokeWidth: baseWidth };
    case "refutes":
      return { stroke: "var(--color-refute)", strokeWidth: baseWidth };
    case "qualifies":
      return { stroke: "var(--color-qualify)", strokeDasharray: "6 4", strokeWidth: baseWidth };
    case "depends_on":
      return { stroke: "var(--color-gap)", strokeDasharray: "2 5", strokeWidth: baseWidth };
  }
}

export function buildFlowGraph(graph: ClaimGraph) {
  const edges: Edge[] = graph.edges.map((edge) => {
    const label = relationLabel(edge.relation);

    return {
      id: edge.id,
      source: edge.from,
      target: edge.to,
      type: "smoothstep",
      ...(label ? { label } : {}),
      animated: false,
      markerEnd: { type: MarkerType.ArrowClosed },
      style: relationStyle(edge.relation, edge.strength),
      pathOptions: {
        borderRadius: 18,
        offset: 22
      },
      ...(label
        ? {
            labelStyle: {
              fill: "var(--color-muted-strong)",
              fontSize: 10,
              fontWeight: 700
            },
            labelBgStyle: {
              fill: "rgba(255, 255, 255, 0.96)",
              fillOpacity: 0.96
            }
          }
        : {})
    };
  });

  const rawNodes: FlowNode[] = [...graph.nodes]
    .sort(compareNodesForLayout)
    .map((node) => ({
    id: node.id,
    type: node.kind,
    position: { x: 0, y: 0 },
    data: {
      kind: node.kind,
      title: node.title,
      summary: node.summary,
      stance: node.stance,
      confidence: node.confidence,
      sourceCount: node.sourceIds.length,
      sourceIds: node.sourceIds,
      snippetIds: node.snippetIds,
      metadata: node.metadata
    },
    ariaLabel: `${node.kind}: ${node.title}`,
    sourcePosition: Position.Bottom,
    targetPosition: Position.Top,
    draggable: true,
    selectable: true
  }));

  return {
    nodes: layoutFlowGraph(rawNodes, edges),
    edges
  };
}

export function collectFocusNodeIds(graph: ClaimGraph, clusterId?: string | null) {
  const cluster = getCluster(graph, clusterId);

  if (!cluster) {
    return null;
  }

  const questionNodeId = graph.nodes.find((node) => node.kind === "question")?.id;
  const focus = new Set<string>([
    ...(questionNodeId ? [questionNodeId] : []),
    ...cluster.claimIds
  ]);

  for (const edge of graph.edges) {
    if (cluster.claimIds.includes(edge.from) || cluster.claimIds.includes(edge.to)) {
      focus.add(edge.from);
      focus.add(edge.to);
    }
  }

  return focus;
}

export function sortDisagreementClusters(graph: ClaimGraph) {
  if (!graph.disagreementClusters.length) {
    return [] as DisagreementCluster[];
  }

  const primaryCluster = getPrimaryCluster(graph);

  return [...graph.disagreementClusters].sort((left, right) => {
    if (primaryCluster) {
      if (left.id === primaryCluster.id && right.id !== primaryCluster.id) {
        return -1;
      }

      if (right.id === primaryCluster.id && left.id !== primaryCluster.id) {
        return 1;
      }
    }

    return right.score - left.score || left.title.localeCompare(right.title);
  });
}

export function collectUnresolvedNodeIds(
  graph: ClaimGraph,
  clusterId?: string | null
) {
  const questionNodeId = getQuestionNodeId(graph);
  const nodeById = buildNodeMap(graph);
  const adjacentNodeIds = buildAdjacentNodeIds(graph);
  const cluster = getCluster(graph, clusterId);
  const gapNodes = graph.nodes.filter((node) => node.kind === "gap");

  if (!gapNodes.length) {
    if (!cluster && !questionNodeId) {
      return null;
    }

    return new Set<string>([
      ...(questionNodeId ? [questionNodeId] : []),
      ...(cluster?.claimIds ?? [])
    ]);
  }

  const relevantGapIds = gapNodes
    .filter((gapNode) => {
      if (!cluster) {
        return true;
      }

      const nearbyNodeIds = adjacentNodeIds.get(gapNode.id) ?? new Set<string>();

      return cluster.claimIds.some((claimId) => nearbyNodeIds.has(claimId));
    })
    .map((gapNode) => gapNode.id);

  const visibleNodeIds = new Set<string>([
    ...(questionNodeId ? [questionNodeId] : []),
    ...(cluster?.claimIds ?? []),
    ...relevantGapIds
  ]);

  relevantGapIds.forEach((gapId) => {
    (adjacentNodeIds.get(gapId) ?? []).forEach((neighborId) => {
      visibleNodeIds.add(neighborId);
    });
  });

  return collectEvidenceForVisibleBranches(graph, new Set(
    [...visibleNodeIds].filter((nodeId) => nodeById.has(nodeId))
  ));
}

export function collectVisibleNodeIds(input: {
  graph: ClaimGraph;
  hiddenKinds: NodeKind[];
  strongestOnly: boolean;
  focusClusterId?: string | null;
  unresolvedOnly: boolean;
}) {
  const baseVisibleNodeIds = new Set(
    input.graph.nodes
      .filter(
        (node) =>
          node.kind === "question" || !input.hiddenKinds.includes(node.kind)
      )
      .map((node) => node.id)
  );

  if (!input.unresolvedOnly) {
    return baseVisibleNodeIds;
  }

  const unresolvedNodeIds = collectUnresolvedNodeIds(
    input.graph,
    input.strongestOnly ? input.focusClusterId : null
  );

  if (!unresolvedNodeIds) {
    return baseVisibleNodeIds;
  }

  return intersectSets(baseVisibleNodeIds, unresolvedNodeIds);
}

export function collectSelectionNodeIds(input: {
  graph: ClaimGraph;
  visibleNodeIds: Set<string>;
  strongestOnly: boolean;
  focusClusterId?: string | null;
}) {
  if (!input.strongestOnly) {
    return new Set(input.visibleNodeIds);
  }

  const focusNodeIds = collectFocusNodeIds(input.graph, input.focusClusterId);

  if (!focusNodeIds) {
    return new Set(input.visibleNodeIds);
  }

  return intersectSets(input.visibleNodeIds, focusNodeIds);
}

export function collectViewportNodeIds(input: {
  graph: ClaimGraph;
  visibleNodeIds: Set<string>;
  strongestOnly: boolean;
  focusClusterId?: string | null;
  unresolvedOnly: boolean;
}) {
  if (input.unresolvedOnly) {
    return input.visibleNodeIds.size ? new Set(input.visibleNodeIds) : null;
  }

  if (!input.strongestOnly) {
    return null;
  }

  const cluster = getCluster(input.graph, input.focusClusterId);
  const focusNodeIds = collectFocusNodeIds(input.graph, input.focusClusterId);

  if (!focusNodeIds || !cluster) {
    return null;
  }

  const nodeById = buildNodeMap(input.graph);
  const questionNodeId = getQuestionNodeId(input.graph);
  const clusterClaimIds = new Set(cluster.claimIds);
  const viewportNodeIds = new Set<string>([
    ...(questionNodeId ? [questionNodeId] : []),
    ...cluster.claimIds
  ]);
  const evidenceByClaim = new Map<string, string[]>();

  for (const edge of input.graph.edges) {
    const sourceNode = nodeById.get(edge.from);
    const targetNode = nodeById.get(edge.to);

    if (!sourceNode || !targetNode) {
      continue;
    }

    const claimId = clusterClaimIds.has(edge.from)
      ? edge.from
      : clusterClaimIds.has(edge.to)
        ? edge.to
        : null;

    if (!claimId) {
      continue;
    }

    const neighbor = edge.from === claimId ? targetNode : sourceNode;

    if (neighbor.kind === "evidence") {
      const evidenceIds = evidenceByClaim.get(claimId) ?? [];
      evidenceIds.push(neighbor.id);
      evidenceByClaim.set(claimId, evidenceIds);
      continue;
    }

    if (neighbor.kind !== "question") {
      viewportNodeIds.add(neighbor.id);
    }
  }

  for (const evidenceIds of evidenceByClaim.values()) {
    const firstVisibleEvidenceId = evidenceIds.find((nodeId) =>
      input.visibleNodeIds.has(nodeId)
    );

    if (firstVisibleEvidenceId) {
      viewportNodeIds.add(firstVisibleEvidenceId);
    }
  }

  const focusedViewportNodeIds = intersectSets(input.visibleNodeIds, viewportNodeIds);

  if (focusedViewportNodeIds.size >= 2) {
    return focusedViewportNodeIds;
  }

  return intersectSets(input.visibleNodeIds, focusNodeIds);
}

export function pickSelectedNodeId(input: {
  graph: ClaimGraph;
  currentSelectedNodeId: string | null;
  selectionNodeIds: Set<string>;
  strongestOnly: boolean;
  focusClusterId?: string | null;
  unresolvedOnly: boolean;
}) {
  const nodeById = buildNodeMap(input.graph);
  const cluster = getCluster(input.graph, input.focusClusterId);
  const currentNode = input.currentSelectedNodeId
    ? nodeById.get(input.currentSelectedNodeId) ?? null
    : null;
  const selectedGapNodeIds = [...input.selectionNodeIds].filter(
    (nodeId) => nodeById.get(nodeId)?.kind === "gap"
  );
  const selectedClusterClaimIds = (cluster?.claimIds ?? []).filter((nodeId) =>
    input.selectionNodeIds.has(nodeId)
  );
  const nonQuestionSelectionNodeIds = [...input.selectionNodeIds].filter(
    (nodeId) => nodeById.get(nodeId)?.kind !== "question"
  );
  const questionNodeId = getQuestionNodeId(input.graph);

  if (input.unresolvedOnly && selectedGapNodeIds.length) {
    if (currentNode?.kind === "gap" && input.selectionNodeIds.has(currentNode.id)) {
      return currentNode.id;
    }

    return selectedGapNodeIds[0] ?? null;
  }

  if (currentNode && input.selectionNodeIds.has(currentNode.id)) {
    return currentNode.id;
  }

  if (input.strongestOnly && selectedClusterClaimIds.length) {
    return selectedClusterClaimIds[0] ?? null;
  }

  if (nonQuestionSelectionNodeIds.length) {
    return nonQuestionSelectionNodeIds[0] ?? null;
  }

  if (questionNodeId && input.selectionNodeIds.has(questionNodeId)) {
    return questionNodeId;
  }

  return [...input.selectionNodeIds][0] ?? null;
}
