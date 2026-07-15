import { zodTextFormat } from "openai/helpers/zod";
import type {
  ParsedResponse,
  ResponseFileSearchToolCall,
  ResponseOutputText
} from "openai/resources/responses/responses";
import {
  buildEvidencePackFromOutline,
  evidenceOutlineSchema,
  type EvidenceOutline
} from "@/lib/pipeline/evidence-pack";
import {
  cleanPublicSnippetText,
  formatPublicSnippetRationale
} from "@/lib/provenance/public-provenance";
import {
  classifySourceTrustTier,
  getCanonicalWebSourceKey,
  getSourceDiversityKey,
  inferWebSourceKind,
  isPrimaryWebSource,
  scoreSourceTrust
} from "@/lib/provenance/source-quality";
import {
  createOpenAIRequestOptions,
  getOpenAIClient,
  OpenAIRequestTimeoutError
} from "@/lib/openai/client";
import type {
  EvidencePack,
  EvidenceGroundingStatus,
  Source,
  Snippet,
  WorkspaceSettings
} from "@/types/claimgraph";

export interface GatheredEvidenceResult {
  model: string;
  responseId: string;
  vectorStoreId?: string;
  evidencePack: EvidencePack;
  groundingStatus: EvidenceGroundingStatus;
}

function createIdFactory(prefix: string) {
  let counter = 0;

  return () => {
    counter += 1;
    return `${prefix}_${counter}`;
  };
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function extractDomain(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readStringField(value: Record<string, unknown>, fields: string[]) {
  for (const field of fields) {
    const candidate = value[field];

    if (typeof candidate === "string") {
      const normalized = normalizeWhitespace(candidate);

      if (normalized) {
        return normalized;
      }
    }
  }

  return undefined;
}

function readUrlField(value: Record<string, unknown>, fields: string[]) {
  const url = readStringField(value, fields);

  if (!url) {
    return undefined;
  }

  try {
    new URL(url);
    return url;
  } catch {
    return undefined;
  }
}

type WebSearchResultCandidate = {
  url: string;
  title?: string;
  publishedAt?: string;
  excerpt?: string;
  summary?: string;
};

type WebSourceStat = {
  source: Source;
  citationCount: number;
  resultCount: number;
  snippets: Snippet[];
  snippetTexts: Set<string>;
};

function extractWebSearchResults(response: ParsedResponse<EvidenceOutline>) {
  const results: WebSearchResultCandidate[] = [];

  for (const item of response.output) {
    if (item.type !== "web_search_call") {
      continue;
    }

    const candidateResults = (item as unknown as Record<string, unknown>).results;

    if (!Array.isArray(candidateResults)) {
      continue;
    }

    candidateResults.forEach((result) => {
      if (!isRecord(result)) {
        return;
      }

      const url = readUrlField(result, ["url", "source_url", "link"]);

      if (!url) {
        return;
      }

      results.push({
        url,
        title: readStringField(result, ["title"]),
        publishedAt: readStringField(result, [
          "published_at",
          "publishedAt",
          "date",
          "date_published"
        ]),
        excerpt: readStringField(result, ["excerpt", "snippet", "text"]),
        summary: readStringField(result, ["summary"])
      });
    });
  }

  return results;
}

function collectOutputTexts(response: ParsedResponse<EvidenceOutline>) {
  const outputTexts: ResponseOutputText[] = [];

  for (const item of response.output) {
    if (item.type !== "message") {
      continue;
    }

    for (const content of item.content) {
      if (content.type === "output_text") {
        outputTexts.push(content);
      }
    }
  }

  return outputTexts;
}

function normalizeWebEvidence(input: {
  response: ParsedResponse<EvidenceOutline>;
  maxWebSources: number;
}) {
  const nextSourceId = createIdFactory("src_web");
  const nextSnippetId = createIdFactory("snp_web");
  const sourceStats = new Map<string, WebSourceStat>();

  function getOrCreateSource(url: string, title?: string, publishedAt?: string) {
    const sourceKey = getCanonicalWebSourceKey(url);
    let sourceStat = sourceStats.get(sourceKey);

    if (!sourceStat) {
      const domain = extractDomain(url);
      const sourceKind = inferWebSourceKind({ url, title, domain });
      const source: Source = {
        id: nextSourceId(),
        type: "web",
        title: title ?? url,
        url,
        domain,
        sourceKind,
        isPrimary: isPrimaryWebSource({ url, title, domain, sourceKind }),
        ...(publishedAt ? { publishedAt } : {})
      };

      sourceStat = {
        source,
        citationCount: 0,
        resultCount: 0,
        snippets: [],
        snippetTexts: new Set()
      };
      sourceStats.set(sourceKey, sourceStat);
    } else {
      const source = sourceStat.source;

      if ((!source.title || source.title === source.url) && title) {
        source.title = title;
      }

      if (!source.publishedAt && publishedAt) {
        source.publishedAt = publishedAt;
      }

      if (!source.sourceKind || source.sourceKind === "other") {
        source.sourceKind = inferWebSourceKind({
          url: source.url,
          title: source.title,
          domain: source.domain
        });
      }

      if (!source.isPrimary) {
        source.isPrimary = isPrimaryWebSource(source);
      }
    }

    return sourceStat.source;
  }

  function pushSnippet(inputSnippet: {
    url: string;
    text?: string;
    rationale: string;
    relevance: number;
    origin: Snippet["origin"];
    offsetStart?: number;
    offsetEnd?: number;
  }) {
    if (!inputSnippet.text) {
      return;
    }

    const cleanedSnippet = cleanPublicSnippetText(inputSnippet.text);
    const text = normalizeWhitespace(cleanedSnippet.text);

    if (!text) {
      return;
    }

    const sourceStat = sourceStats.get(
      getCanonicalWebSourceKey(inputSnippet.url)
    );

    if (!sourceStat) {
      return;
    }

    if (!sourceStat.source.publishedAt && cleanedSnippet.publishedAt) {
      sourceStat.source.publishedAt = cleanedSnippet.publishedAt;
    }

    const snippetKey = text.toLowerCase();

    if (sourceStat.snippetTexts.has(snippetKey)) {
      return;
    }

    sourceStat.snippetTexts.add(snippetKey);
    sourceStat.snippets.push({
      id: nextSnippetId(),
      sourceId: sourceStat.source.id,
      text,
      rationale: formatPublicSnippetRationale(inputSnippet.rationale, inputSnippet.origin),
      relevance: inputSnippet.relevance,
      origin: inputSnippet.origin,
      ...(typeof inputSnippet.offsetStart === "number"
        ? { offsetStart: inputSnippet.offsetStart }
        : {}),
      ...(typeof inputSnippet.offsetEnd === "number"
        ? { offsetEnd: inputSnippet.offsetEnd }
        : {})
    });
  }

  function getSourceRankingScore(sourceStat: WebSourceStat) {
    const strongestSnippetRelevance = sourceStat.snippets.reduce(
      (max, snippet) => Math.max(max, snippet.relevance),
      0
    );

    return (
      sourceStat.citationCount * 0.32 +
      sourceStat.resultCount * 0.16 +
      Math.min(sourceStat.snippets.length, 3) * 0.08 +
      strongestSnippetRelevance * 0.18 +
      scoreSourceTrust(sourceStat.source) * 0.42
    );
  }

  function selectDiverseSources(sourceStatsInput: WebSourceStat[]) {
    const sortedSources = [...sourceStatsInput].sort((left, right) => {
      const scoreDelta = getSourceRankingScore(right) - getSourceRankingScore(left);

      if (Math.abs(scoreDelta) > 0.0001) {
        return scoreDelta;
      }

      return left.source.title.localeCompare(right.source.title);
    });
    const selected: WebSourceStat[] = [];
    const selectedSourceIds = new Set<string>();

    function addMatchingSources(predicate: (sourceStat: WebSourceStat) => boolean) {
      for (const sourceStat of sortedSources) {
        if (selected.length >= input.maxWebSources) {
          return;
        }

        if (selectedSourceIds.has(sourceStat.source.id) || !predicate(sourceStat)) {
          continue;
        }

        selected.push(sourceStat);
        selectedSourceIds.add(sourceStat.source.id);
      }
    }

    addMatchingSources((sourceStat) => {
      const domain = sourceStat.source.domain ?? sourceStat.source.url ?? sourceStat.source.id;
      const diversityKey = getSourceDiversityKey(sourceStat.source);
      const hasDomain = selected.some(
        (item) => (item.source.domain ?? item.source.url ?? item.source.id) === domain
      );
      const hasDiversityClass = selected.some(
        (item) => getSourceDiversityKey(item.source) === diversityKey
      );

      return !hasDomain && !hasDiversityClass;
    });

    addMatchingSources((sourceStat) => {
      const domain = sourceStat.source.domain ?? sourceStat.source.url ?? sourceStat.source.id;

      return !selected.some(
        (item) => (item.source.domain ?? item.source.url ?? item.source.id) === domain
      );
    });

    addMatchingSources(() => true);

    return selected;
  }

  for (const result of extractWebSearchResults(input.response)) {
    const cleanedExcerpt = cleanPublicSnippetText(result.excerpt);
    const cleanedSummary = cleanPublicSnippetText(result.summary);
    getOrCreateSource(
      result.url,
      result.title,
      result.publishedAt ?? cleanedExcerpt.publishedAt ?? cleanedSummary.publishedAt
    );

    const sourceStat = sourceStats.get(getCanonicalWebSourceKey(result.url));

    if (!sourceStat) {
      continue;
    }

    sourceStat.resultCount += 1;

    pushSnippet({
      url: result.url,
      text: result.excerpt,
      rationale: "Preserved from the linked web result.",
      relevance: 0.72,
      origin: "web_search_result_excerpt"
    });

    if (!result.excerpt) {
      pushSnippet({
        url: result.url,
        text: result.summary,
        rationale: "Preserved from the linked web result summary.",
        relevance: 0.66,
        origin: "web_search_result_summary"
      });
    }
  }

  for (const outputText of collectOutputTexts(input.response)) {
    for (const annotation of outputText.annotations) {
      if (annotation.type !== "url_citation") {
        continue;
      }

      const snippetText = normalizeWhitespace(
        outputText.text.slice(annotation.start_index, annotation.end_index)
      );

      if (!snippetText) {
        continue;
      }

      getOrCreateSource(annotation.url, annotation.title);

      const sourceStat = sourceStats.get(getCanonicalWebSourceKey(annotation.url))!;
      sourceStat.citationCount += 1;
      pushSnippet({
        url: annotation.url,
        text: snippetText,
        rationale: "Preserved from a cited web summary attached to the linked source.",
        relevance: 0.7,
        origin: "web_citation_summary_span",
        offsetStart: annotation.start_index,
        offsetEnd: annotation.end_index
      });
    }
  }

  const keptSources = selectDiverseSources(Array.from(sourceStats.values()));
  const keptSourceIds = new Set(keptSources.map((item) => item.source.id));

  return {
    usedWebSearch: input.response.output.some((item) => item.type === "web_search_call"),
    sources: keptSources.map((item) => item.source),
    snippets: keptSources
      .flatMap((item) => item.snippets)
      .filter((snippet) => keptSourceIds.has(snippet.sourceId))
  };
}

function normalizeFileResultName(result: ResponseFileSearchToolCall.Result) {
  if (typeof result.attributes?.original_name === "string") {
    return result.attributes.original_name;
  }

  if (typeof result.filename === "string" && result.filename.trim()) {
    return result.filename;
  }

  return "Uploaded file";
}

function normalizeFileEvidence(response: ParsedResponse<EvidenceOutline>) {
  const nextSourceId = createIdFactory("src_file");
  const nextSnippetId = createIdFactory("snp_file");
  const sourceByKey = new Map<string, Source>();
  const seenSnippets = new Set<string>();
  const snippets: Snippet[] = [];

  for (const item of response.output) {
    if (item.type !== "file_search_call") {
      continue;
    }

    for (const result of item.results ?? []) {
      const displayName = normalizeFileResultName(result);
      const sourceKey =
        (typeof result.attributes?.workspace_file_id === "string"
          ? result.attributes.workspace_file_id
          : null) ??
        result.file_id ??
        displayName;
      let source = sourceByKey.get(sourceKey);

      if (!source) {
        source = {
          id: nextSourceId(),
          type: "file",
          title: displayName,
          fileName: displayName
        };

        sourceByKey.set(sourceKey, source);
      }

      const snippetText = normalizeWhitespace(result.text ?? "");

      if (!snippetText) {
        continue;
      }

      const snippetKey = `${source.id}:${snippetText.toLowerCase()}`;

      if (seenSnippets.has(snippetKey)) {
        continue;
      }

      seenSnippets.add(snippetKey);
      snippets.push({
        id: nextSnippetId(),
        sourceId: source.id,
        text: snippetText,
        rationale: "Retrieved from an uploaded file used for this map.",
        relevance: Math.max(0, Math.min(1, result.score ?? 0.6)),
        origin: "file_search_result"
      });
    }
  }

  return {
    usedFileSearch: response.output.some((item) => item.type === "file_search_call"),
    sources: Array.from(sourceByKey.values()),
    snippets
  };
}

function buildWebSourceQualityWarnings(input: {
  usedWebSearch: boolean;
  sources: Source[];
}) {
  if (!input.usedWebSearch || !input.sources.length) {
    return [] as string[];
  }

  const warnings: string[] = [];
  const webSources = input.sources.filter((source) => source.type === "web");
  const uniqueDomains = new Set(
    webSources
      .map((source) => source.domain)
      .filter((domain): domain is string => Boolean(domain))
  );
  const trustTiers = new Set(webSources.map(classifySourceTrustTier));

  if (webSources.length < 2) {
    warnings.push(
      "Thin web grounding: the web search pass preserved fewer than two reusable web sources."
    );
  }

  if (webSources.length > 1 && uniqueDomains.size <= 1) {
    warnings.push(
      "Thin web grounding: preserved web sources came from one domain, so source diversity is limited."
    );
  }

  if (
    !trustTiers.has("official_policy") &&
    !trustTiers.has("report_research")
  ) {
    warnings.push(
      "Thin web grounding: no official, policy, report, or research-grade source was preserved."
    );
  }

  if (trustTiers.size === 1 && webSources.length >= 3) {
    warnings.push(
      "Source balance limit: preserved web sources mostly came from one source class."
    );
  }

  return warnings;
}

function buildEvidenceResult(input: {
  question: string;
  outline: EvidenceOutline;
  response: ParsedResponse<EvidenceOutline>;
  maxWebSources: number;
  vectorStoreId?: string;
}) {
  const webEvidence = normalizeWebEvidence({
    response: input.response,
    maxWebSources: input.maxWebSources
  });
  const fileEvidence = normalizeFileEvidence(input.response);
  const warnings: string[] = [];

  if (webEvidence.usedWebSearch && webEvidence.sources.length === 0) {
    warnings.push(
      fileEvidence.sources.length
        ? "Limited public evidence found. This evidence pack is grounded mainly in uploaded files."
        : "The web search step ran, but it did not return linked source text that ClaimGraph could preserve."
    );
  }

  warnings.push(
    ...buildWebSourceQualityWarnings({
      usedWebSearch: webEvidence.usedWebSearch,
      sources: webEvidence.sources
    })
  );

  if (input.vectorStoreId && fileEvidence.usedFileSearch && fileEvidence.sources.length === 0) {
    warnings.push(
      "Uploaded files were indexed, but file search did not return any reusable snippets for this run."
    );
  }

  return buildEvidencePackFromOutline({
    question: input.question,
    outline: input.outline,
    sources: [...webEvidence.sources, ...fileEvidence.sources],
    snippets: [...webEvidence.snippets, ...fileEvidence.snippets],
    warnings
  });
}

export function buildEvidencePack(input: {
  question: string;
  outline: EvidenceOutline;
  response: ParsedResponse<EvidenceOutline>;
  maxWebSources: number;
  vectorStoreId?: string;
}) {
  return buildEvidenceResult(input).evidencePack;
}

function buildEvidenceInstructions(input: {
  question: string;
  settings: WorkspaceSettings;
  hasFileSearch: boolean;
}) {
  return [
    "You are the evidence gathering stage for ClaimGraph, a visual argument engine.",
    "Gather a bounded, source-grounded evidence set for the user's question.",
    "Use web search for fresh public evidence.",
    input.hasFileSearch
      ? "Use file search over uploaded documents when it helps answer the question."
      : "No uploaded documents are available for this run.",
    "Return only an evidence outline. Do not extract claims, counterclaims, or graph JSON yet.",
    "Prefer diverse and relevant sources over repeated pages from the same domain.",
    "When web search is used, preserve a balanced source set when available: official or policy sources, reports or research, credible article or commentary sources, and direct stakeholder or context evidence.",
    input.settings.preferPrimarySources
      ? "Prefer primary or official sources when possible."
      : "Use the most relevant sources even if they are not all primary sources.",
    input.settings.includeOpposingEvidence
      ? "Make sure the evidence outline preserves opposing evidence or implementation-risk evidence when it exists."
      : "You may stay concise and focus on the dominant evidence, but do not fabricate agreement.",
    "If available evidence is one-sided, say that clearly in open questions instead of inventing a symmetric debate.",
    "Do not overstate certainty. Open questions are valuable output."
  ].join(" ");
}

function buildEvidencePrompt(input: {
  question: string;
  settings: WorkspaceSettings;
  hasFileSearch: boolean;
}) {
  return [
    `Question: ${input.question}`,
    "",
    "Run settings:",
    `- Max web sources to preserve: ${input.settings.maxWebSources}`,
    `- Freshness bias: ${input.settings.freshnessBias}`,
    `- Include opposing evidence: ${input.settings.includeOpposingEvidence ? "yes" : "no"}`,
    `- Prefer primary sources: ${input.settings.preferPrimarySources ? "yes" : "no"}`,
    `- Uploaded file search available: ${input.hasFileSearch ? "yes" : "no"}`,
    "",
    "Return a concise evidence outline with:",
    "- a short evidence summary",
    "- 3 to 6 subquestions",
    "- 2 to 6 evidence axes",
    "- 1 to 6 open questions",
    "",
    "Source selection targets:",
    "- prioritize primary or official sources when they directly address the question",
    "- include report/research sources when available",
    "- preserve at least one credible opposing or implementation-risk source when available",
    "- avoid letting near-duplicate pages from one domain crowd out disagreement",
    "",
    "Keep the outline grounded in the retrieved evidence only."
  ].join("\n");
}

function getSearchContextSize(freshnessBias: WorkspaceSettings["freshnessBias"]) {
  switch (freshnessBias) {
    case "low":
      return "low" as const;
    case "medium":
      return "medium" as const;
    case "high":
      return "high" as const;
  }
}

export async function gatherEvidence(input: {
  question: string;
  settings: WorkspaceSettings;
  vectorStoreId?: string;
  signal?: AbortSignal;
}): Promise<GatheredEvidenceResult> {
  const client = getOpenAIClient();
  const model = process.env.OPENAI_DEFAULT_MODEL ?? "gpt-5.4";
  const hasFileSearch = Boolean(input.vectorStoreId);
  const request = createOpenAIRequestOptions(input.signal);
  try {
    const requestBody = {
      model,
      instructions: buildEvidenceInstructions({
        question: input.question,
        settings: input.settings,
        hasFileSearch
      }),
      input: buildEvidencePrompt({
        question: input.question,
        settings: input.settings,
        hasFileSearch
      }),
      include: [
        "web_search_call.results",
        "web_search_call.action.sources",
        "file_search_call.results"
      ],
      text: {
        format: zodTextFormat(evidenceOutlineSchema, "claimgraph_evidence_outline")
      },
      tools: [
        {
          type: "web_search",
          search_context_size: getSearchContextSize(input.settings.freshnessBias)
        },
        ...(input.vectorStoreId
          ? [
              {
                type: "file_search" as const,
                vector_store_ids: [input.vectorStoreId],
                max_num_results: Math.min(
                  10,
                  Math.max(4, input.settings.maxFiles * 2)
                )
              }
            ]
          : [])
      ]
    } satisfies Parameters<typeof client.responses.parse>[0];

    const response = await client.responses.parse(requestBody, request.options);
    const outline = response.output_parsed;

    if (!outline) {
      throw new Error("The evidence gathering response did not return a structured outline.");
    }

    const { evidencePack, groundingStatus } = buildEvidenceResult({
      question: input.question,
      outline,
      response,
      maxWebSources: input.settings.maxWebSources,
      vectorStoreId: input.vectorStoreId
    });

    return {
      model,
      responseId: response.id,
      vectorStoreId: input.vectorStoreId,
      evidencePack,
      groundingStatus
    };
  } catch (error) {
    if (request.didTimeout()) {
      throw new OpenAIRequestTimeoutError(
        `Evidence gathering exceeded the configured OpenAI timeout while using ${model}.`,
        Number(process.env.CLAIMGRAPH_OPENAI_TIMEOUT_MS) || 120_000
      );
    }

    throw error;
  } finally {
    request.cleanup();
  }
}
