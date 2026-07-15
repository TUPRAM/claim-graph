"use client";

import "@xyflow/react/dist/style.css";

import { useEffect, useMemo, useRef, useState, type Ref } from "react";
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type NodeChange,
  type NodeTypes,
  type ReactFlowInstance
} from "@xyflow/react";
import { buildFlowGraph, type FlowNode } from "@/lib/graph/transforms";
import type { ClaimGraph } from "@/types/claimgraph";
import { ClaimNode } from "@/components/graph/nodes/ClaimNode";
import { CounterclaimNode } from "@/components/graph/nodes/CounterclaimNode";
import { EvidenceNode } from "@/components/graph/nodes/EvidenceNode";
import { GapNode } from "@/components/graph/nodes/GapNode";
import { QuestionNode } from "@/components/graph/nodes/QuestionNode";

const nodeTypes = {
  question: QuestionNode,
  claim: ClaimNode,
  counterclaim: CounterclaimNode,
  evidence: EvidenceNode,
  gap: GapNode
} satisfies NodeTypes;

const NODE_CLICK_DISTANCE_PX = 8;
const NODE_DRAG_THRESHOLD_PX = 4;
const COMPACT_VIEW_QUERY = "(max-width: 640px)";
const CONSTRAINED_VIEW_QUERY = "(max-width: 1100px)";
const COMPACT_VIEW_NEIGHBOR_LIMIT = 2;
const COMPACT_VIEW_NEIGHBOR_DISTANCE = 560;
const DESKTOP_FOCUS_PADDING = 0.1;
const COMPACT_FOCUS_PADDING = 0.2;
const DESKTOP_FOCUS_MAX_ZOOM = 1.16;
const COMPACT_FOCUS_MAX_ZOOM = 1.04;
const DESKTOP_SELECTION_ZOOM = 1;
const DIMMED_NODE_OPACITY = 0.72;
const DIMMED_EDGE_OPACITY = 0.28;

function getNodeCenter(node: FlowNode) {
  return {
    x: node.position.x + (node.width ?? 0) / 2,
    y: node.position.y + (node.height ?? 0) / 2
  };
}

function matchesMediaQuery(query: string) {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(query).matches
  );
}

function getNodeDistance(left: FlowNode, right: FlowNode) {
  const leftCenter = getNodeCenter(left);
  const rightCenter = getNodeCenter(right);

  return Math.hypot(leftCenter.x - rightCenter.x, leftCenter.y - rightCenter.y);
}

function sortNodesByDistance(nodes: FlowNode[], anchor: FlowNode) {
  const anchorCenter = getNodeCenter(anchor);

  return [...nodes].sort((left, right) => {
    const leftCenter = getNodeCenter(left);
    const rightCenter = getNodeCenter(right);
    const leftDistance = Math.hypot(leftCenter.x - anchorCenter.x, leftCenter.y - anchorCenter.y);
    const rightDistance = Math.hypot(rightCenter.x - anchorCenter.x, rightCenter.y - anchorCenter.y);

    return leftDistance - rightDistance;
  });
}

function chooseCompactViewportNodes(
  viewportNodes: FlowNode[],
  selectedNodeId: string | null,
  includeQuestion = false,
  includePeer = true
) {
  if (viewportNodes.length <= 2) {
    return viewportNodes;
  }

  const selectedNode =
    selectedNodeId ? viewportNodes.find((node) => node.id === selectedNodeId) ?? null : null;
  const anchorNode =
    selectedNode?.data.kind !== "question"
      ? selectedNode
      : viewportNodes.find((node) => node.data.kind === "claim" || node.data.kind === "counterclaim") ??
        viewportNodes.find((node) => node.data.kind === "gap") ??
        selectedNode ??
        viewportNodes[0];

  if (!anchorNode) {
    return viewportNodes;
  }

  const preferredPeers = sortNodesByDistance(
    viewportNodes.filter(
      (node) =>
        node.id !== anchorNode.id &&
        (node.data.kind === "claim" || node.data.kind === "counterclaim")
    ),
    anchorNode
  );
  const fallbackPeers = sortNodesByDistance(
    viewportNodes.filter(
      (node) =>
        node.id !== anchorNode.id &&
        node.data.kind !== "question" &&
        !preferredPeers.some((peer) => peer.id === node.id)
    ),
    anchorNode
  );
  const peerCandidate = preferredPeers[0] ?? fallbackPeers[0] ?? null;
  const peerNode =
    includePeer &&
    peerCandidate &&
    getNodeDistance(peerCandidate, anchorNode) <= COMPACT_VIEW_NEIGHBOR_DISTANCE
      ? peerCandidate
      : null;
  const questionNode = includeQuestion
    ? viewportNodes.find((node) => node.data.kind === "question") ?? null
    : null;
  const uniqueFitNodes = new Map<string, FlowNode>();

  for (const node of [anchorNode, peerNode, questionNode]) {
    if (node) {
      uniqueFitNodes.set(node.id, node);
    }
  }

  const fitNodes = [...uniqueFitNodes.values()];

  return fitNodes.length ? fitNodes : [anchorNode];
}

export interface ClaimGraphCanvasProps {
  graph: ClaimGraph;
  selectedNodeId: string | null;
  focusNodeIds: Set<string> | null;
  visibleNodeIds: Set<string> | null;
  viewportNodeIds: Set<string> | null;
  viewportKey?: string;
  focusClusterId?: string | null;
  selectionFitToken?: number;
  resetToken: number;
  fitPadding?: number;
  showMiniMap?: boolean;
  captureRef?: Ref<HTMLDivElement>;
  onNodeSelect: (nodeId: string) => void;
}

export function ClaimGraphCanvas({
  graph,
  selectedNodeId,
  focusNodeIds,
  visibleNodeIds,
  viewportNodeIds,
  viewportKey,
  focusClusterId,
  selectionFitToken = 0,
  resetToken,
  fitPadding = 0.18,
  showMiniMap = true,
  captureRef,
  onNodeSelect
}: ClaimGraphCanvasProps) {
  const [instance, setInstance] = useState<ReactFlowInstance<FlowNode> | null>(null);
  const [displayNodes, setDisplayNodes] = useState<FlowNode[]>([]);
  const [isCompactView, setIsCompactView] = useState(
    () => matchesMediaQuery(COMPACT_VIEW_QUERY)
  );
  const [isConstrainedView, setIsConstrainedView] = useState(
    () => matchesMediaQuery(CONSTRAINED_VIEW_QUERY)
  );
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const handledSelectionFitTokenRef = useRef(0);
  const minimapNodeColor = (node: FlowNode) => {
    switch (node.data.kind) {
      case "claim":
        return "rgba(52, 211, 153, 0.92)";
      case "counterclaim":
        return "rgba(251, 113, 133, 0.92)";
      case "evidence":
        return "rgba(192, 132, 252, 0.92)";
      case "gap":
        return "rgba(96, 165, 250, 0.92)";
      default:
        return "rgba(148, 163, 184, 0.92)";
    }
  };

  const renderedGraph = useMemo(() => {
    const { nodes, edges } = buildFlowGraph(graph);
    const filteredNodes = nodes.filter(
      (node) => !visibleNodeIds || visibleNodeIds.has(node.id)
    );
    const visibleIds = new Set(filteredNodes.map((node) => node.id));

    const filteredEdges = edges.filter(
      (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)
    );

    const highlightedEdgeIds =
      focusNodeIds == null
        ? null
        : new Set(
            filteredEdges
              .filter((edge) => focusNodeIds.has(edge.source) && focusNodeIds.has(edge.target))
              .map((edge) => edge.id)
          );

    return {
      nodes: filteredNodes.map((node) => {
        const dimmed = focusNodeIds ? !focusNodeIds.has(node.id) : false;
        return {
          ...node,
          selected: node.id === selectedNodeId,
          zIndex: node.id === selectedNodeId ? 3 : dimmed ? 0 : 2,
          style: {
            ...node.style,
            opacity: dimmed ? DIMMED_NODE_OPACITY : 1,
            transition: "opacity 140ms ease"
          }
        };
      }),
      edges: filteredEdges.map((edge) => {
        const dimmed = focusNodeIds ? !highlightedEdgeIds?.has(edge.id) : false;
        const relatedToSelection = Boolean(
          selectedNodeId && (edge.source === selectedNodeId || edge.target === selectedNodeId)
        );
        const labelActive = hoveredEdgeId === edge.id;
        const edgeClasses = [
          "claim-flow-edge",
          highlightedEdgeIds?.has(edge.id) ? "claim-flow-edge--focused" : null,
          relatedToSelection ? "claim-flow-edge--related" : null,
          labelActive ? "claim-flow-edge--label-active" : null,
          dimmed ? "claim-flow-edge--dimmed" : null
        ].filter(Boolean).join(" ");

        return {
          ...edge,
          className: edgeClasses,
          animated: Boolean(highlightedEdgeIds?.has(edge.id)),
          style: {
            ...(edge.style ?? {}),
            opacity: dimmed ? DIMMED_EDGE_OPACITY : 1
          }
        } satisfies Edge;
      })
    };
  }, [focusNodeIds, graph, hoveredEdgeId, selectedNodeId, visibleNodeIds]);

  useEffect(() => {
    setDisplayNodes((currentNodes) => {
      const currentPositionsById = new Map(
        currentNodes.map((node) => [node.id, node.position])
      );

      return renderedGraph.nodes.map((node) => ({
        ...node,
        position: currentPositionsById.get(node.id) ?? node.position
      }));
    });
  }, [renderedGraph.nodes]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }

    const compactMediaQuery = window.matchMedia(COMPACT_VIEW_QUERY);
    const constrainedMediaQuery = window.matchMedia(CONSTRAINED_VIEW_QUERY);

    function updateViewportMode() {
      setIsCompactView(compactMediaQuery.matches);
      setIsConstrainedView(constrainedMediaQuery.matches);
    }

    updateViewportMode();
    compactMediaQuery.addEventListener("change", updateViewportMode);
    constrainedMediaQuery.addEventListener("change", updateViewportMode);

    return () => {
      compactMediaQuery.removeEventListener("change", updateViewportMode);
      constrainedMediaQuery.removeEventListener("change", updateViewportMode);
    };
  }, []);

  useEffect(() => {
    if (!instance) {
      return;
    }

    if (selectedNodeId && selectionFitToken > handledSelectionFitTokenRef.current) {
      const selectedNode = displayNodes.find((node) => node.id === selectedNodeId);

      if (selectedNode) {
        const connectedNodeIds = new Set<string>();

        for (const edge of renderedGraph.edges) {
          if (edge.source === selectedNodeId) {
            connectedNodeIds.add(edge.target);
          }

          if (edge.target === selectedNodeId) {
            connectedNodeIds.add(edge.source);
          }
        }

        const selectedCenterX = selectedNode.position.x + (selectedNode.width ?? 0) / 2;
        const selectedCenterY = selectedNode.position.y + (selectedNode.height ?? 0) / 2;
        const nearestConnectedNodes = displayNodes
          .filter((node) => connectedNodeIds.has(node.id))
          .map((node) => {
            const centerX = node.position.x + (node.width ?? 0) / 2;
            const centerY = node.position.y + (node.height ?? 0) / 2;
            return {
              node,
              distance: Math.hypot(centerX - selectedCenterX, centerY - selectedCenterY)
            };
          })
          .filter((item) => item.distance <= COMPACT_VIEW_NEIGHBOR_DISTANCE)
          .sort((left, right) => left.distance - right.distance)
          .slice(0, COMPACT_VIEW_NEIGHBOR_LIMIT)
          .map((item) => item.node);

        const fitSelectedNode = (duration = 450) => {
          if (isCompactView) {
            const compactNodes = [selectedNode, ...nearestConnectedNodes];

            instance.fitView({
              nodes: compactNodes,
              padding: Math.max(fitPadding, COMPACT_FOCUS_PADDING),
              maxZoom: COMPACT_FOCUS_MAX_ZOOM,
              duration
            });
            return;
          }

          instance.setCenter(selectedCenterX, selectedCenterY, {
            zoom: DESKTOP_SELECTION_ZOOM,
            duration
          });
        };

        const alignSelectedNodeToCanvas = (duration = 220) => {
          if (isCompactView) {
            return;
          }

          const selectedElement = Array.from(
            document.querySelectorAll<HTMLElement>(".react-flow__node")
          ).find((element) => element.querySelector(".graph-node--selected"));
          const canvasElement = document.querySelector<HTMLElement>(".canvas-shell");

          if (!selectedElement || !canvasElement) {
            return;
          }

          const selectedRect = selectedElement.getBoundingClientRect();
          const canvasRect = canvasElement.getBoundingClientRect();
          const selectedScreenCenterX = selectedRect.left + selectedRect.width / 2;
          const selectedScreenCenterY = selectedRect.top + selectedRect.height / 2;
          const canvasScreenCenterX = canvasRect.left + canvasRect.width / 2;
          const canvasScreenCenterY = canvasRect.top + canvasRect.height / 2;
          const viewport = instance.getViewport();

          instance.setViewport(
            {
              ...viewport,
              x: viewport.x + (canvasScreenCenterX - selectedScreenCenterX),
              y: viewport.y + (canvasScreenCenterY - selectedScreenCenterY)
            },
            { duration }
          );
        };

        fitSelectedNode();
        window.setTimeout(() => {
          fitSelectedNode(220);
          window.setTimeout(() => alignSelectedNodeToCanvas(), 240);
        }, 220);

        handledSelectionFitTokenRef.current = selectionFitToken;
        return;
      }
    }

    if (
      selectedNodeId &&
      selectionFitToken > 0 &&
      selectionFitToken === handledSelectionFitTokenRef.current &&
      resetToken === 0
    ) {
      return;
    }

    if (viewportNodeIds?.size) {
      const viewportNodes = displayNodes.filter((node) => viewportNodeIds.has(node.id));
      const fitNodes =
        isConstrainedView
          ? chooseCompactViewportNodes(viewportNodes, selectedNodeId, false, false)
          : viewportNodes;
      const compactFitNodes = fitNodes.length >= 2 ? fitNodes : viewportNodes;

      if (compactFitNodes.length) {
        instance.fitView({
          nodes: compactFitNodes,
          padding: Math.max(fitPadding, isCompactView ? COMPACT_FOCUS_PADDING : DESKTOP_FOCUS_PADDING),
          maxZoom: isCompactView ? COMPACT_FOCUS_MAX_ZOOM : DESKTOP_FOCUS_MAX_ZOOM,
          duration: 450
        });
        return;
      }
    }

    if (focusNodeIds && focusClusterId) {
      const focusNodes = displayNodes.filter((node) => focusNodeIds.has(node.id));

      if (focusNodes.length) {
        instance.fitView({
          nodes: focusNodes,
          padding: Math.max(fitPadding, isCompactView ? COMPACT_FOCUS_PADDING : DESKTOP_FOCUS_PADDING),
          maxZoom: isCompactView ? COMPACT_FOCUS_MAX_ZOOM : DESKTOP_FOCUS_MAX_ZOOM,
          duration: 450
        });
        return;
      }
    }

    if (resetToken > 0 || viewportKey === "all") {
      instance.fitView({
        padding: fitPadding,
        duration: 450
      });
    }
  }, [
    displayNodes,
    fitPadding,
    focusClusterId,
    focusNodeIds,
    instance,
    isCompactView,
    isConstrainedView,
    renderedGraph.edges,
    resetToken,
    selectionFitToken,
    selectedNodeId,
    viewportKey,
    viewportNodeIds
  ]);

  function onNodesChange(changes: NodeChange<FlowNode>[]) {
    setDisplayNodes((currentNodes) => applyNodeChanges(changes, currentNodes));
  }

  return (
    <div className="canvas-shell" ref={captureRef} data-claimgraph-canvas="true">
      <ReactFlow
        nodes={displayNodes}
        edges={renderedGraph.edges}
        nodeTypes={nodeTypes}
        onInit={setInstance}
        onNodesChange={onNodesChange}
        onNodeClick={(_event: unknown, node: { id: string }) => onNodeSelect(node.id)}
        onEdgeMouseEnter={(_event: unknown, edge: Edge) => setHoveredEdgeId(edge.id)}
        onEdgeMouseLeave={() => setHoveredEdgeId(null)}
        nodesConnectable={false}
        connectOnClick={false}
        nodeClickDistance={NODE_CLICK_DISTANCE_PX}
        nodeDragThreshold={NODE_DRAG_THRESHOLD_PX}
        ariaLabelConfig={{
          "controls.ariaLabel": "Map zoom and fit controls",
          "controls.zoomIn.ariaLabel": "Zoom argument map in",
          "controls.zoomOut.ariaLabel": "Zoom argument map out",
          "controls.fitView.ariaLabel": "Fit argument map to screen",
          "minimap.ariaLabel": "Argument map overview"
        }}
        minZoom={0.35}
        maxZoom={1.4}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1.2}
          color="rgba(168, 179, 200, 0.24)"
        />
        <Controls position="bottom-left" aria-label="Map zoom and fit controls" />
        {showMiniMap ? (
          <MiniMap
            pannable
            zoomable
            nodeColor={minimapNodeColor}
            maskColor="rgba(4, 10, 22, 0.72)"
            style={{
              width: 188,
              height: 132
            }}
          />
        ) : null}
      </ReactFlow>
    </div>
  );
}
