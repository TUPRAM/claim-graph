import { describe, expect, it } from "vitest";
import { buildEvidencePack } from "@/lib/openai/evidence";

describe("buildEvidencePack", () => {
  it("normalizes cited web and file evidence into a persisted evidence pack", () => {
    const evidencePack = buildEvidencePack({
      question: "Should cities ban cars downtown?",
      outline: {
        summary:
          "The evidence clusters around air quality, retail impact, and transit readiness.",
        subquestions: [
          "How much does air quality improve?",
          "What happens to local retail traffic?",
          "Does transit absorb displaced trips?"
        ],
        evidenceAxes: [
          {
            label: "Environment",
            description: "Air quality and emissions outcomes."
          },
          {
            label: "Business impact",
            description: "Retail foot traffic and sales effects."
          }
        ],
        openQuestions: [
          "How much do results depend on local transit quality?"
        ]
      },
      response: {
        output: [
          {
            id: "ws_1",
            type: "web_search_call",
            status: "completed",
            results: [
              {
                url: "https://example.com/air",
                title: "Air Quality Study",
                excerpt:
                  "\ue200cite\ue202turn2search10\ue201 [wordlim: 200] Published: 2026-03-28; Crawled: last week; NO2 levels fell after pedestrianization in the central corridor.",
                published_at: "2026-03-28"
              },
              {
                url: "https://example.com/retail",
                title: "Retail Foot Traffic Analysis",
                summary: "Several pilots reported higher retail foot traffic after access changes."
              }
            ],
            action: {
              type: "search",
              query: "Should cities ban cars downtown?",
              queries: ["Should cities ban cars downtown?"],
              sources: [
                { type: "url", url: "https://example.com/air" },
                { type: "url", url: "https://example.com/retail" }
              ]
            }
          },
          {
            id: "fs_1",
            type: "file_search_call",
            status: "completed",
            queries: ["downtown retail air quality"],
            results: [
              {
                file_id: "file_123",
                filename: "transport-report.pdf",
                score: 0.92,
                text: "The transport report found lower NO2 levels after the downtown pilot.",
                attributes: {
                  workspace_file_id: "wf_1",
                  original_name: "transport-report.pdf"
                }
              }
            ]
          },
          {
            id: "msg_1",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text:
                  "Air quality improved after pedestrianization. Retail foot traffic also rose in several city-center pilots.",
                annotations: [
                  {
                    type: "url_citation",
                    title: "Air Quality Study",
                    url: "https://example.com/air",
                    start_index: 0,
                    end_index: 43
                  },
                  {
                    type: "url_citation",
                    title: "Retail Foot Traffic Analysis",
                    url: "https://example.com/retail",
                    start_index: 44,
                    end_index: 101
                  }
                ]
              }
            ]
          }
        ]
      } as never,
      maxWebSources: 2,
      vectorStoreId: "vs_123"
    });

    expect(evidencePack.summary).toContain("air quality");
    expect(evidencePack.sources).toHaveLength(3);
    expect(evidencePack.sources.filter((source) => source.type === "web")).toHaveLength(2);
    expect(evidencePack.sources.filter((source) => source.type === "file")).toHaveLength(1);
    expect(evidencePack.snippets).toHaveLength(5);
    expect(evidencePack.groundingStatus).toBe("grounded");
    expect(
      evidencePack.snippets.filter(
        (snippet) => snippet.origin === "web_search_result_excerpt"
      )
    ).toHaveLength(1);
    expect(
      evidencePack.snippets.filter(
        (snippet) => snippet.origin === "web_search_result_summary"
      )
    ).toHaveLength(1);
    expect(
      evidencePack.snippets.filter(
        (snippet) => snippet.origin === "web_citation_summary_span"
      )
    ).toHaveLength(2);
    expect(
      evidencePack.snippets.filter((snippet) => snippet.origin === "file_search_result")
    ).toHaveLength(1);
    expect(evidencePack.sources.find((source) => source.url === "https://example.com/air")).toMatchObject({
      title: "Air Quality Study",
      publishedAt: "2026-03-28"
    });
    expect(
      evidencePack.snippets.find(
        (snippet) => snippet.origin === "web_search_result_excerpt"
      )
    ).toMatchObject({
      text: "NO2 levels fell after pedestrianization in the central corridor."
    });
    expect(evidencePack.snippets.map((snippet) => snippet.text).join(" ")).not.toContain(
      "wordlim"
    );
    expect(evidencePack.snippets.map((snippet) => snippet.rationale).join(" ")).not.toContain(
      "Responses API"
    );
    expect(
      evidencePack.snippets.find(
        (snippet) => snippet.origin === "web_search_result_summary"
      )
    ).toMatchObject({
      text: "Several pilots reported higher retail foot traffic after access changes."
    });
    expect(
      evidencePack.snippets.find(
        (snippet) => snippet.origin === "web_citation_summary_span"
      )
    ).toMatchObject({
      offsetStart: 0,
      offsetEnd: 43
    });
    expect(evidencePack.evidenceAxes[0]?.snippetIds.length).toBeGreaterThan(0);
    expect(evidencePack.openQuestions).toEqual([
      "How much do results depend on local transit quality?"
    ]);
    expect(evidencePack.warnings).toEqual([
      "Thin web grounding: preserved web sources came from one domain, so source diversity is limited."
    ]);
  });

  it("deduplicates web URLs and keeps a more diverse, authoritative source mix", () => {
    const evidencePack = buildEvidencePack({
      question: "Should universities require AI-use disclosures?",
      outline: {
        summary:
          "The evidence spans official guidance, research, and implementation-risk commentary.",
        subquestions: [
          "Which institutions require disclosure?",
          "What risks do critics raise?"
        ],
        evidenceAxes: [
          {
            label: "Policy authority",
            description: "Official or institutional policy sources."
          },
          {
            label: "Implementation risk",
            description: "Sources describing compliance or enforcement concerns."
          }
        ],
        openQuestions: [
          "How much do enforcement burdens vary by institution?"
        ]
      },
      response: {
        output: [
          {
            id: "ws_1",
            type: "web_search_call",
            status: "completed",
            results: [
              {
                url: "https://vendor.example.com/blog/ai-disclosure?utm=one",
                title: "Vendor commentary on AI disclosure",
                excerpt: "Vendor commentary argues disclosure tools can be adopted quickly.",
                published_at: "2026-01-01"
              },
              {
                url: "https://vendor.example.com/blog/ai-disclosure?utm=two",
                title: "Vendor commentary on AI disclosure",
                excerpt: "Vendor commentary argues disclosure tools can be adopted quickly.",
                published_at: "2026-01-01"
              },
              {
                url: "https://education.gov/policy/ai-disclosure-guidance",
                title: "Official AI Disclosure Guidance",
                excerpt: "Official guidance says disclosure can support transparency when rules are clear.",
                published_at: "2026-02-01"
              },
              {
                url: "https://example.edu/research/ai-disclosure-report",
                title: "AI Disclosure Research Report",
                excerpt: "Researchers report that disclosure policies vary by course and assessment type.",
                published_at: "2025-12-12"
              },
              {
                url: "https://policyreview.org/analysis/disclosure-burden",
                title: "Implementation burden analysis",
                excerpt: "Policy reviewers warn disclosure checks can create extra process work.",
                published_at: "2026-03-05"
              }
            ],
            action: {
              type: "search",
              query: "Should universities require AI-use disclosures?"
            }
          }
        ]
      } as never,
      maxWebSources: 3
    });

    const urls = evidencePack.sources.map((source) => source.url ?? "");

    expect(evidencePack.sources).toHaveLength(3);
    expect(urls.some((url) => url.includes("education.gov"))).toBe(true);
    expect(urls.some((url) => url.includes("example.edu"))).toBe(true);
    expect(
      evidencePack.sources.filter((source) =>
        source.url?.includes("vendor.example.com/blog/ai-disclosure")
      )
    ).toHaveLength(1);
    expect(
      evidencePack.sources.find((source) => source.url?.includes("education.gov"))
    ).toMatchObject({
      sourceKind: "government",
      isPrimary: true
    });
    expect(
      evidencePack.sources.find((source) => source.url?.includes("example.edu"))
    ).toMatchObject({
      sourceKind: "research",
      isPrimary: true
    });
    expect(evidencePack.warnings).toEqual([]);
  });

  it("marks thin evidence as insufficient grounding instead of throwing the whole run away", () => {
    const evidencePack = buildEvidencePack({
      question: "Should cities ban cars downtown?",
      outline: {
        summary: "The available search pass raised open questions but preserved no grounded snippets.",
        subquestions: ["What evidence is missing?"],
        evidenceAxes: [],
        openQuestions: ["Which sources directly address local transit readiness?"]
      },
      response: {
        output: [
          {
            id: "ws_1",
            type: "web_search_call",
            status: "completed",
            action: {
              type: "search",
              query: "Should cities ban cars downtown?",
              queries: ["Should cities ban cars downtown?"],
              sources: [{ type: "url", url: "https://example.com/air" }]
            }
          },
          {
            id: "msg_1",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "The model discussed tradeoffs but did not preserve any cited span.",
                annotations: []
              }
            ]
          }
        ]
      } as never,
      maxWebSources: 2
    });

    expect(evidencePack.sources).toEqual([]);
    expect(evidencePack.snippets).toEqual([]);
    expect(evidencePack.groundingStatus).toBe("insufficient_grounding");
    expect(evidencePack.warnings.join(" ")).toContain("No grounded source snippets");
    expect(evidencePack.openQuestions).toEqual([
      "Which sources directly address local transit readiness?"
    ]);
  });
});
