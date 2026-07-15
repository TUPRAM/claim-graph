import { describe, expect, it } from "vitest";
import { buildStarterDataset, DEFAULT_DEMO_QUESTION } from "@/lib/demo/graph-template";
import {
  buildDeveloperGraphMarkdown,
  buildPublicGraphMarkdown
} from "@/lib/server/export-markdown";
import type { Workspace, WorkspaceGraphPayload } from "@/types/claimgraph";

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

function buildWorkspace(question: string): Workspace {
  return {
    id: "demo",
    question,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    settings: {
      maxWebSources: 8,
      maxFiles: 5,
      freshnessBias: "high",
      preferPrimarySources: true,
      includeOpposingEvidence: true
    },
    sourceUrls: []
  };
}

describe("Markdown export builders", () => {
  it("includes the strongest disagreement, provenance, and starter honesty note", () => {
    const dataset = buildStarterDataset(DEFAULT_DEMO_QUESTION);

    const markdown = buildPublicGraphMarkdown(withRunIdentities({
      workspace: buildWorkspace(DEFAULT_DEMO_QUESTION),
      run: {
        id: "run_demo",
        workspaceId: "demo",
        status: "completed",
        createdAt: new Date().toISOString(),
        statusMessage: "Curated starter graph loaded."
      },
      graph: dataset.graph,
      sources: dataset.sources,
      snippets: dataset.snippets,
      files: [],
      evidence: null,
      claimInventory: null,
      starterMode: true,
      runtime: {
        mode: "demo",
        provider: "starter",
        liveAnalysisEnabled: false,
        supportsUrlIntake: false,
        supportsWebSearch: false
      },
      graphBuild: {
        origin: "starter",
        mode: "demo",
        provider: "starter",
        model: "starter-curated",
        responseId: "starter-curated"
      }
    }));

    expect(markdown).toContain("## Mode");
    expect(markdown).toContain("Sample starter scaffold");
    expect(markdown).toContain("## Starter source notice");
    expect(markdown).toContain("sample starter source");
    expect(markdown).toContain("## Strongest disagreement");
    expect(markdown).toContain("Claim A:");
    expect(markdown).toContain("Relevant disagreement snippets:");
    expect(markdown).toContain("Why it matters:");
    expect(markdown).toContain("## Sources");
  });

  it("keeps protected alpha assessment notes behind the explicit developer builder", () => {
    const payload = withRunIdentities({
      workspace: buildWorkspace("Should cities ban cars downtown?"),
      run: {
        id: "run_live",
        workspaceId: "workspace_live",
        status: "completed",
        createdAt: new Date().toISOString(),
        statusMessage: "Live graph assembly completed."
      },
      graph: {
        question: "Should cities ban cars downtown?",
        graphSummary:
          "The strongest disagreement concerns retail upside versus merchant downside.",
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
            summary: "Footfall can improve where street restrictions are paired with strong alternatives.",
            topic: "Business",
            stance: "pro",
            confidence: 0.84,
            sourceIds: ["source_1"],
            snippetIds: ["snippet_1"]
          },
          {
            id: "counter_downside",
            kind: "counterclaim",
            title: "Some merchants lose convenience-based sales",
            summary: "Pickup-heavy merchants reported losses after access changes.",
            topic: "Business",
            stance: "con",
            confidence: 0.78,
            sourceIds: ["source_2"],
            snippetIds: ["snippet_2"],
            metadata: {
              qualifiers: [
                "This downside signal comes from an internal memo rather than a comparative field study."
              ]
            }
          },
          {
            id: "gap_loading",
            kind: "gap",
            title: "Loading access remains unresolved",
            summary: "Retail outcomes still depend on freight windows and loading access.",
            topic: "Logistics",
            confidence: 0.72,
            sourceIds: ["source_2"],
            snippetIds: ["snippet_2"],
            metadata: {
              gapType: "missing_context",
              importance: 0.72
            }
          }
        ],
        edges: [
          {
            id: "edge_1",
            from: "claim_upside",
            to: "question_root",
            relation: "supports",
            strength: 0.84
          }
        ],
        disagreementClusters: [
          {
            id: "cluster_business",
            claimIds: ["claim_upside", "counter_downside"],
            score: 0.82,
            title: "Do downtown businesses gain or lose?",
            explanation: "Retail upside stays contested by business downside.",
            sourceIds: ["source_1", "source_2"],
            snippetIds: ["snippet_1", "snippet_2"]
          }
        ]
      },
      sources: [
        {
          id: "source_1",
          type: "web",
          title: "Retail Study",
          url: "https://example.com/retail",
          domain: "example.com",
          sourceKind: "research",
          isPrimary: true,
          publishedAt: "2026-04-01"
        },
        {
          id: "source_2",
          type: "file",
          title: "Merchant Memo",
          fileName: "merchant-memo.pdf",
          sourceKind: "memo"
        }
      ],
      snippets: [
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
          text: "Freight windows still constrained merchant access.",
          rationale: "Explains the unresolved logistics gap.",
          relevance: 0.77,
          locationLabel: "footnotes",
          pageNumber: 2,
          offsetStart: 128,
          offsetEnd: 176
        }
      ],
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
        responseId: "resp_live_graph",
        runId: "run_live"
      }
    });

    const markdown = buildDeveloperGraphMarkdown(payload, {
      workspaceId: payload.workspace.id,
      createdAt: "2026-05-08T10:00:00.000Z",
      updatedAt: "2026-05-08T10:00:00.000Z",
      reviewerRole: "product",
      verdict: "useful_with_notes",
      wouldRevisit: true,
      wouldShareExport: true,
      strongestDisagreementRating: 4,
      provenanceTrustRating: 4,
      confusionPoints: "The graph is interpretable, but the downside branch still needs stronger public evidence.",
      blockerNotes: "Only two grounded snippets make the comparison fragile.",
      followUpQuestion: "Would a broader comparative source set change the retail downside branch?"
    }, {
      strongestOnly: true,
      unresolvedOnly: true,
      hiddenKinds: ["evidence"],
      focusClusterId: "cluster_business",
      selectedNodeId: "counter_downside",
      savedReviewStateId: "saved_review_business",
      savedReviewStateLabel: "Do downtown businesses gain or lose? / Claim B",
      reviewBranchFilter: "right",
      reviewSourceFilterId: "source_2",
      reviewSourceFilterLabel: "Merchant Memo"
    });

    expect(markdown).toContain("Source-backed graph with web context");
    expect(markdown).toContain(
      "ClaimGraph combined provided sources with web search results"
    );
    expect(markdown).toContain("## Alpha assessment");
    expect(markdown).toContain("Reviewer role: product");
    expect(markdown).toContain("Verdict: useful with notes");
    expect(markdown).toContain("## Export context");
    expect(markdown).toContain("Focused disagreement mode: on");
    expect(markdown).toContain("Unresolved-only mode: on");
    expect(markdown).toContain("Selected node in the browser view: Some merchants lose convenience-based sales");
    expect(markdown).toContain("Saved review state: Do downtown businesses gain or lose? / Claim B");
    expect(markdown).toContain("Sidebar branch filter: Claim B");
    expect(markdown).toContain("Sidebar source filter: Merchant Memo");
    expect(markdown).toContain("## Focused disagreement review");
    expect(markdown).toContain("### Branch comparison");
    expect(markdown).toContain("### Resolution blockers");
    expect(markdown).toContain("- Claim A: Walkable streets can lift retail foot traffic");
    expect(markdown).toContain("- Unresolved: no direct blocker nodes are attached to this disagreement cluster.");
    expect(markdown).toContain("No dedicated gap nodes are attached to the focused disagreement cluster right now.");
    expect(markdown).toContain("## Major claims");
    expect(markdown).toContain("## What is still unresolved");
    expect(markdown).toContain("### Loading access remains unresolved");
    expect(markdown).toContain("Gap type: missing context");
    expect(markdown).toContain("Gap importance: 72%");
    expect(markdown).toContain("Confidence: 84%");
    expect(markdown).toContain("Qualifiers:");
    expect(markdown).toContain(
      "This downside signal comes from an internal memo rather than a comparative field study."
    );
    expect(markdown).toContain(
      "Review notes: Thin grounding: this node currently depends on one snippet from one source."
    );
    expect(markdown).toContain('Why it matters: Supports the retail upside claim.');
    expect(markdown).toContain("Provenance: source excerpt");
    expect(markdown).toContain("Note: Saved evidence excerpt from the linked source.");
    expect(markdown).toContain("Location: footnotes");
    expect(markdown).toContain("Page: 2");
    expect(markdown).toContain("Offset: 128-176");
    expect(markdown).toContain("Retail Study (report / example.com / published 2026-04-01 / primary)");
    expect(markdown).toContain("Source detail: report / example.com / published 2026-04-01 / primary");

    const publicMarkdown = buildPublicGraphMarkdown(payload, {
      strongestOnly: true,
      selectedNodeId: "counter_downside"
    });

    expect(publicMarkdown).not.toContain("## Alpha assessment");
    expect(publicMarkdown).not.toContain("Reviewer role:");
    expect(publicMarkdown).not.toContain("The graph is interpretable");
    expect(publicMarkdown).not.toContain("Only two grounded snippets");
    expect(publicMarkdown).not.toContain("Would a broader comparative source set");
  });

  it("labels question-only full-mode exports as web-sourced graphs", () => {
    const payload = withRunIdentities({
      workspace: buildWorkspace("Should universities require AI-use disclosures?"),
      run: {
        id: "run_web",
        workspaceId: "workspace_web",
        status: "completed",
        createdAt: new Date().toISOString(),
        statusMessage: "Web-sourced graph assembly completed."
      },
      graph: {
        question: "Should universities require AI-use disclosures?",
        graphSummary:
          "The strongest disagreement concerns transparency benefits versus compliance burden.",
        primaryClusterId: "cluster_web",
        nodes: [
          {
            id: "question_root",
            kind: "question",
            title: "Should universities require AI-use disclosures?",
            summary: "question",
            sourceIds: [],
            snippetIds: []
          },
          {
            id: "claim_transparency",
            kind: "claim",
            title: "Disclosure can improve academic transparency",
            summary:
              "\ue200cite\ue202turn2search10\ue201 [wordlim: 200] Published: last year; Disclosure can help reviewers distinguish AI assistance from original work.",
            sourceIds: ["source_web_1"],
            snippetIds: ["snippet_web_1"]
          },
          {
            id: "counter_burden",
            kind: "counterclaim",
            title: "Disclosure rules can increase compliance burden",
            summary: "Policy design can add administrative work for students and instructors.",
            sourceIds: ["source_web_2"],
            snippetIds: ["snippet_web_2"]
          }
        ],
        edges: [],
        disagreementClusters: [
          {
            id: "cluster_web",
            claimIds: ["claim_transparency", "counter_burden"],
            score: 0.76,
            title: "Transparency benefit versus compliance burden",
            explanation:
              "The map centers the tension between transparency gains and process burden.",
            sourceIds: ["source_web_1", "source_web_2"],
            snippetIds: ["snippet_web_1", "snippet_web_2"]
          }
        ]
      },
      sources: [
        {
          id: "source_web_1",
          type: "web",
          title: "University AI Policy Review",
          url: "https://example.edu/ai-policy",
          domain: "example.edu",
          sourceKind: "research"
        },
        {
          id: "source_web_2",
          type: "web",
          title: "Faculty Guidance On AI Disclosure",
          url: "https://example.edu/faculty-guidance",
          domain: "example.edu",
          sourceKind: "memo"
        }
      ],
      snippets: [
        {
          id: "snippet_web_1",
          sourceId: "source_web_1",
          text:
            "\ue200cite\ue202turn2search10\ue201 [wordlim: 200] Published: last year; Crawled: last week; Several policies frame disclosure as a transparency mechanism.",
          rationale:
            "Preserved directly from the web-search result text returned by the Responses API evidence pass.",
          relevance: 0.82,
          origin: "web_search_result_excerpt"
        },
        {
          id: "snippet_web_2",
          sourceId: "source_web_2",
          text: "Faculty guidance warns that disclosure review can create extra process work.",
          rationale: "Preserved from model-cited web summary text.",
          relevance: 0.78,
          origin: "web_citation_summary_span"
        }
      ],
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
        responseId: "resp_web_graph",
        runId: "run_web"
      }
    });

    const markdown = buildPublicGraphMarkdown(payload);

    expect(markdown).toContain("Web-sourced graph");
    expect(markdown).toContain(
      "ClaimGraph generated this map from web search results"
    );
    expect(markdown).toContain("## Graph quality");
    expect(markdown).toContain("Thin web grounding");
    expect(markdown).not.toContain("Graph complete");
    expect(markdown).toContain("University AI Policy Review");
    expect(markdown).toContain(
      "Several policies frame disclosure as a transparency mechanism."
    );
    expect(markdown).not.toContain("wordlim");
    expect(markdown).not.toContain("turn2search10");
    expect(markdown).not.toContain("web-search result text");
    expect(markdown).not.toContain("Responses API");
    expect(markdown).not.toContain("Published: last year");
  });

  it("calls out uploaded source-note limitations in markdown exports", () => {
    const payload = withRunIdentities({
      workspace: buildWorkspace("Should political ads disclose AI use?"),
      run: {
        id: "run_source_note",
        workspaceId: "workspace_source_note",
        status: "completed",
        createdAt: new Date().toISOString()
      },
      graph: {
        question: "Should political ads disclose AI use?",
        nodes: [
          {
            id: "question_root",
            kind: "question",
            title: "Should political ads disclose AI use?",
            summary: "question",
            sourceIds: [],
            snippetIds: []
          },
          {
            id: "claim_disclosure",
            kind: "claim",
            title: "Transparency requirements protect voters",
            summary: "Disclosure can help voters interpret deceptive AI-generated ads.",
            sourceIds: ["source_note_1"],
            snippetIds: ["snippet_note_1"]
          },
          {
            id: "evidence_note_1",
            kind: "evidence",
            title: "fcc-disclosure-scope.md",
            summary: "Evidence note 1: The FCC proposal focuses on disclosure.",
            sourceIds: ["source_note_1"],
            snippetIds: ["snippet_note_1"]
          }
        ],
        edges: [],
        disagreementClusters: [],
        graphSummary:
          "The graph preserves the uploaded source-note limitation explicitly."
      },
      sources: [
        {
          id: "source_note_1",
          type: "file",
          title: "fcc-disclosure-scope.md",
          fileName: "fcc-disclosure-scope.md",
          sourceKind: "memo"
        }
      ],
      snippets: [
        {
          id: "snippet_note_1",
          sourceId: "source_note_1",
          text:
            "Evidence note 1: The FCC proposal focuses on disclosure for AI-generated political ads on TV and radio.",
          rationale: "Deterministically extracted from the uploaded Markdown file.",
          relevance: 0.86,
          origin: "file_ingest_excerpt"
        }
      ],
      files: [],
      evidence: null,
      claimInventory: null,
      starterMode: false,
      runtime: {
        mode: "open-model",
        provider: "open-model",
        liveAnalysisEnabled: true,
        supportsUrlIntake: true,
        supportsWebSearch: false
      },
      graphBuild: {
        origin: "live",
        mode: "open-model",
        provider: "open-model",
        backend: "ollama",
        model: "qwen3:8b",
        runId: "run_source_note"
      }
    });

    const markdown = buildPublicGraphMarkdown(payload);

    expect(markdown).toContain("## Source limitations");
    expect(markdown).toContain("reviewer-provided notes or a source pack");
    expect(markdown).toContain("not automatically crawled original-page provenance");
    expect(markdown).toContain("Source limitation: Uploaded source note");
  });
});
