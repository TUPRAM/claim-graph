import Link from "next/link";
import type { RuntimeLaneReadiness, RuntimeReadinessSummary } from "@/types/claimgraph";

function formatStatus(status: RuntimeLaneReadiness["status"]) {
  switch (status) {
    case "ready":
      return "ready";
    case "configured":
      return "configured";
    default:
      return "blocked";
  }
}

function buildLaneToneClass(status: RuntimeLaneReadiness["status"]) {
  switch (status) {
    case "ready":
      return "pill pill--success";
    case "configured":
      return "pill pill--neutral";
    default:
      return "pill pill--accent";
  }
}

export function RuntimeReadinessCard({
  summary,
  heading = "Runtime readiness",
  compact = false,
  error
}: {
  summary: RuntimeReadinessSummary | null;
  heading?: string;
  compact?: boolean;
  error?: string | null;
}) {
  if (error) {
    return (
      <section className="content-card readiness-card">
        <div className="section-header">
          <div>
            <p className="eyebrow">Operator truth</p>
            <h2>{heading}</h2>
          </div>
        </div>
        <p className="error-text">{error}</p>
      </section>
    );
  }

  if (!summary) {
    return (
      <section className="content-card readiness-card">
        <div className="section-header">
          <div>
            <p className="eyebrow">Operator truth</p>
            <h2>{heading}</h2>
          </div>
        </div>
        <p className="muted">Loading runtime readiness...</p>
      </section>
    );
  }

  const readyLaneCount = summary.lanes.filter((lane) => lane.status === "ready").length;
  const configuredLaneCount = summary.lanes.filter(
    (lane) => lane.status === "configured"
  ).length;
  const blockedLaneCount = summary.lanes.filter((lane) => lane.status === "blocked").length;

  return (
    <section className={`content-card readiness-card${compact ? " readiness-card--compact" : ""}`}>
      <div className="section-header">
        <div>
          <p className="eyebrow">Operator truth</p>
          <h2>{heading}</h2>
          <p className="muted">{summary.productPromise}</p>
        </div>
        <span className={buildLaneToneClass(summary.overallStatus)}>
          {formatStatus(summary.overallStatus)}
        </span>
      </div>

      <p>{summary.overallSummary}</p>
      <p className="muted">{summary.nextAction}</p>

      <div className="status-banner__chips">
        <span className="pill pill--neutral">
          mode {summary.selectedMode}
        </span>
        <span className="pill pill--neutral">
          {readyLaneCount} ready
        </span>
        <span className="pill pill--neutral">
          {configuredLaneCount} configured
        </span>
        <span className="pill pill--neutral">
          {blockedLaneCount} blocked
        </span>
      </div>

      <details className="readiness-card__lanes" open={!compact}>
        <summary>
          <span>Runtime lanes</span>
          <span className="muted">
            {readyLaneCount} ready - {blockedLaneCount} blocked
          </span>
        </summary>
        <div className="readiness-card__lane-grid">
          {summary.lanes.map((lane) => (
            <article key={lane.id} className="readiness-lane">
              <div className="readiness-lane__header">
                <div>
                  <h3>{lane.label}</h3>
                  <p className="muted">
                    {lane.backend}
                    {lane.model ? ` / ${lane.model}` : ""}
                  </p>
                </div>
                <span className={buildLaneToneClass(lane.status)}>
                  {formatStatus(lane.status)}
                </span>
              </div>
              <p>{lane.summary}</p>
              <ul className="readiness-lane__list">
                {lane.details.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
              {lane.nextAction ? <p className="muted">{lane.nextAction}</p> : null}
            </article>
          ))}
        </div>
      </details>

      {!compact ? (
        <div className="readiness-card__footer">
          <p className="muted">
            Runtime checks report environment and provider readiness only. They do not
            certify graph quality or deployment readiness.
          </p>
          <div className="hero-actions">
            <Link href="/workspace/demo" className="button button--ghost button--small">
              Open starter demo
            </Link>
            <a
              href="#compose"
              className="button button--ghost button--small"
            >
              Create a workspace
            </a>
          </div>
        </div>
      ) : null}
    </section>
  );
}
