import { describe, expect, it } from "vitest";
import {
  getInspectionCluster,
  getNodeProvenance,
  getRelatedNodes
} from "@/lib/sidebar/inspection";
import type { ClaimGraph, Snippet, Source } from "@/types/claimgraph";

const sources: Source[] = [
  {
    id: "source_1",
    type: "web",
    title: "Retail Study",
    url: "https://example.com/retail",
    domain: "example.com",
    sourceKind: "research",
    isPrimary: true
  },
  {
    id: "source_2",
    type: "file",
    title: "Merchant Memo",
    fileName: "merchant-memo.pdf",
    sourceKind: "memo"
  }
];

const snippets: Snippet[] = [
  {
    id: "snippet_1",
    sourceId: "source_1",
    text: "Foot traffic increased after the pilot.",
    rationale: "Supports the retail upside claim.",
    relevance: 0.91
  },
  {
    id: "snippet_2",
    sourceId: "source_2",
    text: "Pickup-oriented merchants reported losses.",
    rationale: "Supports the retail downside claim.",
    relevance: 0.87
  }
];

const graph: ClaimGraph = {
  question: "Should cities ban cars downtown?",
  graphSummary: "summary",
  primaryClusterId: "cluster_business",
  nodes: [
    {
      id: "question_root",
      kind: "question",
      title: "Should cities ban cars downtown?",
      summary: "question",
      sourceIds: [],
      snippetIds: []
    },
    {
      id: "claim_upside",
      kind: "claim",
      title: "Walkable streets can lift retail foot traffic",
      summary: "summary",
      sourceIds: ["source_1"],
      snippetIds: ["snippet_1"]
    },
    {
      id: "counter_downside",
      kind: "counterclaim",
      title: "Some merchants lose convenience-based sales",
      summary: "summary",
      sourceIds: ["source_2"],
      snippetIds: ["snippet_2"]
    },
    {
      id: "gap_loading",
      kind: "gap",
      title: "Loading access remains unresolved",
      summary: "summary",
      sourceIds: ["source_2"],
      snippetIds: ["snippet_2"]
    }
  ],
  edges: [
    {
      id: "edge_claim_question",
      from: "claim_upside",
      to: "question_root",
      relation: "supports",
      strength: 0.82
    },
    {
      id: "edge_counter_claim",
      from: "counter_downside",
      to: "claim_upside",
      relation: "refutes",
      strength: 0.88
    },
    {
      id: "edge_gap_counter",
      from: "gap_loading",
      to: "counter_downside",
      relation: "qualifies",
      strength: 0.64
    }
  ],
  disagreementClusters: [
    {
      id: "cluster_business",
      claimIds: ["claim_upside", "counter_downside"],
      score: 0.89,
      title: "Do downtown businesses gain or lose?",
      explanation: "Retail upside conflicts with merchant downside.",
      sourceIds: ["source_1", "source_2"],
      snippetIds: ["snippet_1", "snippet_2"]
    }
  ]
};

describe("sidebar inspection helpers", () => {
  it("selects the strongest disagreement cluster and expands its claims and provenance", () => {
    const inspection = getInspectionCluster({
      graph,
      selectedNodeId: "gap_loading",
      strongestOnly: true,
      sources,
      snippets
    });

    expect(inspection?.cluster.id).toBe("cluster_business");
    expect(inspection?.leftClaim?.id).toBe("claim_upside");
    expect(inspection?.rightClaim?.id).toBe("counter_downside");
    expect(inspection?.sources).toHaveLength(2);
    expect(inspection?.snippets).toHaveLength(2);
    expect(inspection?.unresolvedNodes.map((node) => node.id)).toEqual(["gap_loading"]);
  });

  it("prefers an explicitly focused disagreement cluster over the selected-node fallback", () => {
    const graphWithSecondaryCluster: ClaimGraph = {
      ...graph,
      disagreementClusters: [
        graph.disagreementClusters[0],
        {
          id: "cluster_environment",
          claimIds: ["claim_upside", "counter_downside"],
          score: 0.74,
          title: "How much does environment outweigh merchant downside?",
          explanation: "The workspace explicitly focused this cluster from the toolbar.",
          sourceIds: ["source_1"],
          snippetIds: ["snippet_1"]
        }
      ]
    };

    const inspection = getInspectionCluster({
      graph: graphWithSecondaryCluster,
      selectedNodeId: "gap_loading",
      strongestOnly: true,
      focusClusterId: "cluster_environment",
      sources,
      snippets
    });

    expect(inspection?.cluster.id).toBe("cluster_environment");
    expect(inspection?.sources.map((source) => source.id)).toEqual(["source_1"]);
    expect(inspection?.snippets.map((snippet) => snippet.id)).toEqual(["snippet_1"]);
  });

  it("can infer a relevant disagreement cluster from a selected gap even when strongest-only mode is off", () => {
    const inspection = getInspectionCluster({
      graph,
      selectedNodeId: "gap_loading",
      strongestOnly: false,
      sources,
      snippets
    });

    expect(inspection?.cluster.id).toBe("cluster_business");
    expect(inspection?.selectedFrame).toBe("unresolved");
    expect(inspection?.rightContext.some((item) => item.node.id === "gap_loading")).toBe(true);
  });

  it("returns direct provenance and related graph neighbors for the selected node", () => {
    const selectedNode = graph.nodes.find((node) => node.id === "counter_downside") ?? null;
    const provenance = getNodeProvenance({
      node: selectedNode,
      sources,
      snippets
    });
    const related = getRelatedNodes(graph, "counter_downside");

    expect(provenance.sources.map((source) => source.id)).toEqual(["source_2"]);
    expect(provenance.snippets.map((snippet) => snippet.id)).toEqual(["snippet_2"]);
    expect(related).toHaveLength(2);
    expect(related.map((item) => item.node.id).sort()).toEqual([
      "claim_upside",
      "gap_loading"
    ]);
  });
});
