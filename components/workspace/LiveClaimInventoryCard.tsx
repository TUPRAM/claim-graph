"use client";

import { SnippetList } from "@/components/sidebar/SnippetList";
import type {
  ClaimInventoryRecord,
  ClaimUnit,
  ContradictionPair,
  EvidencePackRecord,
  GapUnit,
  Run
} from "@/types/claimgraph";

function buildStateMessage(
  run: Run | null,
  claimInventory: ClaimInventoryRecord | null,
  starterMode: boolean
) {
  if (run?.errorMessage) {
    return starterMode
      ? `${run.errorMessage} The curated starter graph remains available below.`
      : `${run.errorMessage} The most recent safe graph remains visible below.`;
  }

  if (claimInventory) {
    return starterMode
      ? "Claims were extracted from the persisted evidence pack. The workspace is still showing the curated starter graph fallback."
      : "Claims were extracted from the persisted evidence pack, and the graph below is assembled live from that saved inventory.";
  }

  if (run?.status === "insufficient_evidence") {
    return (
      run.statusMessage ??
      "Claim extraction was skipped because the saved evidence pack did not preserve enough grounded snippets for a trustworthy live graph."
    );
  }

  if (!run) {
    return "Run analysis to persist a live claim inventory derived from the saved evidence pack.";
  }

  return (
    run.statusMessage ??
    (starterMode
      ? "The workspace will keep the curated starter graph visible until live graph assembly succeeds."
      : "The workspace is currently showing the most recent live graph.")
  );
}

function getSourceTitles(sourceIds: string[], evidence: EvidencePackRecord | null) {
  const sourceById = new Map(
    (evidence?.evidencePack.sources ?? []).map((source) => [source.id, source.title])
  );

  return sourceIds
    .map((sourceId) => sourceById.get(sourceId) ?? null)
    .filter((title): title is string => Boolean(title));
}

function getSnippets(snippetIds: string[], evidence: EvidencePackRecord | null) {
  const snippetById = new Map(
    (evidence?.evidencePack.snippets ?? []).map((snippet) => [snippet.id, snippet])
  );

  return snippetIds
    .map((snippetId) => snippetById.get(snippetId) ?? null)
    .filter(
      (
        snippet
      ): snippet is EvidencePackRecord["evidencePack"]["snippets"][number] =>
        Boolean(snippet)
    )
    .slice(0, 2);
}

function getClaimTitle(
  pair: ContradictionPair,
  claimById: Map<string, ClaimUnit>,
  side: "left" | "right"
) {
  const claimId = side === "left" ? pair.leftClaimId : pair.rightClaimId;
  return claimById.get(claimId)?.title ?? claimId;
}

function ClaimCard({
  claim,
  evidence
}: {
  claim: ClaimUnit;
  evidence: EvidencePackRecord | null;
}) {
  const sourceTitles = getSourceTitles(claim.sourceIds, evidence);
  const snippets = getSnippets(claim.snippetIds, evidence);

  return (
    <article className="claim-inventory-card__item">
      <div className="claim-inventory-card__header">
        <div>
          <p className="claim-inventory-card__title">{claim.title}</p>
          <p className="muted">
            {claim.topic} / {Math.round(claim.confidence * 100)}% confidence
          </p>
        </div>
        <div className="claim-inventory-card__chips">
          <span className="pill pill--neutral">{claim.kind}</span>
          <span className="pill pill--neutral">{claim.stance}</span>
          <span className="pill pill--neutral">{claim.evidenceQuality} evidence</span>
        </div>
      </div>

      <p>{claim.summary}</p>

      {claim.qualifiers.length ? (
        <div className="claim-inventory-card__section">
          <p className="eyebrow">Qualifiers</p>
          <div className="workspace-evidence-card__chips">
            {claim.qualifiers.map((qualifier) => (
              <span key={qualifier} className="pill pill--neutral">
                {qualifier}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {claim.dependsOnGapIds.length ? (
        <p className="muted">
          Depends on {claim.dependsOnGapIds.length} unresolved gap
          {claim.dependsOnGapIds.length === 1 ? "" : "s"}.
        </p>
      ) : null}

      {sourceTitles.length ? (
        <div className="claim-inventory-card__section">
          <p className="eyebrow">Linked sources</p>
          <div className="workspace-evidence-card__chips">
            {sourceTitles.map((title) => (
              <span key={title} className="pill pill--neutral">
                {title}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="claim-inventory-card__section">
        <p className="eyebrow">Linked snippets</p>
        <SnippetList snippets={snippets} sources={evidence?.evidencePack.sources ?? []} />
      </div>
    </article>
  );
}

function GapCard({
  gap,
  evidence
}: {
  gap: GapUnit;
  evidence: EvidencePackRecord | null;
}) {
  const sourceTitles = getSourceTitles(gap.sourceIds, evidence);
  const snippets = getSnippets(gap.snippetIds, evidence);

  return (
    <article className="claim-inventory-card__item">
      <div className="claim-inventory-card__header">
        <div>
          <p className="claim-inventory-card__title">{gap.title}</p>
          <p className="muted">
            {gap.gapType.replaceAll("_", " ")} / {Math.round(gap.importance * 100)}%
            {" "}importance
          </p>
        </div>
      </div>

      <p>{gap.summary}</p>

      {sourceTitles.length ? (
        <div className="claim-inventory-card__section">
          <p className="eyebrow">Linked sources</p>
          <div className="workspace-evidence-card__chips">
            {sourceTitles.map((title) => (
              <span key={title} className="pill pill--neutral">
                {title}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="claim-inventory-card__section">
        <p className="eyebrow">Linked snippets</p>
        <SnippetList snippets={snippets} sources={evidence?.evidencePack.sources ?? []} />
      </div>
    </article>
  );
}

export function LiveClaimInventoryCard({
  claimInventory,
  evidence,
  run,
  starterMode
}: {
  claimInventory: ClaimInventoryRecord | null;
  evidence: EvidencePackRecord | null;
  run: Run | null;
  starterMode: boolean;
}) {
  const claimCount = claimInventory?.claimInventory.claims.length ?? 0;
  const contradictionCount =
    claimInventory?.claimInventory.contradictionPairs.length ?? 0;
  const gapCount = claimInventory?.claimInventory.unresolvedGaps.length ?? 0;
  const claimById = new Map(
    (claimInventory?.claimInventory.claims ?? []).map((claim) => [claim.id, claim])
  );
  const graphVisibilityCopy = run?.errorMessage
    ? starterMode
      ? "The visible graph is currently the curated starter fallback."
      : "The visible graph is the most recent safe live graph, not the unfinished failed run."
    : run?.status === "insufficient_evidence"
      ? "The visible graph stayed on the most recent safe path because the latest run did not preserve enough grounded evidence."
    : starterMode
      ? "The visible graph is currently the curated starter fallback."
      : "The visible graph is assembled live from this saved inventory.";

  return (
    <section className="content-card workspace-evidence-card">
      <div className="workspace-evidence-card__header">
        <div>
          <p className="eyebrow">Live claim inventory</p>
          <h2>Persisted contradiction analysis</h2>
        </div>
        {claimInventory ? (
          <div className="workspace-evidence-card__meta">
            <span className="pill pill--neutral">{claimCount} claims</span>
            <span className="pill pill--neutral">
              {contradictionCount} contradictions
            </span>
            <span className="pill pill--neutral">{gapCount} gaps</span>
          </div>
        ) : null}
      </div>

      <p className={run?.errorMessage ? "error-text" : "muted"}>
        {buildStateMessage(run, claimInventory, starterMode)}
      </p>

      {claimInventory ? (
        <>
          <p className="muted">
            Extracted with <strong>{claimInventory.model}</strong> on{" "}
            {new Date(claimInventory.createdAt).toLocaleString()} from the saved
            evidence pack. {graphVisibilityCopy}
          </p>

          <div className="workspace-evidence-card__section">
            <p className="eyebrow">Claims and counterclaims</p>
            <div className="claim-inventory-card__list">
              {claimInventory.claimInventory.claims.map((claim) => (
                <ClaimCard key={claim.id} claim={claim} evidence={evidence} />
              ))}
            </div>
          </div>

          <div className="workspace-evidence-card__section">
            <p className="eyebrow">Contradiction pairs</p>
            <div className="claim-inventory-card__list">
              {claimInventory.claimInventory.contradictionPairs.length ? (
                claimInventory.claimInventory.contradictionPairs.map((pair) => (
                  <article key={pair.id} className="claim-inventory-card__item">
                    <div className="claim-inventory-card__header">
                      <p className="claim-inventory-card__title">
                        {getClaimTitle(pair, claimById, "left")} vs{" "}
                        {getClaimTitle(pair, claimById, "right")}
                      </p>
                      <span className="pill pill--neutral">
                        {Math.round(pair.contradictionStrength * 100)}% strength
                      </span>
                    </div>
                    <p>{pair.explanation}</p>
                  </article>
                ))
              ) : (
                <p className="muted">
                  No explicit contradiction pairs were preserved for this run.
                </p>
              )}
            </div>
          </div>

          <div className="workspace-evidence-card__section">
            <p className="eyebrow">Unresolved gaps</p>
            <div className="claim-inventory-card__list">
              {claimInventory.claimInventory.unresolvedGaps.length ? (
                claimInventory.claimInventory.unresolvedGaps.map((gap) => (
                  <GapCard key={gap.id} gap={gap} evidence={evidence} />
                ))
              ) : (
                <p className="muted">
                  No unresolved gaps were preserved for this run.
                </p>
              )}
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}
