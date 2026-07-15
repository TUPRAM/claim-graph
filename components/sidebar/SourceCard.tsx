import {
  buildSourceReviewFlags,
  formatSourceReference
} from "@/lib/review/citation-context";
import { getPublicSourceKindLabel } from "@/lib/provenance/public-provenance";
import {
  getSourceNoteLimitation,
  isSourceNoteSource
} from "@/lib/provenance/source-notes";
import {
  getStarterDemoSourceNotice,
  isStarterDemoSource
} from "@/lib/provenance/starter-demo";
import type { Snippet, Source } from "@/types/claimgraph";

export function SourceCard({
  source,
  snippets = [],
  snippetCount
}: {
  source: Source;
  snippets?: Snippet[];
  snippetCount?: number;
}) {
  const reviewFlags = buildSourceReviewFlags(source);
  const sourceNote = isSourceNoteSource(source, snippets);
  const sourceNoteLimitation = getSourceNoteLimitation(source, snippets);
  const starterDemoSource = isStarterDemoSource(source, snippets);
  const starterDemoNotice = getStarterDemoSourceNotice(source, snippets);

  return (
    <article className="source-card">
      <div className="source-card__row">
        <h4>{source.title}</h4>
        <div className="source-card__badges">
          <span className="pill pill--neutral">
            {getPublicSourceKindLabel(source)}
          </span>
          {sourceNote ? (
            <span className="pill pill--accent">source note</span>
          ) : null}
          {starterDemoSource ? (
            <span className="pill pill--neutral">sample demo</span>
          ) : null}
          {source.isPrimary ? (
            <span className="pill pill--accent">primary</span>
          ) : null}
        </div>
      </div>

      <p className="source-card__meta">{formatSourceReference(source)}</p>

      <details className="source-card__details">
        <summary>Source details</summary>
        <div>
          <p className="muted">Source id: {source.id}</p>
          {typeof snippetCount === "number" ? (
            <p className="muted">
              Linked snippets: {snippetCount}
            </p>
          ) : null}
          {reviewFlags.length ? (
            <p className="muted">
              Limitations: {reviewFlags.join("; ")}
            </p>
          ) : null}
        </div>
      </details>

      {sourceNoteLimitation ? (
        <p className="source-card__notice">{sourceNoteLimitation}</p>
      ) : null}

      {starterDemoNotice ? (
        <p className="source-card__notice source-card__notice--sample">
          {starterDemoNotice}
        </p>
      ) : null}

      {source.url ? (
        <a className="text-link" href={source.url} target="_blank" rel="noreferrer">
          Open source
        </a>
      ) : null}
    </article>
  );
}
