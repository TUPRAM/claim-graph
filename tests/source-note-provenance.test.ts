import { describe, expect, it } from "vitest";
import {
  buildEvidenceNodeTitle,
  buildSourceNoteLimitationSummary,
  enhanceGraphReviewLabels,
  isSourceNoteSource
} from "@/lib/provenance/source-notes";
import type { ClaimGraph, Snippet, Source } from "@/types/claimgraph";

const source: Source = {
  id: "src_file_1",
  type: "file",
  title: "regulation-risk.md",
  fileName: "regulation-risk.md",
  sourceKind: "memo"
};

const snippet: Snippet = {
  id: "snp_file_ingest_1",
  sourceId: source.id,
  text:
    "Evidence note 1: The speech-side counterclaim is that political ads are highly protected expression.",
  rationale: "Deterministically extracted from the uploaded Markdown file.",
  relevance: 0.88,
  origin: "file_ingest_excerpt"
};

describe("source-note provenance helpers", () => {
  it("detects uploaded source-note material from deterministic evidence-note snippets", () => {
    expect(isSourceNoteSource(source, [snippet])).toBe(true);

    const summary = buildSourceNoteLimitationSummary([source], [snippet]);

    expect(summary?.message).toContain("reviewer-provided notes");
    expect(summary?.message).toContain("not automatically crawled original-page provenance");
  });

  it("builds evidence-node titles from source-note snippet text instead of filenames", () => {
    expect(buildEvidenceNodeTitle({ source, snippet })).toBe(
      "Political ads are highly protected expression"
    );
  });

  it("repairs generic evidence and disagreement labels without changing provenance", () => {
    const graph: ClaimGraph = {
      question: "Should political ads disclose AI use?",
      graphSummary: "summary",
      primaryClusterId: "cluster_1",
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
          title: "Transparency requirements protect voters from deceptive political content",
          summary: "summary",
          sourceIds: [source.id],
          snippetIds: [snippet.id]
        },
        {
          id: "counter_speech",
          kind: "counterclaim",
          title: "Broad AI ad regulation risks chilling protected political speech",
          summary: "summary",
          sourceIds: [source.id],
          snippetIds: [snippet.id]
        },
        {
          id: "evidence_snp_file_ingest_1",
          kind: "evidence",
          title: "regulation-risk.md",
          summary: snippet.text,
          sourceIds: [source.id],
          snippetIds: [snippet.id]
        }
      ],
      edges: [],
      disagreementClusters: [
        {
          id: "cluster_1",
          claimIds: ["claim_disclosure", "counter_speech"],
          score: 0.72,
          title: "Disagreement on Regulation",
          explanation: "Transparency requirements conflict with speech concerns.",
          sourceIds: [source.id],
          snippetIds: [snippet.id]
        }
      ]
    };

    const repairedGraph = enhanceGraphReviewLabels({
      graph,
      sources: [source],
      snippets: [snippet]
    });
    const evidenceNode = repairedGraph.nodes.find((node) => node.kind === "evidence");

    expect(evidenceNode?.title).toBe("Political ads are highly protected expression");
    expect(evidenceNode?.sourceIds).toEqual([source.id]);
    expect(evidenceNode?.snippetIds).toEqual([snippet.id]);
    expect(repairedGraph.disagreementClusters[0]?.title).toContain(
      "Transparency requirements protect voters"
    );
    expect(repairedGraph.disagreementClusters[0]?.title).toContain("vs.");
  });
});
