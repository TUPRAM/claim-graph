import { z } from "zod";
import type {
  EvidenceGroundingStatus,
  EvidencePack,
  Snippet,
  Source
} from "@/types/claimgraph";

export const evidenceOutlineSchema = z
  .object({
    summary: z.string().trim().min(1).max(1600),
    subquestions: z.array(z.string().trim().min(1).max(240)).max(6).default([]),
    evidenceAxes: z
      .array(
        z.object({
          label: z.string().trim().min(1).max(120),
          description: z.string().trim().min(1).max(240)
        })
      )
      .max(6)
      .default([]),
    openQuestions: z.array(z.string().trim().min(1).max(240)).max(6).default([])
  })
  .strict();

export type EvidenceOutline = z.infer<typeof evidenceOutlineSchema>;

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function uniqueStrings(values: string[]) {
  return Array.from(
    new Set(values.map((value) => normalizeWhitespace(value)).filter(Boolean))
  );
}

function buildGroundingDiagnostics(input: {
  sources: Source[];
  snippets: Snippet[];
  groundingStatus: EvidenceGroundingStatus;
}) {
  if (input.groundingStatus !== "grounded") {
    return [] as string[];
  }

  const snippetSourceIds = new Set(input.snippets.map((snippet) => snippet.sourceId));
  const groundedSources = input.sources.filter((source) => snippetSourceIds.has(source.id));
  const diagnostics: string[] = [];

  if (input.snippets.length === 1) {
    diagnostics.push(
      "Only one grounded snippet survived deterministic intake for this run. ClaimGraph will keep counterclaims and gaps explicit rather than overstating certainty from a single passage."
    );
  }

  if (input.sources.length > 1 && groundedSources.length === 1) {
    diagnostics.push(
      `Only ${groundedSources[0]?.title ?? "one source"} contributed grounded snippets to this run. The deterministic evidence pack is currently one-sided until more directly relevant evidence survives intake.`
    );
  }

  return diagnostics;
}

function tokenize(value: string) {
  return normalizeWhitespace(value)
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length >= 4);
}

function scoreSnippetMatch(axisText: string, snippet: Snippet, sourceTitle: string) {
  const axisTokens = new Set(tokenize(axisText));
  const snippetTokens = new Set(tokenize(`${snippet.text} ${snippet.rationale} ${sourceTitle}`));
  let overlap = 0;

  for (const token of axisTokens) {
    if (snippetTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap;
}

function assignAxisSnippetIds(
  outline: EvidenceOutline,
  snippets: Snippet[],
  sources: Source[]
) {
  const sourceTitleById = new Map(sources.map((source) => [source.id, source.title]));

  return outline.evidenceAxes.map((axis, index) => {
    const rankedSnippets = snippets
      .map((snippet) => ({
        snippetId: snippet.id,
        score: scoreSnippetMatch(
          `${axis.label} ${axis.description}`,
          snippet,
          sourceTitleById.get(snippet.sourceId) ?? ""
        ),
        relevance: snippet.relevance
      }))
      .sort(
        (left, right) =>
          right.score - left.score || right.relevance - left.relevance
      );

    const positiveMatches = rankedSnippets.filter((item) => item.score > 0);
    const snippetIds = (positiveMatches.length ? positiveMatches : rankedSnippets)
      .slice(0, 3)
      .map((item) => item.snippetId);

    return {
      id: `axis_${index + 1}`,
      label: axis.label,
      description: axis.description,
      snippetIds
    };
  });
}

export function buildEvidencePackFromOutline(input: {
  question: string;
  outline: EvidenceOutline;
  sources: Source[];
  snippets: Snippet[];
  warnings?: string[];
}): {
  evidencePack: EvidencePack;
  groundingStatus: EvidenceGroundingStatus;
} {
  const groundingStatus: EvidenceGroundingStatus =
    input.sources.length > 0 && input.snippets.length > 0
      ? "grounded"
      : "insufficient_grounding";
  const warnings = [...(input.warnings ?? [])];

  if (groundingStatus === "insufficient_grounding") {
    warnings.push(
      "No grounded source snippets were preserved for this run. ClaimGraph will keep the most recent safe graph path and surface the unresolved evidence state instead of fabricating a live graph."
    );
  }

  warnings.push(
    ...buildGroundingDiagnostics({
      sources: input.sources,
      snippets: input.snippets,
      groundingStatus
    })
  );

  return {
    groundingStatus,
    evidencePack: {
      question: input.question,
      summary: input.outline.summary,
      groundingStatus,
      subquestions: uniqueStrings(input.outline.subquestions),
      evidenceAxes: assignAxisSnippetIds(
        input.outline,
        input.snippets,
        input.sources
      ),
      sources: input.sources,
      snippets: input.snippets,
      openQuestions: uniqueStrings(input.outline.openQuestions),
      warnings: uniqueStrings(warnings)
    }
  };
}
