import type { ClaimGraph, GraphNode, Snippet, Source } from "@/types/claimgraph";

export const SOURCE_NOTE_LIMITATION =
  "Uploaded source note: ClaimGraph grounded this source from reviewer-provided notes or a source pack. Any URLs inside the file are source leads; the app did not automatically crawl and verify the original pages for this source record.";

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength: number) {
  const normalized = normalizeWhitespace(value);

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function capitalizeFirst(value: string) {
  const normalized = normalizeWhitespace(value);

  if (!normalized) {
    return normalized;
  }

  return `${normalized.slice(0, 1).toUpperCase()}${normalized.slice(1)}`;
}

function stripEvidenceNoteScaffolding(value: string) {
  let text = normalizeWhitespace(value)
    .replace(/^Evidence note\s+\d+\s*:\s*/i, "")
    .replace(/^The core pro-regulation claim is(?: that)?\s*/i, "")
    .replace(/^The speech-side counterclaim is(?: that)?\s*/i, "")
    .replace(/^The key unresolved gap is(?: that)?\s*/i, "")
    .replace(/^The strongest disagreement is whether\s*/i, "Whether ")
    .replace(/^The same source exposes a major limitation:\s*/i, "")
    .replace(/^The FEC status supports\s*/i, "FEC status supports ");

  const firstSentence = text.match(/^(.+?[.!?])(?:\s|$)/)?.[1];

  if (firstSentence && firstSentence.length >= 12) {
    text = firstSentence;
  }

  return capitalizeFirst(text.replace(/[.;:,]+$/g, ""));
}

function isFilenameLike(value: string) {
  return /\.[a-z0-9]{2,6}$/i.test(normalizeWhitespace(value));
}

export function isSourceNoteSnippet(snippet: Snippet) {
  const text = normalizeWhitespace(snippet.text);
  const rationale = normalizeWhitespace(snippet.rationale);

  return (
    /^Evidence note\s+\d+\s*:/i.test(text) ||
    /^Source basis\s*:/i.test(text) ||
    /source[-\s]?note|source[-\s]?pack|reviewer-provided source/i.test(text) ||
    /source[-\s]?note|source[-\s]?pack|reviewer-provided source/i.test(rationale)
  );
}

export function getSnippetsForSource(source: Source, snippets: Snippet[]) {
  return snippets.filter((snippet) => snippet.sourceId === source.id);
}

export function isSourceNoteSource(source: Source, snippets: Snippet[] = []) {
  if (source.type !== "file") {
    return false;
  }

  const sourceLabel = normalizeWhitespace(
    [source.title, source.fileName].filter(Boolean).join(" ")
  );

  return (
    /source[-_\s]?note|source[-_\s]?pack|reviewer[-_\s]?provided/i.test(sourceLabel) ||
    getSnippetsForSource(source, snippets).some(isSourceNoteSnippet)
  );
}

export function getSourceNoteLimitation(source: Source, snippets: Snippet[] = []) {
  return isSourceNoteSource(source, snippets) ? SOURCE_NOTE_LIMITATION : null;
}

export function buildSourceNoteLimitationSummary(
  sources: Source[],
  snippets: Snippet[]
) {
  const sourceNotes = sources.filter((source) => isSourceNoteSource(source, snippets));

  if (!sourceNotes.length) {
    return null;
  }

  return {
    sourceCount: sourceNotes.length,
    snippetCount: snippets.filter((snippet) =>
      sourceNotes.some((source) => source.id === snippet.sourceId)
    ).length,
    message:
      sourceNotes.length === 1
        ? "This workspace includes 1 uploaded source-note source. It is grounded in reviewer-provided notes or a source pack; any URLs inside that file are source leads, not automatically crawled original-page provenance."
        : `This workspace includes ${sourceNotes.length} uploaded source-note sources. They are grounded in reviewer-provided notes or source packs; any URLs inside those files are source leads, not automatically crawled original-page provenance.`,
    sources: sourceNotes
  };
}

export function buildEvidenceNodeTitle(input: {
  snippet: Snippet;
  source: Source;
}) {
  const snippetTitle = stripEvidenceNoteScaffolding(input.snippet.text);
  const shouldPreferSnippet =
    input.source.type === "file" ||
    isSourceNoteSource(input.source, [input.snippet]);

  if (shouldPreferSnippet && snippetTitle.length >= 16) {
    return truncate(snippetTitle, 90);
  }

  return truncate(
    input.source.title || input.source.fileName || snippetTitle || "Evidence",
    90
  );
}

function shouldReplaceEvidenceTitle(node: GraphNode, source: Source) {
  const current = normalizeWhitespace(node.title).toLowerCase();
  const sourceTitle = normalizeWhitespace(source.title).toLowerCase();
  const fileName = normalizeWhitespace(source.fileName ?? "").toLowerCase();

  return (
    !current ||
    current === "evidence" ||
    current === sourceTitle ||
    Boolean(fileName && current === fileName) ||
    isFilenameLike(node.title)
  );
}

function isGenericClusterTitle(value: string) {
  return /^disagreement on\b/i.test(normalizeWhitespace(value));
}

function buildClusterTitleFromClaims(leftNode: GraphNode, rightNode: GraphNode) {
  return truncate(
    `${truncate(leftNode.title, 62)} vs. ${truncate(rightNode.title, 62)}`,
    160
  );
}

export function enhanceGraphReviewLabels(input: {
  graph: ClaimGraph;
  sources: Source[];
  snippets: Snippet[];
}) {
  const sourceById = new Map(input.sources.map((source) => [source.id, source]));
  const snippetById = new Map(input.snippets.map((snippet) => [snippet.id, snippet]));

  const nodes = input.graph.nodes.map((node): GraphNode => {
    if (node.kind !== "evidence" || node.snippetIds.length !== 1) {
      return node;
    }

    const snippet = snippetById.get(node.snippetIds[0]!);
    const source = node.sourceIds.length === 1 ? sourceById.get(node.sourceIds[0]!) : null;

    if (!snippet || !source || !shouldReplaceEvidenceTitle(node, source)) {
      return node;
    }

    const nextTitle = buildEvidenceNodeTitle({ snippet, source });

    return {
      ...node,
      title: nextTitle,
      metadata: {
        ...(node.metadata ?? {}),
        sourceTitle: source.title,
        evidenceLabelDerivedFrom: "snippet"
      }
    };
  });
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const disagreementClusters = input.graph.disagreementClusters.map((cluster) => {
    if (!isGenericClusterTitle(cluster.title)) {
      return cluster;
    }

    const leftNode = nodeById.get(cluster.claimIds[0]);
    const rightNode = nodeById.get(cluster.claimIds[1]);

    if (!leftNode || !rightNode) {
      return cluster;
    }

    return {
      ...cluster,
      title: buildClusterTitleFromClaims(leftNode, rightNode)
    };
  });

  return {
    ...input.graph,
    nodes,
    disagreementClusters
  };
}
