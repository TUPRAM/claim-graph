import {
  getSnippetOriginDescription,
  getSnippetOriginLabel,
  resolveSnippetOrigin
} from "@/lib/provenance/snippets";
import {
  formatPublicSnippetRationale,
  getSnippetPublicText
} from "@/lib/provenance/public-provenance";
import { getStarterDemoSnippetNotice } from "@/lib/provenance/starter-demo";
import { formatSourceReference } from "@/lib/review/citation-context";
import type { Snippet, Source } from "@/types/claimgraph";

function formatOffset(snippet: Snippet) {
  if (
    typeof snippet.offsetStart !== "number" ||
    typeof snippet.offsetEnd !== "number"
  ) {
    return null;
  }

  return `${snippet.offsetStart}-${snippet.offsetEnd}`;
}

function formatPage(snippet: Snippet) {
  return typeof snippet.pageNumber === "number" ? `${snippet.pageNumber}` : null;
}

function buildSourceMeta(source: Source | undefined, snippet: Snippet) {
  if (!source) {
    return `source / ${snippet.sourceId}`;
  }

  return formatSourceReference(source);
}

function buildExtractionMeta(snippet: Snippet) {
  const items: string[] = [];
  const page = formatPage(snippet);
  const offset = formatOffset(snippet);

  if (snippet.locationLabel) {
    items.push(snippet.locationLabel);
  }

  if (page) {
    items.push(`page ${page}`);
  }

  if (offset) {
    items.push(`offset ${offset}`);
  }

  return items.length ? `Location: ${items.join(" / ")}` : null;
}

export function SnippetList({
  snippets,
  sources = [],
  emptyMessage = "No snippets attached to this node."
}: {
  snippets: Snippet[];
  sources?: Source[];
  emptyMessage?: string;
}) {
  if (!snippets.length) {
    return <p className="muted">{emptyMessage}</p>;
  }

  const sourceById = new Map(sources.map((source) => [source.id, source]));

  return (
    <div className="snippet-list">
      {snippets.map((snippet) => {
        const source = sourceById.get(snippet.sourceId);
        const origin = resolveSnippetOrigin(snippet, source);
        const extractionMeta = buildExtractionMeta(snippet);
        const starterDemoNotice = getStarterDemoSnippetNotice(snippet);
        const snippetText = getSnippetPublicText(snippet);
        const rationale = formatPublicSnippetRationale(snippet.rationale, origin);

        return (
          <article key={snippet.id} className="snippet-card">
            <div className="snippet-card__header">
              <div>
                <p className="snippet-card__source-title">
                  {source?.title ?? snippet.sourceId}
                </p>
                <p className="snippet-card__source-meta">
                  {buildSourceMeta(source, snippet)}
                </p>
              </div>
              <div className="snippet-card__badges">
                <span className="pill pill--neutral">
                  relevance {Math.round(snippet.relevance * 100)}%
                </span>
                <span className="pill pill--neutral">
                  {getSnippetOriginLabel(origin)}
                </span>
              </div>
            </div>
            <p className="snippet-card__text">{snippetText}</p>
            {starterDemoNotice ? (
              <p className="snippet-card__notice">{starterDemoNotice}</p>
            ) : null}
            <p className="snippet-card__meta">
              <strong>Why it matters</strong>
              <span>{rationale}</span>
            </p>
            <details className="snippet-card__trail">
              <summary>Source trail</summary>
              <p>{getSnippetOriginDescription(origin)}</p>
              {extractionMeta ? <p>{extractionMeta}</p> : null}
            </details>
          </article>
        );
      })}
    </div>
  );
}
