import { describe, expect, it } from "vitest";
import { assessPublicGraphQuality } from "@/lib/graph/public-quality";
import type { WorkspaceGraphPayload, Source } from "@/types/claimgraph";

type PayloadWithoutRunIdentities = Omit<
  WorkspaceGraphPayload,
  | "latestRun"
  | "activeRun"
  | "graphRun"
  | "latestRunArtifacts"
  | "inProgressArtifacts"
>;

function withRunIdentities(
  payload: PayloadWithoutRunIdentities
): WorkspaceGraphPayload {
  return {
    ...payload,
    latestRun: payload.run,
    activeRun: null,
    graphRun: payload.run,
    latestRunArtifacts: null,
    inProgressArtifacts: null
  };
}

function buildSources(kind: "diverse" | "thin"): Source[] {
  if (kind === "thin") {
    return [
      {
        id: "source_web_1",
        type: "web",
        title: "Commentary roundup",
        url: "https://example-blog.com/commentary",
        domain: "example-blog.com",
        sourceKind: "blog"
      }
    ];
  }

  return [
    {
      id: "source_web_1",
      type: "web",
      title: "Official policy guidance",
      url: "https://agency.gov/policy-guidance",
      domain: "agency.gov",
      sourceKind: "government",
      publishedAt: "2026-01-10",
      isPrimary: true
    },
    {
      id: "source_web_2",
      type: "web",
      title: "University research report",
      url: "https://example.edu/research/report",
      domain: "example.edu",
      sourceKind: "research",
      publishedAt: "2025-12-01",
      isPrimary: true
    },
    {
      id: "source_web_3",
      type: "web",
      title: "Implementation risk analysis",
      url: "https://policy-review.org/implementation-risk",
      domain: "policy-review.org",
      sourceKind: "news",
      publishedAt: "2026-02-03"
    }
  ];
}

function buildWebPayload(input: {
  question: string;
  sourceKind?: "diverse" | "thin";
  score?: number | null;
  includeCounterclaim?: boolean;
}): WorkspaceGraphPayload {
  const sources = buildSources(input.sourceKind ?? "diverse");
  const snippets = sources.map((source, index) => ({
    id: `snippet_${index + 1}`,
    sourceId: source.id,
    text: `${source.title} preserves an inspectable source trail for ${input.question}`,
    rationale: "Saved evidence excerpt from the linked source.",
    relevance: 0.78,
    origin: "web_search_result_excerpt" as const
  }));
  const includeCounterclaim = input.includeCounterclaim ?? true;
  const nodes: WorkspaceGraphPayload["graph"]["nodes"] = [
    {
      id: "question_root",
      kind: "question",
      title: input.question,
      summary: "Root question.",
      sourceIds: [],
      snippetIds: []
    },
    {
      id: "claim_1",
      kind: "claim",
      title: "The proposal has a grounded benefit",
      summary: "The pro branch is grounded in preserved web sources.",
      sourceIds: ["source_web_1"],
      snippetIds: ["snippet_1"]
    }
  ];

  if (includeCounterclaim) {
    nodes.push({
      id: "counterclaim_1",
      kind: "counterclaim",
      title: "The proposal also has a grounded risk",
      summary: "The con branch is grounded in preserved web sources.",
      sourceIds: [sources[1]?.id ?? sources[0].id],
      snippetIds: [snippets[1]?.id ?? snippets[0].id]
    });
  }

  return withRunIdentities({
    workspace: {
      id: `workspace_${input.question.replace(/\W+/g, "_").toLowerCase()}`,
      question: input.question,
      createdAt: "2026-06-18T00:00:00.000Z",
      updatedAt: "2026-06-18T00:00:00.000Z",
      settings: {
        maxWebSources: 8,
        maxFiles: 5,
        freshnessBias: "high",
        preferPrimarySources: true,
        includeOpposingEvidence: true
      },
      sourceUrls: []
    },
    run: {
      id: "run_web",
      workspaceId: "workspace_web",
      status: "completed",
      createdAt: "2026-06-18T00:00:00.000Z",
      completedAt: "2026-06-18T00:01:00.000Z",
      statusMessage: "Web-sourced graph assembly completed."
    },
    graph: {
      question: input.question,
      graphSummary: "The map preserves sourced benefits, risks, and unresolved conditions.",
      primaryClusterId: input.score === null || !includeCounterclaim ? undefined : "cluster_1",
      nodes,
      edges: [],
      disagreementClusters:
        input.score === null || !includeCounterclaim
          ? []
          : [
              {
                id: "cluster_1",
                claimIds: ["claim_1", "counterclaim_1"],
                score: input.score ?? 0.72,
                title: "Benefit versus implementation risk",
                explanation: "The conflict compares grounded upside with grounded risk.",
                sourceIds: sources.map((source) => source.id),
                snippetIds: snippets.map((snippet) => snippet.id)
              }
            ]
    },
    sources,
    snippets,
    files: [],
    evidence: null,
    claimInventory: null,
    starterMode: false,
    runtime: {
      mode: "full",
      provider: "openai",
      liveAnalysisEnabled: true,
      supportsUrlIntake: false,
      supportsWebSearch: true
    },
    graphBuild: {
      origin: "live",
      mode: "full",
      provider: "openai",
      model: "gpt-5.4",
      responseId: "resp_web",
      runId: "run_web"
    }
  });
}

describe("assessPublicGraphQuality", () => {
  it("keeps a strong question-only AI disclosure graph labeled as web-sourced", () => {
    const quality = assessPublicGraphQuality(
      buildWebPayload({
        question: "Should universities require AI-use disclosures?",
        score: 0.72
      })
    );

    expect(quality.label).toBe("Web-sourced graph");
    expect(quality.hasMeaningfulConflict).toBe(true);
  });

  it("marks a one-sided Bali high-rise graph as needing disagreement", () => {
    const quality = assessPublicGraphQuality(
      buildWebPayload({
        question: "Should Bali build high rise buildings?",
        includeCounterclaim: false,
        score: null
      })
    );

    expect(quality.label).toBe("Needs disagreement");
    expect(quality.hasCounterclaims).toBe(false);
  });

  it("downgrades a local policy graph when sources exist but conflict is weak", () => {
    const quality = assessPublicGraphQuality(
      buildWebPayload({
        question: "Should cities restrict scooters downtown?",
        score: 0.52
      })
    );

    expect(quality.label).toBe("Sources found, conflict weak");
    expect(quality.isConflictWeak).toBe(true);
  });

  it("downgrades a controversial social question when grounding is thin", () => {
    const quality = assessPublicGraphQuality(
      buildWebPayload({
        question: "Should governments ban controversial protest movements?",
        sourceKind: "thin",
        score: 0.74
      })
    );

    expect(quality.label).toBe("Thin web grounding");
    expect(quality.isThinGrounding).toBe(true);
  });
});
