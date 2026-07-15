import { describe, expect, it } from "vitest";
import { buildStarterDataset, DEFAULT_DEMO_QUESTION } from "@/lib/demo/graph-template";
import {
  buildFlowGraph,
  collectFocusNodeIds,
  collectSelectionNodeIds,
  collectUnresolvedNodeIds,
  collectViewportNodeIds,
  collectVisibleNodeIds,
  pickSelectedNodeId,
  sortDisagreementClusters
} from "@/lib/graph/transforms";
import type { ClaimGraph } from "@/types/claimgraph";

function nodesOverlap(
  left: { position: { x: number; y: number }; width?: number; height?: number },
  right: { position: { x: number; y: number }; width?: number; height?: number }
) {
  const leftWidth = left.width ?? 0;
  const leftHeight = left.height ?? 0;
  const rightWidth = right.width ?? 0;
  const rightHeight = right.height ?? 0;

  return (
    left.position.x < right.position.x + rightWidth &&
    left.position.x + leftWidth > right.position.x &&
    left.position.y < right.position.y + rightHeight &&
    left.position.y + leftHeight > right.position.y
  );
}

function buildGraph(): ClaimGraph {
  return {
    question: "Should cities ban cars downtown?",
    graphSummary: "summary",
    primaryClusterId: "cluster_business",
    nodes: [
      {
        id: "question_custom",
        kind: "question",
        title: "Should cities ban cars downtown?",
        summary: "question",
        sourceIds: [],
        snippetIds: []
      },
      {
        id: "claim_a",
        kind: "claim",
        title: "Claim A",
        summary: "summary",
        sourceIds: ["src_1"],
        snippetIds: ["sn_1"]
      },
      {
        id: "counter_a",
        kind: "counterclaim",
        title: "Counter A",
        summary: "summary",
        sourceIds: ["src_2"],
        snippetIds: ["sn_2"]
      },
      {
        id: "evidence_a",
        kind: "evidence",
        title: "Evidence A",
        summary: "summary",
        sourceIds: ["src_1"],
        snippetIds: ["sn_1"]
      },
      {
        id: "gap_a",
        kind: "gap",
        title: "Gap A",
        summary: "summary",
        sourceIds: ["src_1"],
        snippetIds: ["sn_1"]
      }
    ],
    edges: [
      {
        id: "edge_claim_question",
        from: "claim_a",
        to: "question_custom",
        relation: "supports",
        strength: 0.8
      },
      {
        id: "edge_counter_claim",
        from: "counter_a",
        to: "claim_a",
        relation: "refutes",
        strength: 0.81
      },
      {
        id: "edge_evidence_claim",
        from: "evidence_a",
        to: "claim_a",
        relation: "supports",
        strength: 0.9
      },
      {
        id: "edge_gap_claim",
        from: "gap_a",
        to: "claim_a",
        relation: "depends_on",
        strength: 0.76
      }
    ],
    disagreementClusters: [
      {
        id: "cluster_business",
        claimIds: ["claim_a", "counter_a"],
        score: 0.84,
        title: "Conflict",
        explanation: "Why these claims conflict.",
        sourceIds: ["src_1", "src_2"],
        snippetIds: ["sn_1", "sn_2"]
      },
      {
        id: "cluster_environment",
        claimIds: ["claim_a", "counter_a"],
        score: 0.72,
        title: "Environment",
        explanation: "Secondary cluster.",
        sourceIds: ["src_1"],
        snippetIds: ["sn_1"]
      }
    ]
  };
}

describe("collectFocusNodeIds", () => {
  it("includes the actual question node id instead of assuming q_root", () => {
    const focusNodeIds = collectFocusNodeIds(buildGraph(), "cluster_business");

    expect(focusNodeIds).not.toBeNull();
    expect(focusNodeIds?.has("question_custom")).toBe(true);
    expect(focusNodeIds?.has("claim_a")).toBe(true);
    expect(focusNodeIds?.has("counter_a")).toBe(true);
    expect(focusNodeIds?.has("evidence_a")).toBe(true);
    expect(focusNodeIds?.has("gap_a")).toBe(true);
    expect(focusNodeIds?.has("q_root")).toBe(false);
  });

  it("returns null when the requested cluster does not exist", () => {
    expect(collectFocusNodeIds(buildGraph(), "missing_cluster")).toBeNull();
  });

  it("collects unresolved branch nodes and their direct supporting evidence", () => {
    const unresolvedNodeIds = collectUnresolvedNodeIds(buildGraph(), "cluster_business");

    expect(unresolvedNodeIds).not.toBeNull();
    expect(unresolvedNodeIds?.has("question_custom")).toBe(true);
    expect(unresolvedNodeIds?.has("claim_a")).toBe(true);
    expect(unresolvedNodeIds?.has("gap_a")).toBe(true);
    expect(unresolvedNodeIds?.has("evidence_a")).toBe(true);
  });

  it("keeps unresolved branch visibility coherent with hidden node-kind filters", () => {
    const visibleNodeIds = collectVisibleNodeIds({
      graph: buildGraph(),
      hiddenKinds: ["evidence"],
      strongestOnly: false,
      unresolvedOnly: true
    });

    expect(visibleNodeIds.has("gap_a")).toBe(true);
    expect(visibleNodeIds.has("evidence_a")).toBe(false);
  });

  it("prefers a gap selection when unresolved-only mode is active", () => {
    const graph = buildGraph();
    const visibleNodeIds = collectVisibleNodeIds({
      graph,
      hiddenKinds: [],
      strongestOnly: true,
      focusClusterId: "cluster_business",
      unresolvedOnly: true
    });
    const selectionNodeIds = collectSelectionNodeIds({
      graph,
      visibleNodeIds,
      strongestOnly: true,
      focusClusterId: "cluster_business"
    });

    expect(
      pickSelectedNodeId({
        graph,
        currentSelectedNodeId: "question_custom",
        selectionNodeIds,
        strongestOnly: true,
        focusClusterId: "cluster_business",
        unresolvedOnly: true
      })
    ).toBe("gap_a");
  });

  it("keeps an explicitly selected visible evidence or gap node in strongest-conflict mode", () => {
    const graph = buildGraph();
    const visibleNodeIds = collectVisibleNodeIds({
      graph,
      hiddenKinds: [],
      strongestOnly: true,
      focusClusterId: "cluster_business",
      unresolvedOnly: false
    });
    const selectionNodeIds = collectSelectionNodeIds({
      graph,
      visibleNodeIds,
      strongestOnly: true,
      focusClusterId: "cluster_business"
    });

    expect(
      pickSelectedNodeId({
        graph,
        currentSelectedNodeId: "evidence_a",
        selectionNodeIds,
        strongestOnly: true,
        focusClusterId: "cluster_business",
        unresolvedOnly: false
      })
    ).toBe("evidence_a");

    expect(
      pickSelectedNodeId({
        graph,
        currentSelectedNodeId: "gap_a",
        selectionNodeIds,
        strongestOnly: true,
        focusClusterId: "cluster_business",
        unresolvedOnly: false
      })
    ).toBe("gap_a");
  });

  it("fits the default strongest-conflict viewport around the conflict spine", () => {
    const graph = buildGraph();
    graph.nodes.push({
      id: "evidence_b",
      kind: "evidence",
      title: "Evidence B",
      summary: "A second supporting card that should remain pannable context.",
      sourceIds: ["src_3"],
      snippetIds: ["sn_3"]
    });
    graph.edges.push({
      id: "edge_evidence_b_claim",
      from: "evidence_b",
      to: "claim_a",
      relation: "supports",
      strength: 0.65
    });
    const visibleNodeIds = collectVisibleNodeIds({
      graph,
      hiddenKinds: [],
      strongestOnly: true,
      focusClusterId: "cluster_business",
      unresolvedOnly: false
    });
    const viewportNodeIds = collectViewportNodeIds({
      graph,
      visibleNodeIds,
      strongestOnly: true,
      focusClusterId: "cluster_business",
      unresolvedOnly: false
    });

    expect(viewportNodeIds).not.toBeNull();
    expect(viewportNodeIds?.has("question_custom")).toBe(true);
    expect(viewportNodeIds?.has("claim_a")).toBe(true);
    expect(viewportNodeIds?.has("counter_a")).toBe(true);
    expect(viewportNodeIds?.has("gap_a")).toBe(true);
    expect(viewportNodeIds?.has("evidence_a")).toBe(true);
    expect(viewportNodeIds?.has("evidence_b")).toBe(false);
  });

  it("sorts disagreement clusters with the primary cluster first", () => {
    expect(sortDisagreementClusters(buildGraph()).map((cluster) => cluster.id)).toEqual([
      "cluster_business",
      "cluster_environment"
    ]);
  });

  it("builds flow nodes with top-to-bottom handles and only labels dependent edges", () => {
    const { nodes, edges } = buildFlowGraph(buildGraph());

    expect(nodes.every((node) => node.sourcePosition === "bottom")).toBe(true);
    expect(nodes.every((node) => node.targetPosition === "top")).toBe(true);
    expect(edges.find((edge) => edge.id === "edge_gap_claim")?.label).toBe("depends on");
    expect(edges.find((edge) => edge.id === "edge_claim_question")?.label).toBeUndefined();
    expect(edges.every((edge) => edge.type === "smoothstep")).toBe(true);
  });

  it("keeps starter business-cluster evidence cards visible without overlap", () => {
    const { graph } = buildStarterDataset(DEFAULT_DEMO_QUESTION);
    const { nodes } = buildFlowGraph(graph);
    const footfallEvidence = nodes.find((node) => node.id === "e_footfall");
    const retailEvidence = nodes.find((node) => node.id === "e_retail");

    expect(footfallEvidence).toBeDefined();
    expect(retailEvidence).toBeDefined();
    expect(nodesOverlap(footfallEvidence!, retailEvidence!)).toBe(false);
  });

  it("makes the generic starter graph question-aware and visibly scaffolded", () => {
    const question = "Should woke movement banned from all the country?";
    const { graph, snippets, sources } = buildStarterDataset(question);
    const titles = graph.nodes.map((node) => node.title).join(" | ");

    expect(graph.graphSummary).toContain("sample starter scaffold");
    expect(graph.graphSummary).toContain("Should woke movement banned from all the country?");
    expect(titles).toContain("Supporters need evidence");
    expect(titles).toContain("Critics need evidence");
    expect(titles).toContain("country-specific");
    expect(titles).not.toContain("Supporters see a meaningful upside");
    expect(titles).not.toContain("The outcome depends on local context");

    for (const node of graph.nodes) {
      if (node.kind === "question") {
        continue;
      }

      expect(node.sourceIds.length).toBeGreaterThan(0);
      expect(node.snippetIds.length).toBeGreaterThan(0);
    }

    expect(sources.every((source) => source.title.startsWith("Sample"))).toBe(true);
    expect(snippets.every((snippet) => snippet.origin === "starter_curated")).toBe(true);
    expect(snippets.every((snippet) => snippet.text.includes(question))).toBe(true);
  });
});
