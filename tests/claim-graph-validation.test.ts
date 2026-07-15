import { describe, expect, it } from "vitest";
import {
  claimGraphSchema,
  validateClaimGraphArtifacts
} from "@/lib/validation/claim-graph";
import type { ClaimGraph, Snippet, Source } from "@/types/claimgraph";

const sources: Source[] = [
  {
    id: "source_1",
    type: "web",
    title: "Source 1",
    url: "https://example.com/source-1"
  }
];

const snippets: Snippet[] = [
  {
    id: "snippet_1",
    sourceId: "source_1",
    text: "Grounded snippet.",
    rationale: "Supports the claim.",
    relevance: 0.91
  }
];

function buildBaseGraph(): ClaimGraph {
  return {
    question: "Should cities ban cars downtown?",
    graphSummary: "summary",
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
        id: "claim_1",
        kind: "claim",
        title: "Air quality improves",
        summary: "summary",
        sourceIds: ["source_1"],
        snippetIds: ["snippet_1"]
      },
      {
        id: "evidence_1",
        kind: "evidence",
        title: "Source 1",
        summary: "Grounded snippet.",
        sourceIds: ["source_1"],
        snippetIds: ["snippet_1"]
      }
    ],
    edges: [
      {
        id: "edge_claim_question",
        from: "claim_1",
        to: "question_root",
        relation: "supports",
        strength: 0.82
      },
      {
        id: "edge_evidence_claim",
        from: "evidence_1",
        to: "claim_1",
        relation: "supports",
        strength: 0.91
      }
    ],
    disagreementClusters: [],
    primaryClusterId: undefined
  };
}

describe("claim graph validation", () => {
  it("rejects non-question nodes without provenance", () => {
    const graph = buildBaseGraph();
    graph.nodes[1] = {
      ...graph.nodes[1],
      sourceIds: [],
      snippetIds: []
    };

    expect(() => claimGraphSchema.parse(graph)).toThrow(/non-question node/i);
  });

  it("rejects evidence nodes that preserve more than one snippet", () => {
    const graph = buildBaseGraph();
    graph.nodes[2] = {
      ...graph.nodes[2],
      snippetIds: ["snippet_1", "snippet_2"]
    };

    expect(() => claimGraphSchema.parse(graph)).toThrow(/exactly one snippet id/i);
  });

  it("rejects graph nodes whose snippet provenance does not match their source ids", () => {
    const graph = buildBaseGraph();
    graph.nodes[1] = {
      ...graph.nodes[1],
      sourceIds: ["source_missing"]
    };

    expect(() =>
      validateClaimGraphArtifacts({
        graph,
        sources,
        snippets
      })
    ).toThrow(/missing source|without preserving its source id/i);
  });
});
