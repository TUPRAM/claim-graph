import type {
  ClaimGraphRuntimeInfo,
  GraphBuildInfo,
  ProviderFailureEvent,
  RetrievalCleanupEvent,
  Run,
  RunStageObservation
} from "@/types/claimgraph";

function formatDate(value?: string) {
  return value ? new Date(value).toLocaleString() : "not recorded";
}

function formatDuration(value?: number) {
  if (typeof value !== "number") {
    return "not recorded";
  }

  if (value < 1000) {
    return `${value}ms`;
  }

  return `${(value / 1000).toFixed(1)}s`;
}

function StageRow({ stage }: { stage: RunStageObservation }) {
  return (
    <article className="diagnostics-card__item">
      <div className="diagnostics-card__row">
        <strong>{stage.stage}</strong>
        <span className="pill pill--neutral">{formatDuration(stage.durationMs)}</span>
      </div>
      <p className="muted">
        {formatDate(stage.startedAt)} to {formatDate(stage.completedAt)}
      </p>
      {stage.model ? <p className="muted">Model: {stage.model}</p> : null}
    </article>
  );
}

function CleanupRow({ event }: { event: RetrievalCleanupEvent }) {
  return (
    <article className="diagnostics-card__item">
      <div className="diagnostics-card__row">
        <strong>{event.kind}</strong>
        <span className="pill pill--neutral">{event.status}</span>
      </div>
      <p className="muted">Remote ID: {event.remoteId}</p>
      <p className="muted">Reason: {event.reason}</p>
      {event.errorMessage ? <p className="error-text">{event.errorMessage}</p> : null}
    </article>
  );
}

function ProviderFailureRow({ event }: { event: ProviderFailureEvent }) {
  return (
    <article className="diagnostics-card__item">
      <div className="diagnostics-card__row">
        <strong>{event.reason}</strong>
        <span className="pill pill--neutral">{event.cleanupStatus}</span>
      </div>
      <p className="muted">
        {event.provider}
        {event.backend ? ` / ${event.backend}` : ""} / {event.stage}
      </p>
      <p>{event.message}</p>
      {event.cleanupMessage ? <p className="muted">{event.cleanupMessage}</p> : null}
    </article>
  );
}

export function RunDiagnosticsCard({
  run,
  runtime,
  graphBuild,
  starterMode
}: {
  run: Run | null;
  runtime: ClaimGraphRuntimeInfo;
  graphBuild: GraphBuildInfo;
  starterMode: boolean;
}) {
  const observability = run?.observability;
  const hostedHealth = observability?.hostedOpenModelHealth;

  return (
    <section className="content-card diagnostics-card">
      <div className="section-header">
        <div>
          <p className="eyebrow">Run diagnostics</p>
          <h2>Workspace internals</h2>
          <p className="muted">
            Operator-only status for runtime mode, graph build metadata,
            fallback reasons, stage timings, hosted health, exports, and cleanup.
          </p>
        </div>
        <span className="pill pill--neutral">{run?.status ?? "no run"}</span>
      </div>

      <div className="diagnostics-card__grid">
        <article className="diagnostics-card__item">
          <h3>Runtime</h3>
          <p className="muted">
            {runtime.mode} / {runtime.provider}
            {runtime.openModelBackend ? ` / ${runtime.openModelBackend}` : ""}
          </p>
          {runtime.openModelModel ? <p className="muted">Model: {runtime.openModelModel}</p> : null}
          <p className="muted">
            Live analysis: {runtime.liveAnalysisEnabled ? "enabled" : "disabled"}
          </p>
        </article>
        <article className="diagnostics-card__item">
          <h3>Graph build</h3>
          <p className="muted">
            {graphBuild.origin} / {graphBuild.mode} / {graphBuild.provider}
            {graphBuild.backend ? ` / ${graphBuild.backend}` : ""}
          </p>
          <p className="muted">Model: {graphBuild.model}</p>
          {graphBuild.responseId ? <p className="muted">Response: {graphBuild.responseId}</p> : null}
          {graphBuild.runId ? <p className="muted">Run: {graphBuild.runId}</p> : null}
        </article>
        <article className="diagnostics-card__item">
          <h3>Run state</h3>
          <p className="muted">Starter mode: {starterMode ? "yes" : "no"}</p>
          <p className="muted">Created: {formatDate(run?.createdAt)}</p>
          <p className="muted">Completed: {formatDate(run?.completedAt)}</p>
          {run?.statusMessage ? <p>{run.statusMessage}</p> : null}
          {run?.errorMessage ? <p className="error-text">{run.errorMessage}</p> : null}
          {observability?.fallbackReason ? (
            <p className="muted">Fallback: {observability.fallbackReason}</p>
          ) : null}
        </article>
      </div>

      <div className="diagnostics-card__section">
        <p className="eyebrow">Stage timings</p>
        <div className="diagnostics-card__list">
          {observability?.stages.length ? (
            observability.stages.map((stage) => (
              <StageRow key={`${stage.stage}-${stage.startedAt}`} stage={stage} />
            ))
          ) : (
            <p className="muted">No stage timings recorded.</p>
          )}
        </div>
      </div>

      {hostedHealth ? (
        <div className="diagnostics-card__section">
          <p className="eyebrow">Hosted health</p>
          <article className="diagnostics-card__item">
            <p className="muted">
              {hostedHealth.backend} / {hostedHealth.model} / {hostedHealth.apiBaseUrl}
            </p>
            <p className="muted">
              catalog {hostedHealth.catalogStatus} / request {hostedHealth.requestStatus}
            </p>
            <p className="muted">
              attempts {hostedHealth.requestAttempt ?? 0} / {hostedHealth.requestMaxAttempts ?? 0},
              timeout {hostedHealth.timeoutMs}ms
            </p>
            {hostedHealth.lastErrorMessage ? (
              <p className="error-text">{hostedHealth.lastErrorMessage}</p>
            ) : null}
          </article>
        </div>
      ) : null}

      <div className="diagnostics-card__section">
        <p className="eyebrow">Provider failure log</p>
        <div className="diagnostics-card__list">
          {observability?.providerFailureEvents?.length ? (
            observability.providerFailureEvents.map((event) => (
              <ProviderFailureRow key={event.id} event={event} />
            ))
          ) : (
            <p className="muted">No provider failures recorded.</p>
          )}
        </div>
      </div>

      <div className="diagnostics-card__section">
        <p className="eyebrow">Retrieval cleanup</p>
        <div className="diagnostics-card__list">
          {observability?.retrievalCleanupEvents?.length ? (
            observability.retrievalCleanupEvents.map((event) => (
              <CleanupRow key={event.id} event={event} />
            ))
          ) : (
            <p className="muted">No retrieval cleanup events recorded.</p>
          )}
        </div>
      </div>

      <div className="diagnostics-card__section">
        <p className="eyebrow">Exports</p>
        <div className="diagnostics-card__list">
          {observability?.exportEvents.length ? (
            observability.exportEvents.slice(-6).map((event) => (
              <article className="diagnostics-card__item" key={event.id}>
                <div className="diagnostics-card__row">
                  <strong>{event.format}</strong>
                  <span className="pill pill--neutral">{event.success ? "success" : "failed"}</span>
                </div>
                <p className="muted">
                  {event.mode} / {formatDate(event.createdAt)}
                </p>
                {event.errorMessage ? <p className="error-text">{event.errorMessage}</p> : null}
              </article>
            ))
          ) : (
            <p className="muted">No export events recorded.</p>
          )}
        </div>
      </div>
    </section>
  );
}
