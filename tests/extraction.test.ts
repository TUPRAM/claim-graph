import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildClaimInventory,
  extractClaimsWithPro
} from "@/lib/openai/extraction";
import type { EvidencePack } from "@/types/claimgraph";

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
  summary: "Air quality, retail outcomes, and transit readiness are the main axes.",
  subquestions: ["What happens to air quality?"],
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
      url: "https://example.com/air",
      domain: "example.com"
    },
    {
      id: "source_2",
      type: "file",
      title: "Transit Memo",
      fileName: "transit-memo.pdf"
    }
  ],
  snippets: [
    {
      id: "snippet_1",
      sourceId: "source_1",
      text: "NO2 levels fell after the downtown pilot.",
      rationale: "Model-cited web evidence.",
      relevance: 0.92
    },
    {
      id: "snippet_2",
      sourceId: "source_2",
      text: "Transit capacity was uneven across corridors.",
      rationale: "Retrieved from uploaded files.",
      relevance: 0.77
    },
    {
      id: "snippet_3",
      sourceId: "source_2",
      text: "Spillover traffic increased on surrounding streets during the trial.",
      rationale: "Retrieved from uploaded files.",
      relevance: 0.7
    }
  ],
  openQuestions: ["How strong is the retail effect?"],
  warnings: []
};

describe("buildClaimInventory", () => {
  it("deduplicates duplicate claims and gaps while preserving grounded provenance", () => {
    const claimInventory = buildClaimInventory({
      question: evidencePack.question,
      evidencePack,
      rawInventory: {
        question: evidencePack.question,
        claims: [
          {
            id: "claim_1",
            kind: "claim",
            title: "Pedestrianization improves air quality",
            summary: "The evidence points to lower pollution after the downtown pilot.",
            topic: "Environment",
            stance: "pro",
            confidence: 0.71,
            evidenceQuality: "high",
            sourceIds: [],
            snippetIds: ["snippet_1"],
            qualifiers: ["In dense corridors"],
            dependsOnGapIds: ["gap_1"]
          },
          {
            id: "claim_1_dup",
            kind: "claim",
            title: "Pedestrianization improves air quality",
            summary:
              "Air-quality benefits appear strongest where pre-intervention traffic was high.",
            topic: "Environment",
            stance: "pro",
            confidence: 0.64,
            evidenceQuality: "medium",
            sourceIds: ["source_2"],
            snippetIds: ["snippet_2"],
            qualifiers: ["Where traffic is high"],
            dependsOnGapIds: ["gap_1_dup"]
          },
          {
            id: "claim_2",
            kind: "counterclaim",
            title: "Traffic spills into nearby streets",
            summary:
              "Some of the congestion may move outward rather than disappear.",
            topic: "Mobility",
            stance: "con",
            confidence: 0.67,
            evidenceQuality: "medium",
            sourceIds: [],
            snippetIds: ["snippet_3"],
            qualifiers: [],
            dependsOnGapIds: []
          },
          {
            id: "claim_invalid",
            kind: "claim",
            title: "Ungrounded claim",
            summary: "This should be discarded because it has no valid snippet.",
            topic: "Noise",
            stance: "unknown",
            confidence: 0.22,
            evidenceQuality: "low",
            sourceIds: ["source_1"],
            snippetIds: ["missing_snippet"],
            qualifiers: [],
            dependsOnGapIds: []
          }
        ],
        contradictionPairs: [
          {
            id: "pair_1",
            leftClaimId: "claim_1",
            rightClaimId: "claim_2",
            contradictionStrength: 0.88,
            explanation:
              "Cleaner downtown air can coincide with spillover traffic pressure nearby."
          },
          {
            id: "pair_2",
            leftClaimId: "claim_1_dup",
            rightClaimId: "claim_2",
            contradictionStrength: 0.55,
            explanation: "Duplicate contradiction that should collapse into pair_1."
          }
        ],
        unresolvedGaps: [
          {
            id: "gap_1",
            title: "Transit readiness varies",
            summary:
              "The evidence does not settle whether transit can absorb displaced trips everywhere.",
            gapType: "mixed_evidence",
            sourceIds: [],
            snippetIds: ["snippet_2"],
            importance: 0.61
          },
          {
            id: "gap_1_dup",
            title: "Transit readiness varies",
            summary:
              "Transit quality may determine whether the intervention scales cleanly.",
            gapType: "mixed_evidence",
            sourceIds: ["source_1"],
            snippetIds: ["snippet_1"],
            importance: 0.82
          },
          {
            id: "gap_invalid",
            title: "Ungrounded gap",
            summary: "This should be discarded because it has no valid snippet.",
            gapType: "insufficient_evidence",
            sourceIds: ["source_1"],
            snippetIds: ["missing_snippet"],
            importance: 0.22
          }
        ]
      }
    });

    expect(claimInventory.claims).toHaveLength(2);
    expect(claimInventory.unresolvedGaps).toHaveLength(1);
    expect(claimInventory.contradictionPairs).toHaveLength(1);

    const mergedClaim = claimInventory.claims.find(
      (claim) => claim.title === "Pedestrianization improves air quality"
    );

    expect(mergedClaim?.sourceIds).toEqual(["source_1", "source_2"]);
    expect(mergedClaim?.snippetIds).toEqual(["snippet_1", "snippet_2"]);
    expect(mergedClaim?.qualifiers).toEqual([
      "In dense corridors",
      "Where traffic is high",
      "where pre-intervention traffic was high"
    ]);
    expect(mergedClaim?.dependsOnGapIds).toEqual(["gap_1"]);

    const mergedGap = claimInventory.unresolvedGaps[0];

    expect(mergedGap?.id).toBe("gap_1");
    expect(mergedGap?.snippetIds).toEqual(["snippet_2", "snippet_1"]);
    expect(mergedGap?.sourceIds).toEqual(["source_2", "source_1"]);
    expect(mergedGap?.importance).toBe(0.82);

    expect(claimInventory.contradictionPairs[0]).toMatchObject({
      id: "pair_1",
      leftClaimId: "claim_1",
      rightClaimId: "claim_2",
      contradictionStrength: 0.88
    });
    expect(
      claimInventory.claims.every(
        (claim) => claim.sourceIds.length > 0 && claim.snippetIds.length > 0
      )
    ).toBe(true);
    expect(
      claimInventory.unresolvedGaps.every(
        (gap) => gap.sourceIds.length > 0 && gap.snippetIds.length > 0
      )
    ).toBe(true);
  });

  it("normalizes con-stance model outputs into explicit counterclaims", () => {
    const claimInventory = buildClaimInventory({
      question: evidencePack.question,
      evidencePack,
      rawInventory: {
        question: evidencePack.question,
        claims: [
          {
            id: "claim_pro",
            kind: "claim",
            title: "Later school starts improve sleep",
            summary: "The evidence supports better sleep opportunity.",
            topic: "Sleep",
            stance: "pro",
            confidence: 0.8,
            evidenceQuality: "high",
            sourceIds: ["source_1"],
            snippetIds: ["snippet_1"],
            qualifiers: [],
            dependsOnGapIds: []
          },
          {
            id: "claim_con",
            kind: "claim",
            title: "Later school starts complicate transportation",
            summary: "The evidence identifies bus scheduling and activity constraints.",
            topic: "Implementation",
            stance: "con",
            confidence: 0.7,
            evidenceQuality: "medium",
            sourceIds: ["source_2"],
            snippetIds: ["snippet_2"],
            qualifiers: [],
            dependsOnGapIds: []
          }
        ],
        contradictionPairs: [],
        unresolvedGaps: []
      }
    });

    expect(claimInventory.claims.find((claim) => claim.id === "claim_con")).toMatchObject({
      kind: "counterclaim",
      stance: "con"
    });
  });

  it("merges near-duplicate grounded claims when wording differs but the frame is the same", () => {
    const claimInventory = buildClaimInventory({
      question: evidencePack.question,
      evidencePack,
      rawInventory: {
        question: evidencePack.question,
        claims: [
          {
            id: "claim_1",
            kind: "claim",
            title: "Pedestrianization improves air quality",
            summary: "The evidence points to lower pollution after the downtown pilot.",
            topic: "Environment",
            stance: "pro",
            confidence: 0.71,
            evidenceQuality: "high",
            sourceIds: ["source_1"],
            snippetIds: ["snippet_1"],
            qualifiers: ["Inside the pilot zone"],
            dependsOnGapIds: []
          },
          {
            id: "claim_2",
            kind: "claim",
            title: "Air quality improves after pedestrianization",
            summary:
              "Pollution reductions appear strongest where car volumes were highest before the intervention.",
            topic: "Environment policy",
            stance: "pro",
            confidence: 0.67,
            evidenceQuality: "high",
            sourceIds: ["source_1"],
            snippetIds: ["snippet_1"],
            qualifiers: ["Most visible on high-traffic streets"],
            dependsOnGapIds: []
          }
        ],
        contradictionPairs: [],
        unresolvedGaps: []
      }
    });

    expect(claimInventory.claims).toHaveLength(1);
    expect(claimInventory.claims[0]).toMatchObject({
      id: "claim_1",
      title: "Pedestrianization improves air quality",
      sourceIds: ["source_1"],
      snippetIds: ["snippet_1"]
    });
    expect(claimInventory.claims[0]?.qualifiers).toEqual([
      "Inside the pilot zone",
      "Most visible on high-traffic streets",
      "where car volumes were highest before the intervention"
    ]);
    expect(claimInventory.claims[0]?.summary).toContain(
      "Pollution reductions appear strongest"
    );
  });

  it("extracts trailing conditional clauses from titles into qualifiers to keep claims atomic", () => {
    const claimInventory = buildClaimInventory({
      question: evidencePack.question,
      evidencePack,
      rawInventory: {
        question: evidencePack.question,
        claims: [
          {
            id: "claim_1",
            kind: "claim",
            title:
              "Pedestrianization improves air quality when pre-intervention traffic is dense",
            summary:
              "The evidence points to lower pollution after the downtown pilot.",
            topic: "Environment",
            stance: "pro",
            confidence: 0.74,
            evidenceQuality: "high",
            sourceIds: ["source_1"],
            snippetIds: ["snippet_1"],
            qualifiers: [],
            dependsOnGapIds: []
          }
        ],
        contradictionPairs: [],
        unresolvedGaps: []
      }
    });

    expect(claimInventory.claims).toHaveLength(1);
    expect(claimInventory.claims[0]).toMatchObject({
      title: "Pedestrianization improves air quality"
    });
    expect(claimInventory.claims[0]?.qualifiers).toEqual([
      "when pre-intervention traffic is dense"
    ]);
  });

  it("extracts leading scope phrases from titles into qualifiers to keep the core proposition atomic", () => {
    const claimInventory = buildClaimInventory({
      question: evidencePack.question,
      evidencePack,
      rawInventory: {
        question: evidencePack.question,
        claims: [
          {
            id: "claim_1",
            kind: "claim",
            title:
              "In dense downtown corridors, pedestrianization improves air quality",
            summary:
              "The evidence points to lower pollution after the downtown pilot.",
            topic: "Environment",
            stance: "pro",
            confidence: 0.74,
            evidenceQuality: "high",
            sourceIds: ["source_1"],
            snippetIds: ["snippet_1"],
            qualifiers: [],
            dependsOnGapIds: []
          }
        ],
        contradictionPairs: [],
        unresolvedGaps: []
      }
    });

    expect(claimInventory.claims).toHaveLength(1);
    expect(claimInventory.claims[0]).toMatchObject({
      title: "Pedestrianization improves air quality"
    });
    expect(claimInventory.claims[0]?.qualifiers).toEqual([
      "In dense downtown corridors"
    ]);
  });

  it("merges duplicates that differ only by trailing qualifier clauses in the title", () => {
    const claimInventory = buildClaimInventory({
      question: evidencePack.question,
      evidencePack,
      rawInventory: {
        question: evidencePack.question,
        claims: [
          {
            id: "claim_1",
            kind: "claim",
            title:
              "Pedestrianization improves air quality when pre-intervention traffic is dense",
            summary:
              "The evidence points to lower pollution after the downtown pilot.",
            topic: "Environment",
            stance: "pro",
            confidence: 0.74,
            evidenceQuality: "high",
            sourceIds: ["source_1"],
            snippetIds: ["snippet_1"],
            qualifiers: [],
            dependsOnGapIds: []
          },
          {
            id: "claim_2",
            kind: "claim",
            title:
              "Pedestrianization improves air quality where transit alternatives stay credible",
            summary:
              "Air-quality benefits appear after the intervention starts and remain strongest in the pilot area.",
            topic: "Environment",
            stance: "pro",
            confidence: 0.68,
            evidenceQuality: "medium",
            sourceIds: ["source_2"],
            snippetIds: ["snippet_2"],
            qualifiers: [],
            dependsOnGapIds: []
          }
        ],
        contradictionPairs: [],
        unresolvedGaps: []
      }
    });

    expect(claimInventory.claims).toHaveLength(1);
    expect(claimInventory.claims[0]).toMatchObject({
      id: "claim_1",
      title: "Pedestrianization improves air quality",
      sourceIds: ["source_1", "source_2"],
      snippetIds: ["snippet_1", "snippet_2"]
    });
    expect(claimInventory.claims[0]?.qualifiers).toEqual([
      "when pre-intervention traffic is dense",
      "where transit alternatives stay credible"
    ]);
  });

  it("emits conditional summary clauses as qualifiers without stripping the grounded summary text", () => {
    const claimInventory = buildClaimInventory({
      question: evidencePack.question,
      evidencePack,
      rawInventory: {
        question: evidencePack.question,
        claims: [
          {
            id: "claim_1",
            kind: "claim",
            title: "Walkable streets can lift retail foot traffic",
            summary:
              "Footfall can improve where street restrictions are paired with strong transit alternatives.",
            topic: "Business",
            stance: "pro",
            confidence: 0.81,
            evidenceQuality: "high",
            sourceIds: ["source_1"],
            snippetIds: ["snippet_1"],
            qualifiers: [],
            dependsOnGapIds: []
          }
        ],
        contradictionPairs: [],
        unresolvedGaps: []
      }
    });

    expect(claimInventory.claims).toHaveLength(1);
    expect(claimInventory.claims[0]?.title).toBe(
      "Walkable streets can lift retail foot traffic"
    );
    expect(claimInventory.claims[0]?.summary).toContain(
      "Footfall can improve where street restrictions are paired with strong transit alternatives."
    );
    expect(claimInventory.claims[0]?.qualifiers).toEqual([
      "where street restrictions are paired with strong transit alternatives"
    ]);
  });

  it("splits coordinated titles into sibling claims when they express separate atomic outcomes", () => {
    const claimInventory = buildClaimInventory({
      question: "Should schools start later?",
      evidencePack,
      rawInventory: {
        question: "Should schools start later?",
        claims: [
          {
            id: "claim_1",
            kind: "claim",
            title: "Later school start times improve sleep and attendance",
            summary:
              "The evidence links later start times to better-rested students and modest attendance gains.",
            topic: "Student outcomes",
            stance: "pro",
            confidence: 0.79,
            evidenceQuality: "high",
            sourceIds: ["source_1"],
            snippetIds: ["snippet_1"],
            qualifiers: [],
            dependsOnGapIds: []
          }
        ],
        contradictionPairs: [],
        unresolvedGaps: []
      }
    });

    expect(claimInventory.claims).toHaveLength(2);

    const sleepClaim = claimInventory.claims.find(
      (claim) => claim.title === "Later school start times improve sleep"
    );
    const attendanceClaim = claimInventory.claims.find(
      (claim) => claim.title === "Later school start times improve attendance"
    );

    expect(sleepClaim).toMatchObject({
      id: "claim_1",
      sourceIds: ["source_1"],
      snippetIds: ["snippet_1"],
      qualifiers: []
    });
    expect(attendanceClaim).toMatchObject({
      id: "claim_1__split_secondary",
      sourceIds: ["source_1"],
      snippetIds: ["snippet_1"],
      qualifiers: []
    });
  });

  it("preserves object prepositions when splitting coordinated claim titles", () => {
    const claimInventory = buildClaimInventory({
      question: "Should companies default to remote work?",
      evidencePack,
      rawInventory: {
        question: "Should companies default to remote work?",
        claims: [
          {
            id: "claim_1",
            kind: "claim",
            title: "Remote work is supported by worker preferences and task adaptability",
            summary:
              "Remote work is supported by worker preferences and by task adaptability in some roles.",
            topic: "Remote work default",
            stance: "pro",
            confidence: 0.78,
            evidenceQuality: "high",
            sourceIds: ["source_1"],
            snippetIds: ["snippet_1"],
            qualifiers: [],
            dependsOnGapIds: []
          }
        ],
        contradictionPairs: [],
        unresolvedGaps: []
      }
    });

    expect(claimInventory.claims.map((claim) => claim.title).sort()).toEqual(
      [
        "Remote work is supported by task adaptability",
        "Remote work is supported by worker preferences"
      ].sort()
    );
  });

  it("emits secondary outcome clauses from coordinated summaries as qualifiers without rewriting the grounded summary", () => {
    const claimInventory = buildClaimInventory({
      question: "Should apps default to on-device AI when possible?",
      evidencePack,
      rawInventory: {
        question: "Should apps default to on-device AI when possible?",
        claims: [
          {
            id: "claim_1",
            kind: "claim",
            title: "On-device AI can improve privacy",
            summary:
              "On-device AI can improve privacy and lower latency for offline tasks.",
            topic: "Platform tradeoffs",
            stance: "pro",
            confidence: 0.8,
            evidenceQuality: "high",
            sourceIds: ["source_1"],
            snippetIds: ["snippet_1"],
            qualifiers: [],
            dependsOnGapIds: []
          }
        ],
        contradictionPairs: [],
        unresolvedGaps: []
      }
    });

    expect(claimInventory.claims).toHaveLength(1);
    expect(claimInventory.claims[0]?.summary).toBe(
      "On-device AI can improve privacy and lower latency for offline tasks."
    );
    expect(claimInventory.claims[0]?.qualifiers).toEqual([
      "On-device AI can lower latency for offline tasks"
    ]);
  });

  it("splits contrastive summary clauses into a second claim when the title only covers one side", () => {
    const claimInventory = buildClaimInventory({
      question: "Should apps default to on-device AI when possible?",
      evidencePack,
      rawInventory: {
        question: "Should apps default to on-device AI when possible?",
        claims: [
          {
            id: "claim_1",
            kind: "claim",
            title: "On-device AI can improve privacy",
            summary:
              "On-device AI can improve privacy but reduce model quality for complex tasks.",
            topic: "Platform tradeoffs",
            stance: "pro",
            confidence: 0.8,
            evidenceQuality: "high",
            sourceIds: ["source_1"],
            snippetIds: ["snippet_1"],
            qualifiers: [],
            dependsOnGapIds: []
          }
        ],
        contradictionPairs: [],
        unresolvedGaps: []
      }
    });

    expect(claimInventory.claims).toHaveLength(2);

    const privacyClaim = claimInventory.claims.find(
      (claim) => claim.title === "On-device AI can improve privacy"
    );
    const qualityClaim = claimInventory.claims.find(
      (claim) => claim.title === "On-device AI can reduce model quality for complex tasks"
    );

    expect(privacyClaim?.summary).toBe("On-device AI can improve privacy");
    expect(qualityClaim?.summary).toBe(
      "On-device AI can reduce model quality for complex tasks"
    );
    expect(qualityClaim?.id).toBe("claim_1__split_summary");
  });

  it("drops secondary proposition qualifiers when another peer claim already represents that atomic outcome", () => {
    const claimInventory = buildClaimInventory({
      question: "Should apps default to on-device AI when possible?",
      evidencePack,
      rawInventory: {
        question: "Should apps default to on-device AI when possible?",
        claims: [
          {
            id: "claim_1",
            kind: "claim",
            title: "On-device AI can improve privacy and lower latency",
            summary:
              "On-device AI can improve privacy and lower latency for offline tasks.",
            topic: "Platform tradeoffs",
            stance: "pro",
            confidence: 0.8,
            evidenceQuality: "high",
            sourceIds: ["source_1"],
            snippetIds: ["snippet_1"],
            qualifiers: [],
            dependsOnGapIds: []
          },
          {
            id: "claim_2",
            kind: "claim",
            title: "On-device AI can lower latency",
            summary:
              "Latency gains are strongest when the model can execute offline.",
            topic: "Platform tradeoffs",
            stance: "pro",
            confidence: 0.73,
            evidenceQuality: "high",
            sourceIds: ["source_2"],
            snippetIds: ["snippet_2"],
            qualifiers: [],
            dependsOnGapIds: []
          }
        ],
        contradictionPairs: [],
        unresolvedGaps: []
      }
    });

    expect(claimInventory.claims).toHaveLength(2);
    expect(claimInventory.claims[0]).toMatchObject({
      title: "On-device AI can improve privacy"
    });
    expect(claimInventory.claims[0]?.qualifiers).toEqual([]);
    expect(claimInventory.claims[1]).toMatchObject({
      title: "On-device AI can lower latency"
    });
  });

  it("merges repeated split claims by branch instead of collapsing both outcomes into one canonical claim", () => {
    const claimInventory = buildClaimInventory({
      question: "Should apps default to on-device AI when possible?",
      evidencePack,
      rawInventory: {
        question: "Should apps default to on-device AI when possible?",
        claims: [
          {
            id: "claim_1",
            kind: "claim",
            title: "On-device AI can improve privacy and lower latency",
            summary:
              "On-device AI can improve privacy and lower latency for offline tasks.",
            topic: "Platform tradeoffs",
            stance: "pro",
            confidence: 0.8,
            evidenceQuality: "high",
            sourceIds: ["source_1"],
            snippetIds: ["snippet_1"],
            qualifiers: [],
            dependsOnGapIds: []
          },
          {
            id: "claim_2",
            kind: "claim",
            title: "On-device AI can improve privacy and lower latency",
            summary:
              "On-device AI can improve privacy and lower latency when network connectivity is weak.",
            topic: "Platform tradeoffs",
            stance: "pro",
            confidence: 0.74,
            evidenceQuality: "high",
            sourceIds: ["source_2"],
            snippetIds: ["snippet_2"],
            qualifiers: [],
            dependsOnGapIds: []
          }
        ],
        contradictionPairs: [],
        unresolvedGaps: []
      }
    });

    expect(claimInventory.claims).toHaveLength(2);

    const privacyClaim = claimInventory.claims.find(
      (claim) => claim.title === "On-device AI can improve privacy"
    );
    const latencyClaim = claimInventory.claims.find(
      (claim) => claim.title === "On-device AI can lower latency"
    );

    expect(privacyClaim?.sourceIds).toEqual(["source_1", "source_2"]);
    expect(privacyClaim?.snippetIds).toEqual(["snippet_1", "snippet_2"]);
    expect(latencyClaim?.sourceIds).toEqual(["source_1", "source_2"]);
    expect(latencyClaim?.snippetIds).toEqual(["snippet_1", "snippet_2"]);
  });

  it("splits dense summary blobs into up to three sibling claims when a broad wrapper title hides atomic outcomes", () => {
    const claimInventory = buildClaimInventory({
      question: "Should apps default to on-device AI when possible?",
      evidencePack,
      rawInventory: {
        question: "Should apps default to on-device AI when possible?",
        claims: [
          {
            id: "claim_1",
            kind: "claim",
            title: "On-device AI has mixed tradeoffs",
            summary:
              "On-device AI can improve privacy, lower latency for offline tasks, and reduce cloud costs.",
            topic: "Platform tradeoffs",
            stance: "pro",
            confidence: 0.82,
            evidenceQuality: "high",
            sourceIds: ["source_1"],
            snippetIds: ["snippet_1"],
            qualifiers: [],
            dependsOnGapIds: []
          }
        ],
        contradictionPairs: [],
        unresolvedGaps: []
      }
    });

    expect(claimInventory.claims).toHaveLength(3);
    expect(claimInventory.claims.map((claim) => claim.title)).toEqual([
      "On-device AI can improve privacy",
      "On-device AI can lower latency for offline tasks",
      "On-device AI can reduce cloud costs"
    ]);
    expect(claimInventory.claims.map((claim) => claim.id)).toEqual([
      "claim_1",
      "claim_1__split_summary_1",
      "claim_1__split_summary_2"
    ]);
  });

  it("keeps very dense summary blobs as one node when splitting would exceed the readability guardrail", () => {
    const claimInventory = buildClaimInventory({
      question: "Should apps default to on-device AI when possible?",
      evidencePack,
      rawInventory: {
        question: "Should apps default to on-device AI when possible?",
        claims: [
          {
            id: "claim_1",
            kind: "claim",
            title: "On-device AI has mixed tradeoffs",
            summary:
              "On-device AI can improve privacy, lower latency for offline tasks, reduce cloud costs, and require larger local storage budgets.",
            topic: "Platform tradeoffs",
            stance: "pro",
            confidence: 0.82,
            evidenceQuality: "high",
            sourceIds: ["source_1"],
            snippetIds: ["snippet_1"],
            qualifiers: [],
            dependsOnGapIds: []
          }
        ],
        contradictionPairs: [],
        unresolvedGaps: []
      }
    });

    expect(claimInventory.claims).toHaveLength(1);
    expect(claimInventory.claims[0]).toMatchObject({
      title: "On-device AI has mixed tradeoffs",
      summary:
        "On-device AI can improve privacy, lower latency for offline tasks, reduce cloud costs, and require larger local storage budgets."
    });
  });

  it("merges repeated broad-wrapper summary splits by branch instead of duplicating each derived claim", () => {
    const claimInventory = buildClaimInventory({
      question: "Should apps default to on-device AI when possible?",
      evidencePack,
      rawInventory: {
        question: "Should apps default to on-device AI when possible?",
        claims: [
          {
            id: "claim_1",
            kind: "claim",
            title: "On-device AI has mixed tradeoffs",
            summary:
              "On-device AI can improve privacy, lower latency for offline tasks, and reduce cloud costs.",
            topic: "Platform tradeoffs",
            stance: "pro",
            confidence: 0.82,
            evidenceQuality: "high",
            sourceIds: ["source_1"],
            snippetIds: ["snippet_1"],
            qualifiers: [],
            dependsOnGapIds: []
          },
          {
            id: "claim_2",
            kind: "claim",
            title: "On-device AI has mixed tradeoffs",
            summary:
              "On-device AI can improve privacy, lower latency for offline tasks, and reduce cloud costs.",
            topic: "Platform tradeoffs",
            stance: "pro",
            confidence: 0.76,
            evidenceQuality: "high",
            sourceIds: ["source_2"],
            snippetIds: ["snippet_2"],
            qualifiers: [],
            dependsOnGapIds: []
          }
        ],
        contradictionPairs: [],
        unresolvedGaps: []
      }
    });

    expect(claimInventory.claims).toHaveLength(3);

    for (const claim of claimInventory.claims) {
      expect(claim.sourceIds).toEqual(["source_1", "source_2"]);
      expect(claim.snippetIds).toEqual(["snippet_1", "snippet_2"]);
    }
  });

  it("does not merge distinct atomic claims that share the same snippet and topic", () => {
    const schoolEvidencePack: EvidencePack = {
      ...evidencePack,
      question: "Should schools start later?",
      summary: "Sleep, attendance, and transportation tradeoffs are the main axes.",
      evidenceAxes: [
        {
          id: "axis_school",
          label: "Student outcomes",
          description: "Sleep and attendance outcomes.",
          snippetIds: ["snippet_school_1"]
        }
      ],
      sources: [
        {
          id: "source_school_1",
          type: "web",
          title: "School Start Time Study",
          url: "https://example.com/schools"
        }
      ],
      snippets: [
        {
          id: "snippet_school_1",
          sourceId: "source_school_1",
          text: "Later start times were associated with more sleep and modest attendance gains.",
          rationale: "Single study snippet supporting two related but distinct outcomes.",
          relevance: 0.9
        }
      ]
    };

    const claimInventory = buildClaimInventory({
      question: schoolEvidencePack.question,
      evidencePack: schoolEvidencePack,
      rawInventory: {
        question: schoolEvidencePack.question,
        claims: [
          {
            id: "claim_sleep",
            kind: "claim",
            title: "Later school start times improve teen sleep",
            summary:
              "The evidence links later start times to longer sleep duration for students.",
            topic: "Student outcomes",
            stance: "pro",
            confidence: 0.79,
            evidenceQuality: "high",
            sourceIds: ["source_school_1"],
            snippetIds: ["snippet_school_1"],
            qualifiers: [],
            dependsOnGapIds: []
          },
          {
            id: "claim_attendance",
            kind: "claim",
            title: "Later school start times can improve attendance",
            summary:
              "The same study reports a separate attendance gain signal after start times moved later.",
            topic: "Student outcomes",
            stance: "pro",
            confidence: 0.72,
            evidenceQuality: "high",
            sourceIds: ["source_school_1"],
            snippetIds: ["snippet_school_1"],
            qualifiers: [],
            dependsOnGapIds: []
          }
        ],
        contradictionPairs: [],
        unresolvedGaps: []
      }
    });

    expect(claimInventory.claims).toHaveLength(2);
    expect(claimInventory.claims.map((claim) => claim.id)).toEqual([
      "claim_sleep",
      "claim_attendance"
    ]);
  });

  it("infers one conservative contradiction pair for sparse tradeoff evidence when a context-dependent counterclaim is grounded", () => {
    const tradeoffEvidencePack: EvidencePack = {
      question: "Should companies prioritize open models or closed models?",
      summary:
        "Enterprise trust and regulatory constraints point in different directions for open versus closed model adoption.",
      subquestions: ["What supports open-model adoption?"],
      evidenceAxes: [
        {
          id: "axis_tradeoff",
          label: "Product strategy",
          description: "Grounded tradeoff signals across open and closed model adoption.",
          snippetIds: ["snippet_closed", "snippet_regulation"]
        }
      ],
      sources: [
        {
          id: "source_closed",
          type: "web",
          title: "Closed-model enterprise brief",
          url: "https://example.com/closed",
          domain: "example.com"
        },
        {
          id: "source_regulation",
          type: "web",
          title: "Regulatory overview",
          url: "https://example.com/regulation",
          domain: "example.com"
        }
      ],
      snippets: [
        {
          id: "snippet_closed",
          sourceId: "source_closed",
          text: "Closed vendors emphasize enterprise trust and security commitments.",
          rationale: "Grounded closed-model support signal.",
          relevance: 0.81
        },
        {
          id: "snippet_regulation",
          sourceId: "source_regulation",
          text: "Regulatory obligations vary enough that no universal model priority is established.",
          rationale: "Grounded context-dependent counter-signal.",
          relevance: 0.84
        }
      ],
      openQuestions: ["How often do open models satisfy regulated deployment needs?"],
      warnings: []
    };

    const claimInventory = buildClaimInventory({
      question: tradeoffEvidencePack.question,
      evidencePack: tradeoffEvidencePack,
      rawInventory: {
        question: tradeoffEvidencePack.question,
        claims: [
          {
            id: "claim_open",
            kind: "claim",
            title: "Open licensing can speed customization",
            summary: "Open models can make product customization faster for internal teams.",
            topic: "Product strategy",
            stance: "mixed",
            confidence: 0.61,
            evidenceQuality: "medium",
            sourceIds: ["source_closed"],
            snippetIds: ["snippet_closed"],
            qualifiers: [],
            dependsOnGapIds: ["gap_regulated"]
          },
          {
            id: "claim_closed",
            kind: "claim",
            title: "Closed vendors emphasize enterprise trust and security",
            summary:
              "Closed vendors make a narrower case for enterprise trust and security controls.",
            topic: "Product strategy",
            stance: "pro",
            confidence: 0.66,
            evidenceQuality: "low",
            sourceIds: ["source_closed"],
            snippetIds: ["snippet_closed"],
            qualifiers: [],
            dependsOnGapIds: ["gap_regulated"]
          },
          {
            id: "counter_context",
            kind: "counterclaim",
            title: "No universal priority is established",
            summary:
              "The evidence keeps the answer context-dependent because regulatory needs vary across deployments.",
            topic: "Product strategy",
            stance: "mixed",
            confidence: 0.74,
            evidenceQuality: "medium",
            sourceIds: ["source_regulation"],
            snippetIds: ["snippet_regulation"],
            qualifiers: [],
            dependsOnGapIds: ["gap_regulated"]
          }
        ],
        contradictionPairs: [],
        unresolvedGaps: [
          {
            id: "gap_regulated",
            title: "Regulated deployment coverage is unresolved",
            summary:
              "The evidence does not settle how often open-model deployments satisfy regulated controls end to end.",
            gapType: "insufficient_evidence",
            sourceIds: ["source_regulation"],
            snippetIds: ["snippet_regulation"],
            importance: 0.71
          }
        ]
      }
    });

    expect(claimInventory.contradictionPairs).toHaveLength(1);
    expect(claimInventory.contradictionPairs[0]).toMatchObject({
      id: "pair_inferred_claim_closed_counter_context",
      leftClaimId: "claim_closed",
      rightClaimId: "counter_context"
    });
    expect(
      claimInventory.contradictionPairs[0]?.contradictionStrength ?? 0
    ).toBeGreaterThanOrEqual(0.62);
    expect(claimInventory.contradictionPairs[0]?.explanation).toContain(
      "Closed vendors emphasize enterprise trust and security"
    );
  });
});

describe("extractClaimsWithPro", () => {
  beforeEach(() => {
    parseMock.mockReset();
  });

  it("parses a strict submit_claim_inventory function call", async () => {
    parseMock.mockResolvedValue({
      id: "resp_claim_inventory",
      output: [
        {
          id: "fc_1",
          type: "function_call",
          name: "submit_claim_inventory",
          call_id: "call_1",
          arguments: "{}",
          parsed_arguments: {
            question: evidencePack.question,
            claims: [
              {
                id: "claim_1",
                kind: "claim",
                title: "Pedestrianization improves air quality",
                summary: "The evidence points to lower pollution after the downtown pilot.",
                topic: "Environment",
                stance: "pro",
                confidence: 0.71,
                evidenceQuality: "high",
                sourceIds: [],
                snippetIds: ["snippet_1"],
                qualifiers: [],
                dependsOnGapIds: []
              }
            ],
            contradictionPairs: [],
            unresolvedGaps: []
          }
        }
      ]
    });

    const result = await extractClaimsWithPro({
      question: evidencePack.question,
      evidencePack
    });

    expect(parseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.4",
        reasoning: {
          effort: "medium"
        },
        tool_choice: {
          type: "function",
          name: "submit_claim_inventory"
        }
      }),
      expect.objectContaining({
        signal: undefined
      })
    );
    expect(result.responseId).toBe("resp_claim_inventory");
    expect(result.claimInventory.claims).toHaveLength(1);
    expect(result.claimInventory.claims[0]?.sourceIds).toEqual(["source_1"]);
  });

  it("falls back to the raw function-call arguments string when parsed_arguments is malformed", async () => {
    parseMock.mockResolvedValue({
      id: "resp_claim_inventory_arguments",
      output: [
        {
          id: "fc_2",
          type: "function_call",
          name: "submit_claim_inventory",
          call_id: "call_2",
          arguments: JSON.stringify({
            question: evidencePack.question,
            claims: [
              {
                id: "claim_1",
                kind: "claim",
                title: "Pedestrianization improves air quality",
                summary: "The evidence points to lower pollution after the downtown pilot.",
                topic: "Environment",
                stance: "pro",
                confidence: 0.71,
                evidenceQuality: "high",
                sourceIds: [],
                snippetIds: ["snippet_1"],
                qualifiers: [],
                dependsOnGapIds: []
              }
            ],
            contradictionPairs: [],
            unresolvedGaps: []
          }),
          parsed_arguments: {
            id: "fc_2",
            type: "function_call",
            name: "submit_claim_inventory"
          }
        }
      ]
    });

    const result = await extractClaimsWithPro({
      question: evidencePack.question,
      evidencePack
    });

    expect(result.responseId).toBe("resp_claim_inventory_arguments");
    expect(result.claimInventory.claims).toHaveLength(1);
    expect(result.claimInventory.claims[0]?.id).toBe("claim_1");
  });
});
