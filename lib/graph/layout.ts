import dagre from "dagre";
import type { Edge, Node } from "@xyflow/react";
import type { NodeKind } from "@/types/claimgraph";

const graphlib = new dagre.graphlib.Graph();

graphlib.setDefaultEdgeLabel(() => ({}));

const NODE_SIZE_BY_KIND: Record<NodeKind, { width: number; height: number }> = {
  question: { width: 360, height: 172 },
  claim: { width: 292, height: 166 },
  counterclaim: { width: 292, height: 166 },
  evidence: { width: 260, height: 144 },
  gap: { width: 272, height: 154 }
};
const ROW_ALIGNMENT_THRESHOLD = 112;
const ROW_NODE_GAP = 36;

type PositionedNode<T extends { kind: NodeKind }> = Node<T> & {
  width: number;
  height: number;
  position: {
    x: number;
    y: number;
  };
};

function getNodeCenterX<T extends { kind: NodeKind }>(node: PositionedNode<T>) {
  return node.position.x + node.width / 2;
}

function getNodeCenterY<T extends { kind: NodeKind }>(node: PositionedNode<T>) {
  return node.position.y + node.height / 2;
}

function groupNodesIntoRows<T extends { kind: NodeKind }>(nodes: PositionedNode<T>[]) {
  const sortedNodes = [...nodes].sort(
    (left, right) =>
      getNodeCenterY(left) - getNodeCenterY(right) ||
      left.position.x - right.position.x
  );
  const rows: PositionedNode<T>[][] = [];

  for (const node of sortedNodes) {
    const currentRow = rows.at(-1);

    if (!currentRow) {
      rows.push([node]);
      continue;
    }

    const rowCenterY =
      currentRow.reduce((sum, rowNode) => sum + getNodeCenterY(rowNode), 0) /
      currentRow.length;

    if (Math.abs(getNodeCenterY(node) - rowCenterY) <= ROW_ALIGNMENT_THRESHOLD) {
      currentRow.push(node);
      continue;
    }

    rows.push([node]);
  }

  return rows;
}

function rowNeedsHorizontalSpread<T extends { kind: NodeKind }>(row: PositionedNode<T>[]) {
  const orderedNodes = [...row].sort((left, right) => left.position.x - right.position.x);

  for (let index = 1; index < orderedNodes.length; index += 1) {
    const previousNode = orderedNodes[index - 1];
    const currentNode = orderedNodes[index];

    if (currentNode.position.x < previousNode.position.x + previousNode.width + ROW_NODE_GAP) {
      return true;
    }
  }

  return false;
}

function spreadOverlappingRows<T extends { kind: NodeKind }>(nodes: PositionedNode<T>[]) {
  const repositionedNodes = new Map(nodes.map((node) => [node.id, node]));

  for (const row of groupNodesIntoRows(nodes)) {
    if (row.length < 2 || !rowNeedsHorizontalSpread(row)) {
      continue;
    }

    const orderedNodes = [...row].sort((left, right) => left.position.x - right.position.x);
    const totalWidth =
      orderedNodes.reduce((sum, node) => sum + node.width, 0) +
      ROW_NODE_GAP * (orderedNodes.length - 1);
    const averageCenterX =
      orderedNodes.reduce((sum, node) => sum + getNodeCenterX(node), 0) / orderedNodes.length;
    let nextX = averageCenterX - totalWidth / 2;

    for (const node of orderedNodes) {
      repositionedNodes.set(node.id, {
        ...node,
        position: {
          ...node.position,
          x: nextX
        }
      });
      nextX += node.width + ROW_NODE_GAP;
    }
  }

  return nodes.map((node) => repositionedNodes.get(node.id) ?? node);
}

export function layoutFlowGraph<T extends { kind: NodeKind }>(
  nodes: Array<Node<T>>,
  edges: Edge[]
) {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: "TB",
    ranksep: 104,
    nodesep: 76,
    edgesep: 42,
    marginx: 40,
    marginy: 48
  });

  for (const node of nodes) {
    const size = NODE_SIZE_BY_KIND[node.data.kind as NodeKind];
    g.setNode(node.id, size);
  }

  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  const positionedNodes = nodes.map((node) => {
    const size = NODE_SIZE_BY_KIND[node.data.kind as NodeKind];
    const position = g.node(node.id);

    return {
      ...node,
      width: size.width,
      height: size.height,
      position: {
        x: position.x - size.width / 2,
        y: position.y - size.height / 2
      }
    };
  });

  return spreadOverlappingRows(positionedNodes);
}
