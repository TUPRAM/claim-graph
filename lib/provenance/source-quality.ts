import type { Source } from "@/types/claimgraph";

export type SourceTrustTier =
  | "official_policy"
  | "report_research"
  | "article_commentary"
  | "unknown_thin";

const OFFICIAL_DOMAIN_PATTERNS = [
  /\.gov$/i,
  /\.gov\./i,
  /\.go\./i,
  /\.gouv\./i,
  /\.gc\.ca$/i,
  /(^|\.)europa\.eu$/i,
  /(^|\.)who\.int$/i,
  /(^|\.)un\.org$/i,
  /(^|\.)worldbank\.org$/i,
  /(^|\.)oecd\.org$/i
];

const RESEARCH_DOMAIN_PATTERNS = [
  /\.edu$/i,
  /\.edu\./i,
  /\.ac\./i,
  /(^|\.)jstor\.org$/i,
  /(^|\.)springer\.com$/i,
  /(^|\.)sciencedirect\.com$/i,
  /(^|\.)ssrn\.com$/i,
  /(^|\.)arxiv\.org$/i,
  /(^|\.)nature\.com$/i,
  /\.nih\.gov$/i
];

const NEWS_DOMAIN_PATTERNS = [
  /(^|\.)reuters\.com$/i,
  /(^|\.)apnews\.com$/i,
  /(^|\.)bbc\.com$/i,
  /(^|\.)bbc\.co\.uk$/i,
  /(^|\.)nytimes\.com$/i,
  /(^|\.)theguardian\.com$/i,
  /(^|\.)economist\.com$/i
];

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function safeUrl(value: string | undefined) {
  if (!value) {
    return null;
  }

  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function normalizeSourceDomain(value: string | undefined) {
  return normalizeWhitespace(value ?? "")
    .toLowerCase()
    .replace(/^www\./, "");
}

export function getSourceHostname(input: {
  url?: string;
  domain?: string;
}) {
  const parsed = safeUrl(input.url);

  if (parsed) {
    return normalizeSourceDomain(parsed.hostname);
  }

  return normalizeSourceDomain(input.domain);
}

function matchesAny(value: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(value));
}

function getSourceText(input: {
  title?: string;
  url?: string;
  domain?: string;
}) {
  return `${input.title ?? ""} ${input.url ?? ""} ${input.domain ?? ""}`;
}

export function inferWebSourceKind(input: {
  title?: string;
  url?: string;
  domain?: string;
}): Source["sourceKind"] {
  const hostname = getSourceHostname(input);
  const text = getSourceText(input);
  const parsed = safeUrl(input.url);
  const path = parsed?.pathname.toLowerCase() ?? "";

  if (
    matchesAny(hostname, OFFICIAL_DOMAIN_PATTERNS) ||
    /\b(government|ministry|department|agency|commission|parliament|congress|regulator|regulatory|official)\b/i.test(text)
  ) {
    return "government";
  }

  if (
    matchesAny(hostname, RESEARCH_DOMAIN_PATTERNS) ||
    /\b(university|college|journal|study|research|paper|working paper|report|survey|review|analysis|edupub|educause)\b/i.test(text)
  ) {
    return "research";
  }

  if (matchesAny(hostname, NEWS_DOMAIN_PATTERNS) || /\b(news|article|opinion|commentary)\b/i.test(text)) {
    return /\b(blog|opinion|commentary)\b/i.test(text) ? "blog" : "news";
  }

  if (/\b(blog|opinion|commentary|editorial)\b/i.test(path) || /\b(blog|opinion|commentary|editorial)\b/i.test(text)) {
    return "blog";
  }

  if (/\b(foundation|institute|association|ngo|nonprofit|non-profit)\b/i.test(text) || hostname.endsWith(".org")) {
    return "ngo";
  }

  if (hostname.endsWith(".com") || hostname.endsWith(".io") || hostname.endsWith(".ai")) {
    return "company";
  }

  return "other";
}

function looksLikePolicy(input: {
  title?: string;
  url?: string;
  domain?: string;
}) {
  return /\b(policy|policies|guidance|guidelines|rule|rules|standard|standards|regulation|regulatory|law|statute|act|ordinance|framework)\b/i.test(
    getSourceText(input)
  );
}

function looksLikeReport(input: {
  title?: string;
  url?: string;
  domain?: string;
}) {
  return /\b(report|study|research|analysis|action plan|white paper|working paper|review|survey|meta-analysis|dataset|statistics)\b/i.test(
    getSourceText(input)
  );
}

export function classifySourceTrustTier(source: Source): SourceTrustTier {
  const sourceKind = source.sourceKind ?? inferWebSourceKind(source);
  const hostname = getSourceHostname(source);

  if (
    sourceKind === "government" ||
    matchesAny(hostname, OFFICIAL_DOMAIN_PATTERNS) ||
    looksLikePolicy(source)
  ) {
    return "official_policy";
  }

  if (
    sourceKind === "research" ||
    sourceKind === "memo" ||
    matchesAny(hostname, RESEARCH_DOMAIN_PATTERNS) ||
    looksLikeReport(source)
  ) {
    return "report_research";
  }

  if (
    sourceKind === "news" ||
    sourceKind === "blog" ||
    sourceKind === "company" ||
    sourceKind === "ngo"
  ) {
    return "article_commentary";
  }

  return "unknown_thin";
}

export function getSourceTrustLabel(source: Source) {
  switch (classifySourceTrustTier(source)) {
    case "official_policy":
      return "official/policy page";
    case "report_research":
      return "report/research";
    case "article_commentary":
      return "article/commentary";
    case "unknown_thin":
      return "unknown/thin metadata";
  }
}

export function scoreSourceTrust(source: Source) {
  switch (classifySourceTrustTier(source)) {
    case "official_policy":
      return 1;
    case "report_research":
      return 0.82;
    case "article_commentary":
      return 0.54;
    case "unknown_thin":
      return 0.22;
  }
}

export function isPrimaryWebSource(input: {
  title?: string;
  url?: string;
  domain?: string;
  sourceKind?: Source["sourceKind"];
}) {
  const tier = classifySourceTrustTier({
    id: "source_candidate",
    type: "web",
    title: input.title ?? input.url ?? "Web source",
    url: input.url,
    domain: input.domain,
    sourceKind: input.sourceKind
  });

  return tier === "official_policy" || tier === "report_research";
}

export function getCanonicalWebSourceKey(url: string) {
  const parsed = safeUrl(url);

  if (!parsed) {
    return normalizeWhitespace(url).toLowerCase();
  }

  parsed.hash = "";
  parsed.search = "";
  parsed.hostname = normalizeSourceDomain(parsed.hostname);
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";

  return parsed.toString().toLowerCase();
}

export function getSourceDiversityKey(source: Source) {
  const domain = getSourceHostname(source);
  const tier = classifySourceTrustTier(source);

  return `${tier}:${domain || source.id}`;
}
