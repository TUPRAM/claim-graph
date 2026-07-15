import {
  DefaultContentExtractionAdapter,
  normalizeWhitespace,
  selectRelevantTextBlockPassages
} from "@/lib/open-model/retrieval/content-extraction";
import { DefaultUrlFetchAdapter } from "@/lib/open-model/retrieval/url-fetch";
import type {
  DeterministicRetrievalResult,
  UrlFetchAdapter
} from "@/lib/open-model/retrieval/types";
import type { Snippet, Source } from "@/types/claimgraph";

function extractDomain(url: string) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function classifyWebSource(url: string) {
  const parsed = (() => {
    try {
      return new URL(url);
    } catch {
      return null;
    }
  })();

  if (!parsed) {
    return {
      domain: undefined,
      sourceKind: "other" as const,
      isPrimary: false
    };
  }

  const domain = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();

  if (
    domain.endsWith(".gov") ||
    domain.includes(".gov.") ||
    domain.endsWith(".gc.ca") ||
    domain.endsWith(".gouv.fr") ||
    domain.endsWith(".gov.uk") ||
    domain.endsWith(".europa.eu")
  ) {
    return {
      domain,
      sourceKind: "government" as const,
      isPrimary: true
    };
  }

  if (
    domain.endsWith(".edu") ||
    domain.includes("arxiv.org") ||
    domain.includes("doi.org") ||
    domain.includes("ncbi.nlm.nih.gov") ||
    domain.includes("pubmed.ncbi.nlm.nih.gov") ||
    domain.includes("nature.com") ||
    domain.includes("science.org") ||
    domain.includes("nejm.org") ||
    domain.includes("thelancet.com") ||
    domain.includes("ieee.org") ||
    domain.includes("acm.org") ||
    domain.includes("sciencedirect.com") ||
    domain.includes("springer.com")
  ) {
    return {
      domain,
      sourceKind: "research" as const,
      isPrimary: true
    };
  }

  if (
    domain.includes("un.org") ||
    domain.includes("who.int") ||
    domain.includes("worldbank.org") ||
    domain.includes("oecd.org") ||
    domain.includes("imf.org") ||
    domain.includes("wri.org")
  ) {
    return {
      domain,
      sourceKind: "ngo" as const,
      isPrimary: true
    };
  }

  if (
    domain.includes("medium.com") ||
    domain.includes("substack.com") ||
    domain.startsWith("blog.") ||
    path.startsWith("/blog/")
  ) {
    return {
      domain,
      sourceKind: "blog" as const,
      isPrimary: false
    };
  }

  if (
    domain.includes("nytimes.com") ||
    domain.includes("washingtonpost.com") ||
    domain.includes("reuters.com") ||
    domain.includes("apnews.com") ||
    domain.includes("theguardian.com") ||
    domain.includes("bbc.") ||
    path.startsWith("/news/")
  ) {
    return {
      domain,
      sourceKind: "news" as const,
      isPrimary: false
    };
  }

  if (domain.endsWith(".com") || domain.endsWith(".io") || domain.endsWith(".co")) {
    return {
      domain,
      sourceKind: "company" as const,
      isPrimary: true
    };
  }

  return {
    domain,
    sourceKind: "other" as const,
    isPrimary: false
  };
}

function buildUrlPassageRationale(input: {
  title: string;
  index: number;
}) {
  return input.index === 0
    ? `Deterministically extracted from ${input.title} and ranked against the question.`
    : `Deterministically extracted supporting passage from ${input.title}.`;
}

function qualifyUrlWarning(input: {
  title: string;
  url: string;
  warning: string;
}) {
  return `${input.title} (${input.url}): ${input.warning}`;
}

function redactUrlForWarning(value: string) {
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return "the submitted source URL";
  }
}

function normalizeUrlInput(urls: string[], maxUrls: number) {
  const normalized = Array.from(
    new Set(
      urls
        .map((url) => normalizeWhitespace(url))
        .filter(Boolean)
    )
  );

  return normalized.slice(0, maxUrls);
}

export async function ingestUrlsDeterministically(input: {
  question: string;
  urls: string[];
  maxUrls: number;
  signal?: AbortSignal;
  urlFetchAdapter?: UrlFetchAdapter;
}): Promise<DeterministicRetrievalResult> {
  const urlFetchAdapter = input.urlFetchAdapter ?? new DefaultUrlFetchAdapter();
  const contentExtractionAdapter = new DefaultContentExtractionAdapter();
  const sources: Source[] = [];
  const snippets: Snippet[] = [];
  const warnings: string[] = [];
  const normalizedUrls = normalizeUrlInput(input.urls, input.maxUrls);

  for (const url of normalizedUrls) {
    let fetched;

    try {
      fetched = await urlFetchAdapter.fetch(url, input.signal);
    } catch (error) {
      const safeUrl = redactUrlForWarning(url);
      warnings.push(
        `Failed to fetch ${safeUrl} for deterministic open-model retrieval. ${
          error instanceof Error ? error.message : "Unknown error."
        }`
      );
      continue;
    }

    if (fetched.status < 200 || fetched.status >= 300) {
      warnings.push(
        `Fetching ${url} returned HTTP ${fetched.status}, so it could not contribute grounded snippets.`
      );
      continue;
    }

    const extracted = contentExtractionAdapter.extract({
      url: fetched.resolvedUrl ?? url,
      contentType: fetched.contentType,
      title: fetched.title,
      bodyText: fetched.bodyText
    });
    const sourceUrl = fetched.resolvedUrl ?? url;
    const sourceMetadata = classifyWebSource(sourceUrl);
    const sourceId = `src_url_${sources.length + 1}`;
    const source: Source = {
      id: sourceId,
      type: "web",
      title: extracted.title,
      url: sourceUrl,
      domain: sourceMetadata.domain ?? extractDomain(sourceUrl),
      sourceKind: sourceMetadata.sourceKind,
      ...(sourceMetadata.isPrimary ? { isPrimary: true } : {}),
      ...(extracted.publishedAt ? { publishedAt: extracted.publishedAt } : {})
    };

    sources.push(source);
    warnings.push(
      ...extracted.warnings.map((warning) =>
        qualifyUrlWarning({
          title: source.title,
          url: source.url ?? url,
          warning
        })
      )
    );

    if (!extracted.text) {
      continue;
    }

    const passages = selectRelevantTextBlockPassages({
      question: input.question,
      blocks: extracted.blocks,
      maxPassages: 3
    });

    if (!passages.length) {
      warnings.push(
        `${source.title} preserved some readable text after deterministic URL extraction, but not enough question-relevant passage material to ground a live snippet honestly.`
      );
      continue;
    }

    passages.forEach((passage, index) => {
      snippets.push({
        id: `snp_url_${snippets.length + 1}`,
        sourceId,
        text: passage.text,
        rationale: buildUrlPassageRationale({
          title: source.title,
          index
        }),
        relevance: Number(Math.max(0.55, 0.9 - index * 0.12).toFixed(3)),
        origin: "url_ingest_excerpt",
        offsetStart: passage.offsetStart,
        offsetEnd: passage.offsetEnd
      });
    });
  }

  return {
    sources,
    snippets,
    warnings
  };
}
