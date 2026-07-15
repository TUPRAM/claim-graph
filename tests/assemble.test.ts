import { beforeEach, describe, expect, it, vi } from "vitest";
import { assembleGraph } from "@/lib/openai/assemble";
import type { ClaimInventory, EvidencePack } from "@/types/claimgraph";

const parseMock = vi.fn();

vi.mock("@/lib/openai/client", () => ({
  createOpenAIRequestOptions: () => ({
    options: { signal: undefined },
    cleanup: () => undefined
  }),
  getOpenAIClient: () => ({
    responses: {
      parse: parseMock
    }
  })
}));

const evidencePack: EvidencePack = {
  question: "Should cities ban cars downtown?",
  summary: "Air quality and retail outcomes are the main axes.",
  subquestions: ["What happens to local retail?"],
  evidenceAxes: [
    {
      id: "axis_1",
      label: "Environment",
      description: "Air quality outcomes.",
      snippetIds: ["snippet_1", "snippet_2"]
    }
  ],
  sources: [
    {
      id: "source_1",
      type: "web",
      title: "Air Quality Study",
      url: "https://example.com/air"
    },
    {
      id: "source_2",
      type: "file",
      title: "Merchant Memo",
      fileName: "merchant-memo.pdf"
    }
  ],
  snippets: [
    {
      id: "snippet_1",
      sourceId: "source_1",
      text: "Air quality improved after the pilot.",
      rationale: "Supports the environmental claim.",
      relevance: 0.91
    },
    {
      id: "snippet_2",
      sourceId: "source_2",
      text: "Pickup-oriented merchants reported losses.",
      rationale: "Supports the merchant counterclaim.",
      relevance: 0.86
    }
  ],
  openQuestions: ["How much do retail impacts vary by business type?"],
  warnings: []
};

const claimInventory: ClaimInventory = {
  question: evidencePack.question,
  claims: [
    {
      id: "claim_1",
      kind: "claim",
      title: "Pedestrianization improves air quality",
      summary: "The saved evidence points to cleaner air inside the pilot zone.",
      topic: "Environment",
      stance: "pro",
      confidence: 0.82,
      evidenceQuality: "high",
      sourceIds: ["source_1"],
      snippetIds: ["snippet_1"],
      qualifiers: [],
      dependsOnGapIds: []
    },
    {
      id: "counter_1",
      kind: "counterclaim",
      title: "Some merchants lose convenience-driven customers",
      summary: "Pickup-heavy merchants reported losses after access changes.",
      topic: "Business",
      stance: "con",
      confidence: 0.78,
      evidenceQuality: "high",
      sourceIds: ["source_2"],
      snippetIds: ["snippet_2"],
      qualifiers: [],
      dependsOnGapIds: ["gap_1"]
    }
  ],
  contradictionPairs: [
    {
      id: "pair_1",
      leftClaimId: "claim_1",
      rightClaimId: "counter_1",
      contradictionStrength: 0.84,
      explanation: "Environmental upside conflicts with merchant downside."
    }
  ],
  unresolvedGaps: [
    {
      id: "gap_1",
      title: "Retail outcomes remain conditional",
      summary: "The evidence is mixed across business types.",
      gapType: "mixed_evidence",
      sourceIds: ["source_2"],
      snippetIds: ["snippet_2"],
      importance: 0.73
    }
  ]
};

describe("assembleGraph", () => {
  beforeEach(() => {
    parseMock.mockReset();
  });

  it("uses GPT-5.4 structured outputs and returns a schema-valid live graph", async () => {
    parseMock.mockResolvedValue({
      id: "resp_graph_plan",
      output_parsed: {
        graphSummary:
          "The strongest disagreement concerns air-quality gains versus merchant downside.",
        claimSelections: [
          { claimId: "claim_1", importance: 0.91 },
          { claimId: "counter_1", importance: 0.87 }
        ],
        gapSelections: [{ gapId: "gap_1", importance: 0.73 }],
        claimRelations: [
          {
            fromClaimId: "counter_1",
            toClaimId: "claim_1",
            relation: "refutes",
            strength: 0.84
          }
        ],
        gapRelations: [
          {
            gapId: "gap_1",
            claimId: "counter_1",
            relation: "depends_on",
            strength: 0.73
          }
        ],
        disagreementClusters: [
          {
            contradictionPairId: "pair_1",
            title: "Do air-quality gains outweigh merchant downside?",
            explanation: "Both sides remain grounded and decision-relevant.",
            topicRelevance: 0.9
          }
        ]
      }
    });

    const result = await assembleGraph({
      question: evidencePack.question,
      claimInventory,
      evidencePack
    });

    expect(parseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.4",
        text: {
          format: expect.anything()
        }
      }),
      expect.objectContaining({
        signal: undefined
      })
    );
    expect(result.responseId).toBe("resp_graph_plan");
    expect(result.graph.primaryClusterId).toBe("cluster_pair_1");
    expect(result.graph.nodes.some((node) => node.kind === "evidence")).toBe(true);
    expect(result.graph.nodes.length).toBeLessThanOrEqual(25);
  });

  it("falls back to deterministic live assembly when final graph assembly fails", async () => {
    parseMock.mockRejectedValue(new Error("structured graph assembly failed"));

    const result = await assembleGraph({
      question: evidencePack.question,
      claimInventory,
      evidencePack
    });

    expect(parseMock).toHaveBeenCalledOnce();
    expect(result.model).toBe("deterministic-assembly-fallback");
    expect(result.responseId).toBe("deterministic-assembly-fallback");
    expect(result.graph.primaryClusterId).toBe("cluster_pair_1");
    expect(result.graph.graphSummary).toContain("saved web evidence");
    expect(result.graph.nodes.some((node) => node.kind === "evidence")).toBe(true);
    expect(
      result.graph.nodes
        .filter((node) => node.kind !== "question")
        .every((node) => node.sourceIds.length > 0 && node.snippetIds.length > 0)
    ).toBe(true);
  });
});
