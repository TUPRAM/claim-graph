import { describe, expect, it } from "vitest";
import {
  buildLiveClaimGraph,
  repairLiveGraphDisagreementClusters,
  type GraphAssemblyPlan
} from "@/lib/graph/live-assembly";
import type { ClaimInventory, EvidencePack } from "@/types/claimgraph";

const evidencePack: EvidencePack = {
  question: "Should cities ban cars downtown?",
  summary: "Air quality, retail outcomes, access, and transit readiness are the main axes.",
  subquestions: [
    "What happens to local air quality?",
    "What happens to local retail?"
  ],
  evidenceAxes: [
    {
      id: "axis_environment",
      label: "Environment",
      description: "Air quality and spillover traffic outcomes.",
      snippetIds: ["snippet_air_1", "snippet_spill_1"]
    },
    {
      id: "axis_business",
      label: "Business",
      description: "Retail traffic and business access outcomes.",
      snippetIds: ["snippet_retail_1", "snippet_retail_2"]
    }
  ],
  sources: [
    { id: "source_air", type: "web", title: "Air Quality Study", url: "https://example.com/air" },
    { id: "source_spill", type: "web", title: "Spillover Traffic Study", url: "https://example.com/spill" },
    { id: "source_retail", type: "web", title: "Retail Footfall Study", url: "https://example.com/retail" },
    { id: "source_merchant", type: "file", title: "Merchant Memo", fileName: "merchant-memo.pdf" },
    { id: "source_safety", type: "web", title: "Street Safety Study", url: "https://example.com/safety" },
    { id: "source_access", type: "file", title: "Accessibility Memo", fileName: "accessibility-memo.pdf" },
    { id: "source_transit", type: "file", title: "Transit Capacity Audit", fileName: "transit-audit.pdf" },
    { id: "source_loading", type: "file", title: "Loading Window Memo", fileName: "loading-memo.pdf" },
    { id: "source_equity", type: "web", title: "Equity Review", url: "https://example.com/equity" },
    { id: "source_noise", type: "web", title: "Noise Study", url: "https://example.com/noise" }
  ],
  snippets: [
    {
      id: "snippet_air_1",
      sourceId: "source_air",
      text: "Roadside NO2 fell inside the downtown pilot zone.",
      rationale: "Supports the air-quality claim.",
      relevance: 0.94
    },
    {
      id: "snippet_air_2",
      sourceId: "source_air",
      text: "Pollution reductions were strongest on the car-restricted streets.",
      rationale: "Adds a second environmental signal.",
      relevance: 0.87
    },
    {
      id: "snippet_spill_1",
      sourceId: "source_spill",
      text: "Boundary streets saw heavier congestion during peak hours.",
      rationale: "Supports the spillover counterclaim.",
      relevance: 0.89
    },
    {
      id: "snippet_spill_2",
      sourceId: "source_spill",
      text: "Some traffic relocated rather than disappearing entirely.",
      rationale: "Adds a second spillover detail.",
      relevance: 0.8
    },
    {
      id: "snippet_retail_1",
      sourceId: "source_retail",
      text: "Pedestrianized streets showed higher foot traffic after transit upgrades.",
      rationale: "Supports the retail upside claim.",
      relevance: 0.91
    },
    {
      id: "snippet_retail_2",
      sourceId: "source_merchant",
      text: "Pickup-oriented merchants reported losses after access changes.",
      rationale: "Supports the retail downside counterclaim.",
      relevance: 0.88
    },
    {
      id: "snippet_safety_1",
      sourceId: "source_safety",
      text: "Pedestrian injury rates fell on the restricted corridor.",
      rationale: "Supports the safety claim.",
      relevance: 0.76
    },
    {
      id: "snippet_access_1",
      sourceId: "source_access",
      text: "Disabled users reported mixed access outcomes depending on exemptions.",
      rationale: "Supports the access counterclaim.",
      relevance: 0.72
    },
    {
      id: "snippet_transit_1",
      sourceId: "source_transit",
      text: "Transit capacity varied sharply across corridors.",
      rationale: "Supports the transit gap.",
      relevance: 0.79
    },
    {
      id: "snippet_loading_1",
      sourceId: "source_loading",
      text: "Retail outcomes depended on freight windows and loading access.",
      rationale: "Supports the loading gap.",
      relevance: 0.74
    },
    {
      id: "snippet_equity_1",
      sourceId: "source_equity",
      text: "Equity impacts depend on who benefits from improved transit access.",
      rationale: "Supports the equity gap.",
      relevance: 0.69
    },
    {
      id: "snippet_noise_1",
      sourceId: "source_noise",
      text: "Noise reductions were measurable but less central than other effects.",
      rationale: "Supports the low-priority noise claim.",
      relevance: 0.52
    }
  ],
  openQuestions: ["How much do results depend on local transit quality?"],
  warnings: []
};

const claimInventory: ClaimInventory = {
  question: evidencePack.question,
  claims: [
    {
      id: "claim_air",
      kind: "claim",
      title: "Car restrictions improve local air quality",
      summary: "The strongest environmental evidence points to cleaner air inside the pilot zone.",
      topic: "Environment",
      stance: "pro",
      confidence: 0.86,
      evidenceQuality: "high",
      sourceIds: ["source_air"],
      snippetIds: ["snippet_air_1", "snippet_air_2"],
      qualifiers: [],
      dependsOnGapIds: ["gap_transit"]
    },
    {
      id: "counter_spill",
      kind: "counterclaim",
      title: "Traffic spills into nearby streets",
      summary: "Some harms may move outward rather than disappearing entirely.",
      topic: "Environment",
      stance: "con",
      confidence: 0.82,
      evidenceQuality: "high",
      sourceIds: ["source_spill"],
      snippetIds: ["snippet_spill_1", "snippet_spill_2"],
      qualifiers: [],
      dependsOnGapIds: []
    },
    {
      id: "claim_retail_upside",
      kind: "claim",
      title: "Walkable streets can lift retail foot traffic",
      summary: "Footfall can improve where street restrictions are paired with strong alternatives.",
      topic: "Business",
      stance: "pro",
      confidence: 0.84,
      evidenceQuality: "high",
      sourceIds: ["source_retail"],
      snippetIds: ["snippet_retail_1"],
      qualifiers: ["Transit quality matters"],
      dependsOnGapIds: ["gap_transit", "gap_loading"]
    },
    {
      id: "counter_retail_downside",
      kind: "counterclaim",
      title: "Some merchants lose convenience-based sales",
      summary: "Drive-in and pickup-heavy businesses can lose customers after access changes.",
      topic: "Business",
      stance: "con",
      confidence: 0.83,
      evidenceQuality: "high",
      sourceIds: ["source_merchant"],
      snippetIds: ["snippet_retail_2"],
      qualifiers: [],
      dependsOnGapIds: ["gap_loading"]
    },
    {
      id: "claim_safety",
      kind: "claim",
      title: "Street safety can improve on the restricted corridor",
      summary: "Pedestrian injury rates fell on the pilot corridor.",
      topic: "Safety",
      stance: "pro",
      confidence: 0.68,
      evidenceQuality: "medium",
      sourceIds: ["source_safety"],
      snippetIds: ["snippet_safety_1"],
      qualifiers: [],
      dependsOnGapIds: []
    },
    {
      id: "counter_access",
      kind: "counterclaim",
      title: "Accessibility impacts stay mixed without strong exemptions",
      summary: "Disabled users reported mixed outcomes where exemptions were weak.",
      topic: "Accessibility",
      stance: "con",
      confidence: 0.65,
      evidenceQuality: "medium",
      sourceIds: ["source_access"],
      snippetIds: ["snippet_access_1"],
      qualifiers: [],
      dependsOnGapIds: ["gap_equity"]
    },
    {
      id: "claim_noise",
      kind: "claim",
      title: "Noise can fall on restricted streets",
      summary: "Noise reductions were measurable but less central than air quality or retail.",
      topic: "Noise",
      stance: "pro",
      confidence: 0.42,
      evidenceQuality: "low",
      sourceIds: ["source_noise"],
      snippetIds: ["snippet_noise_1"],
      qualifiers: [],
      dependsOnGapIds: []
    }
  ],
  contradictionPairs: [
    {
      id: "pair_business",
      leftClaimId: "claim_retail_upside",
      rightClaimId: "counter_retail_downside",
      contradictionStrength: 0.93,
      explanation: "Retail upside and retail downside are the sharpest competing interpretations."
    },
    {
      id: "pair_environment",
      leftClaimId: "claim_air",
      rightClaimId: "counter_spill",
      contradictionStrength: 0.85,
      explanation: "Cleaner air in the core can conflict with spillover harms nearby."
    },
    {
      id: "pair_access",
      leftClaimId: "claim_safety",
      rightClaimId: "counter_access",
      contradictionStrength: 0.62,
      explanation: "Safety gains can still coexist with accessibility concerns."
    }
  ],
  unresolvedGaps: [
    {
      id: "gap_transit",
      title: "Transit readiness varies by corridor",
      summary: "Benefits depend on whether transit can absorb displaced trips.",
      gapType: "mixed_evidence",
      sourceIds: ["source_transit"],
      snippetIds: ["snippet_transit_1"],
      importance: 0.88
    },
    {
      id: "gap_loading",
      title: "Loading access may determine merchant outcomes",
      summary: "Retail effects depend on freight windows and loading access.",
      gapType: "assumption_dependency",
      sourceIds: ["source_loading"],
      snippetIds: ["snippet_loading_1"],
      importance: 0.83
    },
    {
      id: "gap_equity",
      title: "Equity effects remain unresolved",
      summary: "The evidence does not settle who bears the remaining access burden.",
      gapType: "missing_context",
      sourceIds: ["source_equity"],
      snippetIds: ["snippet_equity_1"],
      importance: 0.67
    },
    {
      id: "gap_timeframe",
      title: "Long-term adaptation is underspecified",
      summary: "Short-term pilots may not capture the full adaptation horizon.",
      gapType: "insufficient_evidence",
      sourceIds: ["source_retail"],
      snippetIds: ["snippet_retail_1"],
      importance: 0.56
    },
    {
      id: "gap_noise",
      title: "Noise effects are less decision-critical",
      summary: "Noise changes appear real but less central to the main decision.",
      gapType: "mixed_evidence",
      sourceIds: ["source_noise"],
      snippetIds: ["snippet_noise_1"],
      importance: 0.21
    }
  ]
};

const plan: GraphAssemblyPlan = {
  graphSummary:
    "The strongest live disagreement concerns retail gains versus merchant downside, with transit and loading access still unresolved.",
  claimSelections: [
    { claimId: "claim_retail_upside", importance: 0.97 },
    { claimId: "counter_retail_downside", importance: 0.95 },
    { claimId: "claim_air", importance: 0.9 },
    { claimId: "counter_spill", importance: 0.88 },
    { claimId: "claim_safety", importance: 0.61 },
    { claimId: "counter_access", importance: 0.59 },
    { claimId: "claim_noise", importance: 0.18 }
  ],
  gapSelections: [
    { gapId: "gap_transit", importance: 0.93 },
    { gapId: "gap_loading", importance: 0.87 },
    { gapId: "gap_equity", importance: 0.7 },
    { gapId: "gap_timeframe", importance: 0.52 },
    { gapId: "gap_noise", importance: 0.16 }
  ],
  claimRelations: [
    {
      fromClaimId: "counter_retail_downside",
      toClaimId: "claim_retail_upside",
      relation: "refutes",
      strength: 0.91
    },
    {
      fromClaimId: "counter_spill",
      toClaimId: "claim_air",
      relation: "refutes",
      strength: 0.84
    },
    {
      fromClaimId: "counter_access",
      toClaimId: "claim_safety",
      relation: "qualifies",
      strength: 0.58
    }
  ],
  gapRelations: [
    {
      gapId: "gap_transit",
      claimId: "claim_retail_upside",
      relation: "depends_on",
      strength: 0.91
    },
    {
      gapId: "gap_loading",
      claimId: "counter_retail_downside",
      relation: "qualifies",
      strength: 0.73
    },
    {
      gapId: "gap_equity",
      claimId: "counter_access",
      relation: "depends_on",
      strength: 0.67
    }
  ],
  disagreementClusters: [
    {
      contradictionPairId: "pair_business",
      title: "Do downtown businesses gain or lose?",
      explanation: "Retail upside and merchant downside are both grounded and central to the decision.",
      topicRelevance: 0.96
    },
    {
      contradictionPairId: "pair_environment",
      title: "Do emissions fall overall or just move?",
      explanation: "Air-quality gains conflict with spillover harms on boundary streets.",
      topicRelevance: 0.82
    },
    {
      contradictionPairId: "pair_access",
      title: "Do safety gains come at an access cost?",
      explanation: "Safety gains remain relevant, but access constraints reduce their policy clarity.",
      topicRelevance: 0.56
    }
  ]
};

describe("buildLiveClaimGraph", () => {
  it("enforces readable caps, preserves provenance, and picks the strongest disagreement cluster", () => {
    const graph = buildLiveClaimGraph({
      question: evidencePack.question,
      claimInventory,
      evidencePack,
      plan
    });

    const argumentNodes = graph.nodes.filter(
      (node) => node.kind === "claim" || node.kind === "counterclaim"
    );
    const gapNodes = graph.nodes.filter((node) => node.kind === "gap");

    expect(graph.nodes.length).toBeLessThanOrEqual(25);
    expect(argumentNodes.length).toBeLessThanOrEqual(6);
    expect(gapNodes.length).toBeLessThanOrEqual(4);
    expect(graph.nodes.find((node) => node.id === "claim_noise")).toBeUndefined();
    expect(graph.nodes.find((node) => node.id === "gap_noise")).toBeUndefined();
    expect(graph.primaryClusterId).toBe("cluster_pair_business");
    expect(graph.disagreementClusters[0]).toMatchObject({
      id: "cluster_pair_business",
      title: "Do downtown businesses gain or lose?"
    });
    expect(
      graph.nodes.every(
        (node) =>
          node.kind === "question" ||
          (node.sourceIds.length > 0 && node.snippetIds.length > 0)
      )
    ).toBe(true);
    expect(
      graph.edges.every((edge) =>
        graph.nodes.some((node) => node.id === edge.from) &&
        graph.nodes.some((node) => node.id === edge.to)
      )
    ).toBe(true);
  });

  it("does not leave orphaned nodes after pruning and evidence-node generation", () => {
    const graph = buildLiveClaimGraph({
      question: evidencePack.question,
      claimInventory,
      evidencePack,
      plan
    });
    const connectedNodeIds = new Set<string>(["question_root"]);

    for (const edge of graph.edges) {
      connectedNodeIds.add(edge.from);
      connectedNodeIds.add(edge.to);
    }

    expect(
      graph.nodes.every(
        (node) => node.id === "question_root" || connectedNodeIds.has(node.id)
      )
    ).toBe(true);
    expect(
      graph.nodes.some((node) => node.kind === "evidence")
    ).toBe(true);
  });

  it("keeps public graph copy free of internal artifact terms", () => {
    const graph = buildLiveClaimGraph({
      question: evidencePack.question,
      claimInventory,
      evidencePack,
      plan
    });
    const publicText = JSON.stringify(graph).toLowerCase();

    expect(publicText).not.toContain("claim inventory");
    expect(publicText).not.toContain("evidence pack");
    expect(graph.nodes.find((node) => node.id === "question_root")?.summary).toBe(
      "The root question anchors the source-backed argument map and keeps every branch tied to the question."
    );
  });

  it("prefers a conflict with stronger unresolved dependency pressure when contradiction strength is otherwise close", () => {
    const tunedInventory: ClaimInventory = {
      ...claimInventory,
      contradictionPairs: [
        {
          id: "pair_business",
          leftClaimId: "claim_retail_upside",
          rightClaimId: "counter_retail_downside",
          contradictionStrength: 0.84,
          explanation:
            "Retail upside and retail downside are the sharpest competing interpretations."
        },
        {
          id: "pair_environment",
          leftClaimId: "claim_air",
          rightClaimId: "counter_spill",
          contradictionStrength: 0.86,
          explanation:
            "Cleaner downtown air can conflict with spillover traffic pressure nearby."
        },
        {
          id: "pair_access",
          leftClaimId: "claim_safety",
          rightClaimId: "counter_access",
          contradictionStrength: 0.62,
          explanation:
            "Safety gains can still coexist with accessibility concerns."
        }
      ]
    };

    const tunedPlan: GraphAssemblyPlan = {
      ...plan,
      disagreementClusters: [
        {
          contradictionPairId: "pair_business",
          title: "Do downtown businesses gain or lose?",
          explanation:
            "Retail upside and merchant downside are both grounded and central to the decision.",
          topicRelevance: 0.92
        },
        {
          contradictionPairId: "pair_environment",
          title: "Do emissions fall overall or just move?",
          explanation:
            "Air-quality gains conflict with spillover harms on boundary streets.",
          topicRelevance: 0.88
        },
        {
          contradictionPairId: "pair_access",
          title: "Do safety gains come at an access cost?",
          explanation:
            "Safety gains remain relevant, but access constraints reduce their policy clarity.",
          topicRelevance: 0.56
        }
      ]
    };

    const graph = buildLiveClaimGraph({
      question: evidencePack.question,
      claimInventory: tunedInventory,
      evidencePack,
      plan: tunedPlan
    });

    expect(graph.primaryClusterId).toBe("cluster_pair_business");
    expect(graph.disagreementClusters[0]?.title).toBe(
      "Do downtown businesses gain or lose?"
    );
  });

  it("downranks parallel branches that are not directly opposed even if the plan ranks them aggressively", () => {
    const tunedInventory: ClaimInventory = {
      ...claimInventory,
      contradictionPairs: [
        {
          id: "pair_parallel",
          leftClaimId: "claim_air",
          rightClaimId: "claim_retail_upside",
          contradictionStrength: 0.97,
          explanation:
            "Cleaner air and stronger retail performance are both positive effects, not a direct contradiction."
        },
        ...claimInventory.contradictionPairs
      ]
    };

    const tunedPlan: GraphAssemblyPlan = {
      ...plan,
      disagreementClusters: [
        {
          contradictionPairId: "pair_parallel",
          title: "Do cleaner streets help retail?",
          explanation:
            "This is a broad tradeoff frame, but the branches do not actually oppose each other directly.",
          topicRelevance: 0.97
        },
        ...plan.disagreementClusters
      ]
    };

    const graph = buildLiveClaimGraph({
      question: evidencePack.question,
      claimInventory: tunedInventory,
      evidencePack,
      plan: tunedPlan
    });

    expect(graph.primaryClusterId).toBe("cluster_pair_business");
    expect(graph.disagreementClusters[0]?.title).toBe(
      "Do downtown businesses gain or lose?"
    );
  });

  it("uses persisted pair explanations when planned cluster text leaks artifact ids", () => {
    const graph = buildLiveClaimGraph({
      question: evidencePack.question,
      claimInventory,
      evidencePack,
      plan: {
        ...plan,
        disagreementClusters: [
          {
            contradictionPairId: "pair_business",
            title: "Do downtown businesses gain or lose?",
            explanation:
              "claim_retail_upside emphasizes upside while counter_retail_downside adds a downside.",
            topicRelevance: 0.96
          }
        ]
      }
    });

    expect(graph.disagreementClusters[0]?.explanation).toBe(
      "Retail upside and retail downside are the sharpest competing interpretations."
    );
  });

  it("uses code-computed cluster explanations when both planned and pair text leak artifact ids", () => {
    const graph = buildLiveClaimGraph({
      question: evidencePack.question,
      claimInventory: {
        ...claimInventory,
        contradictionPairs: [
          {
            ...claimInventory.contradictionPairs[0],
            explanation:
              "claim_retail_upside and counter_retail_downside remain the central artifacts."
          }
        ]
      },
      evidencePack,
      plan: {
        ...plan,
        disagreementClusters: [
          {
            contradictionPairId: "pair_business",
            title: "Do downtown businesses gain or lose?",
            explanation:
              "claim_retail_upside emphasizes upside while counter_retail_downside adds a downside.",
            topicRelevance: 0.96
          }
        ]
      }
    });

    expect(graph.disagreementClusters[0]?.explanation).toBe(
      "Walkable streets can lift retail foot traffic conflicts with Some merchants lose convenience-based sales, and both sides retain grounded support in the saved sources."
    );
    expect(graph.disagreementClusters[0]?.explanation).not.toContain("claim_retail_upside");
    expect(graph.disagreementClusters[0]?.explanation).not.toContain("counter_retail_downside");
  });

  it("repairs persisted cluster explanations that leak artifact ids", () => {
    const graph = buildLiveClaimGraph({
      question: evidencePack.question,
      claimInventory,
      evidencePack,
      plan
    });
    const repaired = repairLiveGraphDisagreementClusters({
      graph: {
        ...graph,
        disagreementClusters: graph.disagreementClusters.map((cluster) => ({
          ...cluster,
          title: `${cluster.claimIds[0]} versus ${cluster.claimIds[1]}`,
          explanation: `${cluster.claimIds[0]} conflicts with ${cluster.claimIds[1]}.`
        }))
      },
      claimInventory
    });

    expect(repaired.disagreementClusters[0]?.title).toBe(
      "Disagreement on Business"
    );
    expect(repaired.disagreementClusters[0]?.title).not.toContain("claim_retail_upside");
    expect(repaired.disagreementClusters[0]?.title).not.toContain("counter_retail_downside");
    expect(repaired.disagreementClusters[0]?.explanation).toBe(
      "Walkable streets can lift retail foot traffic conflicts with Some merchants lose convenience-based sales, and both sides retain grounded support in the saved sources."
    );
    expect(repaired.disagreementClusters[0]?.explanation).not.toContain("claim_retail_upside");
    expect(repaired.disagreementClusters[0]?.explanation).not.toContain("counter_retail_downside");
  });

  it("repairs persisted cluster explanations that leak short artifact ids", () => {
    const graph = buildLiveClaimGraph({
      question: evidencePack.question,
      claimInventory,
      evidencePack,
      plan
    });
    const repaired = repairLiveGraphDisagreementClusters({
      graph: {
        ...graph,
        disagreementClusters: graph.disagreementClusters.map((cluster) => ({
          ...cluster,
          explanation:
            "Pay transparency laws (cl_4) create market pressures that threaten internal equity (cl_5)."
        }))
      },
      claimInventory
    });

    expect(repaired.disagreementClusters[0]?.explanation).toBe(
      "Walkable streets can lift retail foot traffic conflicts with Some merchants lose convenience-based sales, and both sides retain grounded support in the saved sources."
    );
    expect(repaired.disagreementClusters[0]?.explanation).not.toContain("cl_4");
    expect(repaired.disagreementClusters[0]?.explanation).not.toContain("cl_5");
  });

  it("uses a code-computed graph summary when planned summary leaks artifact ids", () => {
    const graph = buildLiveClaimGraph({
      question: evidencePack.question,
      claimInventory,
      evidencePack,
      plan: {
        ...plan,
        graphSummary:
          "The strongest disagreement is claim_retail_upside versus counter_retail_downside with gap_loading unresolved."
      }
    });

    expect(graph.graphSummary).toContain(
      "Walkable streets can lift retail foot traffic"
    );
    expect(graph.graphSummary).toContain("Some merchants lose convenience-based sales");
    expect(graph.graphSummary).not.toContain("claim_retail_upside");
    expect(graph.graphSummary).not.toContain("gap_loading");
  });
});
