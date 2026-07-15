"use client";

import { SnippetList } from "@/components/sidebar/SnippetList";
import { SourceCard } from "@/components/sidebar/SourceCard";
import { getEvidenceGroundingStatus } from "@/lib/provenance/snippets";
import type { EvidencePackRecord, Run } from "@/types/claimgraph";

function buildStateMessage(run: Run | null, starterMode: boolean) {
  if (!run) {
    return "Run analysis to persist a live evidence pack for this workspace.";
  }

  if (run.errorMessage) {
    return starterMode
      ? `${run.errorMessage} The curated starter graph remains available below.`
      : `${run.errorMessage} The most recent live graph remains visible below.`;
  }

  if (run?.status === "insufficient_evidence") {
    return (
      run.statusMessage ??
      "The run preserved open questions and warnings, but not enough grounded snippets to assemble a trustworthy live graph."
    );
  }

  return (
    run.statusMessage ??
    (starterMode
      ? "The workspace is currently showing the curated starter graph fallback."
      : "The workspace is currently showing a live graph assembled from saved source trails.")
  );
}

export function LiveEvidenceCard({
  evidence,
  run,
  starterMode
}: {
  evidence: EvidencePackRecord | null;
  run: Run | null;
  starterMode: boolean;
}) {
  const sourceCount = evidence?.evidencePack.sources.length ?? 0;
  const snippetCount = evidence?.evidencePack.snippets.length ?? 0;
  const webSourceCount =
    evidence?.evidencePack.sources.filter((source) => source.type === "web").length ?? 0;
  const fileSourceCount =
    evidence?.evidencePack.sources.filter((source) => source.type === "file").length ?? 0;
  const graphVisibilityCopy = run?.errorMessage
    ? starterMode
      ? "The visible graph is currently the curated starter fallback."
      : "The visible graph is the most recent safe live graph, not the unfinished failed run."
    : run?.status === "insufficient_evidence"
      ? "The visible graph is still the most recent safe path because the latest run did not preserve enough grounded evidence."
    : starterMode
      ? "The graph below is currently the curated starter fallback."
      : "The graph below is assembled from saved source trails.";
  const groundingStatus = evidence
    ? getEvidenceGroundingStatus(evidence.evidencePack)
    : null;

  return (
    <section className="content-card workspace-evidence-card">
      <div className="workspace-evidence-card__header">
        <div>
          <p className="eyebrow">Live evidence</p>
          <h2>Persisted evidence pack</h2>
        </div>
        {evidence ? (
          <div className="workspace-evidence-card__meta">
            <span className="pill pill--neutral">{sourceCount} sources</span>
            <span className="pill pill--neutral">{snippetCount} snippets</span>
            <span className="pill pill--neutral">{webSourceCount} web</span>
            <span className="pill pill--neutral">{fileSourceCount} files</span>
            <span className="pill pill--neutral">
              {groundingStatus === "grounded"
                ? "grounded evidence"
                : "insufficient grounding"}
            </span>
          </div>
        ) : null}
      </div>

      <p className={run?.errorMessage ? "error-text" : "muted"}>
        {buildStateMessage(run, starterMode)}
      </p>

      {evidence ? (
        <>
          <p className="workspace-evidence-card__summary">{evidence.evidencePack.summary}</p>
          <p className="muted">
            Gathered with <strong>{evidence.model}</strong> on{" "}
            {new Date(evidence.createdAt).toLocaleString()}. {graphVisibilityCopy}
          </p>

          {evidence.evidencePack.warnings.length ? (
            <div className="workspace-evidence-card__warnings">
              {evidence.evidencePack.warnings.map((warning) => (
                <p key={warning} className="error-text">
                  {warning}
                </p>
              ))}
            </div>
          ) : null}

          {evidence.evidencePack.subquestions.length ? (
            <div className="workspace-evidence-card__section">
              <p className="eyebrow">Subquestions</p>
              <div className="workspace-evidence-card__chips">
                {evidence.evidencePack.subquestions.map((subquestion) => (
                  <span key={subquestion} className="pill pill--neutral">
                    {subquestion}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {evidence.evidencePack.evidenceAxes.length ? (
            <div className="workspace-evidence-card__section">
              <p className="eyebrow">Evidence axes</p>
              <div className="workspace-evidence-card__axis-list">
                {evidence.evidencePack.evidenceAxes.map((axis) => (
                  <article key={axis.id} className="workspace-evidence-card__axis">
                    <h3>{axis.label}</h3>
                    <p>{axis.description}</p>
                    <p className="muted">{axis.snippetIds.length} linked snippets</p>
                  </article>
                ))}
              </div>
            </div>
          ) : null}

          {evidence.evidencePack.openQuestions.length ? (
            <div className="workspace-evidence-card__section">
              <p className="eyebrow">Open questions</p>
              <div className="workspace-evidence-card__open-questions">
                {evidence.evidencePack.openQuestions.map((openQuestion) => (
                  <p key={openQuestion} className="muted">
                    {openQuestion}
                  </p>
                ))}
              </div>
            </div>
          ) : null}

          <div className="workspace-evidence-card__section">
            <p className="eyebrow">Sources</p>
            <div className="source-list">
              {evidence.evidencePack.sources.map((source) => (
                <SourceCard
                  key={source.id}
                  source={source}
                  snippets={evidence.evidencePack.snippets.filter(
                    (snippet) => snippet.sourceId === source.id
                  )}
                />
              ))}
            </div>
          </div>

          <div className="workspace-evidence-card__section">
            <p className="eyebrow">Snippets</p>
            <SnippetList
              snippets={evidence.evidencePack.snippets.slice(0, 8)}
              sources={evidence.evidencePack.sources}
            />
          </div>
        </>
      ) : null}
    </section>
  );
}
