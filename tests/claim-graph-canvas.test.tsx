// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClaimGraphCanvas } from "@/components/graph/ClaimGraphCanvas";
import type { ClaimGraph } from "@/types/claimgraph";

type MockFlowNode = {
  id: string;
};

type ReactFlowMockProps = {
  nodes: MockFlowNode[];
  children?: ReactNode;
  connectOnClick?: boolean;
  nodeClickDistance?: number;
  nodeDragThreshold?: number;
  nodesConnectable?: boolean;
  onNodeClick?: (event: unknown, node: MockFlowNode) => void;
};

const reactFlowMockState = vi.hoisted(() => ({
  lastProps: null as null | {
    connectOnClick?: boolean;
    nodeClickDistance?: number;
    nodeDragThreshold?: number;
    nodesConnectable?: boolean;
  }
}));

vi.mock("@xyflow/react", async () => {
  const React = await import("react");

  return {
    Background: () => null,
    BackgroundVariant: {
      Dots: "dots"
    },
    Controls: () => null,
    Handle: () => null,
    MarkerType: {
      ArrowClosed: "arrowclosed"
    },
    MiniMap: () => null,
    Position: {
      Bottom: "bottom",
      Top: "top"
    },
    ReactFlow: ({
      children,
      connectOnClick,
      nodeClickDistance,
      nodeDragThreshold,
      nodes,
      nodesConnectable,
      onNodeClick
    }: ReactFlowMockProps) => {
      reactFlowMockState.lastProps = {
        connectOnClick,
        nodeClickDistance,
        nodeDragThreshold,
        nodesConnectable
      };

      return React.createElement(
        "div",
        { "data-testid": "react-flow" },
        nodes.map((node) =>
          React.createElement(
            "button",
            {
              key: node.id,
              type: "button",
              onClick: (event) => onNodeClick?.(event, node)
            },
            `Select ${node.id}`
          )
        ),
        children
      );
    },
    applyNodeChanges: vi.fn((_changes: unknown[], nodes: MockFlowNode[]) => nodes)
  };
});

function buildGraph(): ClaimGraph {
  return {
    question: "Should cities ban cars downtown?",
    graphSummary: "A compact graph fixture.",
    nodes: [
      {
        id: "question_1",
        kind: "question",
        title: "Should cities ban cars downtown?",
        summary: "The decision question.",
        sourceIds: [],
        snippetIds: []
      },
      {
        id: "claim_1",
        kind: "claim",
        title: "Car-free streets can improve air quality",
        summary: "Restrictions can reduce vehicle emissions in the affected core.",
        stance: "pro",
        confidence: 0.78,
        sourceIds: ["source_1"],
        snippetIds: ["snippet_1"]
      }
    ],
    edges: [
      {
        id: "edge_claim_question",
        from: "claim_1",
        to: "question_1",
        relation: "supports",
        strength: 0.78
      }
    ],
    disagreementClusters: []
  };
}

describe("ClaimGraphCanvas", () => {
  beforeEach(() => {
    reactFlowMockState.lastProps = null;
  });

  it("keeps draggable graph nodes selectable even when pointer movement is slightly noisy", async () => {
    const onNodeSelect = vi.fn();

    render(
      <ClaimGraphCanvas
        graph={buildGraph()}
        selectedNodeId={null}
        focusNodeIds={null}
        visibleNodeIds={null}
        viewportNodeIds={null}
        resetToken={0}
        onNodeSelect={onNodeSelect}
      />
    );

    await waitFor(() => {
      expect(reactFlowMockState.lastProps).toEqual(
        expect.objectContaining({
          connectOnClick: false,
          nodeClickDistance: 8,
          nodeDragThreshold: 4,
          nodesConnectable: false
        })
      );
    });

    fireEvent.click(await screen.findByRole("button", { name: "Select claim_1" }));

    expect(onNodeSelect).toHaveBeenCalledWith("claim_1");
  });
});
