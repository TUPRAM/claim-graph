"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

interface EffectiveControls {
  analysisEnabled: boolean;
  workspaceCreationLimit: number;
  workspaceAnalysisLimit: number;
  exportLimit: number;
  dailyPaidAnalysisLimit: number;
  providerConcurrency: number;
  overrides?: { updatedAt?: string };
}

interface ProviderCapacity {
  activeLeases: number;
  limit: number;
  available: boolean;
}

interface CleanupJob {
  id: string;
  jobType: string;
  status: "pending" | "running" | "failed" | "dead";
  attemptCount: number;
  nextAttemptAt: string;
  errorMessage: string | null;
}

interface CleanupBacklog {
  dueCount: number;
  failedCount: number;
  deadCount: number;
  oldestDueAt: string | null;
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };

  if (!response.ok) {
    throw new Error(payload.error ?? `Operator request failed (${response.status}).`);
  }

  return payload;
}

export function PublicBetaOperationsPanel() {
  const [controls, setControls] = useState<EffectiveControls | null>(null);
  const [capacity, setCapacity] = useState<ProviderCapacity | null>(null);
  const [jobs, setJobs] = useState<CleanupJob[]>([]);
  const [backlog, setBacklog] = useState<CleanupBacklog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);

    try {
      const [controlResponse, cleanupResponse] = await Promise.all([
        fetch("/api/dev/public-beta-controls", { cache: "no-store" }),
        fetch("/api/dev/cleanup-jobs?status=pending,running,failed,dead&limit=50", {
          cache: "no-store"
        })
      ]);
      const controlPayload = await readJson<{
        controls: EffectiveControls;
        providerCapacity: ProviderCapacity;
      }>(controlResponse);
      const cleanupPayload = await readJson<{
        jobs: CleanupJob[];
        backlog: CleanupBacklog;
      }>(cleanupResponse);

      setControls(controlPayload.controls);
      setCapacity(controlPayload.providerCapacity);
      setJobs(cleanupPayload.jobs);
      setBacklog(cleanupPayload.backlog);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Unable to load public-beta operations."
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveControls(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!controls) {
      return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch("/api/dev/public-beta-controls", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          analysisEnabled: controls.analysisEnabled,
          workspaceCreationLimit: controls.workspaceCreationLimit,
          workspaceAnalysisLimit: controls.workspaceAnalysisLimit,
          exportLimit: controls.exportLimit,
          dailyPaidAnalysisLimit: controls.dailyPaidAnalysisLimit,
          providerConcurrency: controls.providerConcurrency
        })
      });
      const payload = await readJson<{
        controls: EffectiveControls;
        providerCapacity: ProviderCapacity;
      }>(response);
      setControls(payload.controls);
      setCapacity(payload.providerCapacity);
      setNotice(
        payload.controls.analysisEnabled
          ? "Public analysis controls saved."
          : "Kill switch active: new provider work is disabled."
      );
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save controls.");
    } finally {
      setBusy(false);
    }
  }

  async function runCleanup(jobId?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch("/api/dev/cleanup-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(jobId ? { jobId, limit: 100 } : { limit: 100 })
      });
      await readJson(response);
      setNotice(jobId ? "Cleanup job queued for retry." : "Due cleanup batch processed.");
      await load();
    } catch (cleanupError) {
      setError(
        cleanupError instanceof Error
          ? cleanupError.message
          : "Unable to run cleanup."
      );
    } finally {
      setBusy(false);
    }
  }

  function updateNumber(
    key: keyof Pick<
      EffectiveControls,
      | "workspaceCreationLimit"
      | "workspaceAnalysisLimit"
      | "exportLimit"
      | "dailyPaidAnalysisLimit"
      | "providerConcurrency"
    >,
    value: string
  ) {
    const parsed = Number.parseInt(value, 10);
    if (!controls || !Number.isFinite(parsed)) {
      return;
    }
    setControls({ ...controls, [key]: Math.max(1, parsed) });
  }

  return (
    <section className="content-card public-beta-ops" aria-labelledby="public-beta-ops-title">
      <div className="section-header">
        <div>
          <p className="eyebrow">Public-beta operations</p>
          <h2 id="public-beta-ops-title">Safety controls and retention queue</h2>
          <p className="muted">
            Disable new provider work, tighten live quotas, and retry failed
            deletion without redeploying.
          </p>
        </div>
        <button
          className="button button--ghost button--small"
          type="button"
          onClick={() => void load()}
          disabled={busy}
        >
          Refresh
        </button>
      </div>

      {controls ? (
        <form className="public-beta-ops__controls" onSubmit={saveControls}>
          <label className="checkbox-field public-beta-ops__kill-switch">
            <input
              type="checkbox"
              checked={controls.analysisEnabled}
              onChange={(event) =>
                setControls({ ...controls, analysisEnabled: event.target.checked })
              }
              disabled={busy}
            />
            <span>
              <strong>Allow new analysis provider calls</strong>
              <small>
                Turn this off for the no-redeploy kill switch. Database terminal
                states still protect work already in flight.
              </small>
            </span>
          </label>

          <div className="public-beta-ops__fields">
            {([
              ["workspaceCreationLimit", "Creates / IP window"],
              ["workspaceAnalysisLimit", "Analyses / workspace"],
              ["exportLimit", "Exports / workspace"],
              ["dailyPaidAnalysisLimit", "Paid analyses / day"],
              ["providerConcurrency", "Provider concurrency"]
            ] as const).map(([key, label]) => (
              <label className="field" key={key}>
                <span className="field__label">{label}</span>
                <input
                  className="input"
                  type="number"
                  min={1}
                  value={controls[key]}
                  onChange={(event) => updateNumber(key, event.target.value)}
                  disabled={busy}
                />
              </label>
            ))}
          </div>

          <div className="hero-actions">
            <button className="button button--primary button--small" type="submit" disabled={busy}>
              {busy ? "Saving..." : "Save controls"}
            </button>
            <span className={controls.analysisEnabled ? "pill pill--success" : "pill pill--accent"}>
              {controls.analysisEnabled ? "Analysis enabled" : "Kill switch active"}
            </span>
            {capacity ? (
              <span className="muted">
                {capacity.activeLeases} / {capacity.limit} provider calls active
              </span>
            ) : null}
          </div>
        </form>
      ) : (
        <p className="muted">Loading durable controls...</p>
      )}

      <div className="public-beta-ops__cleanup">
        <div className="section-header">
          <div>
            <h3>Retention cleanup</h3>
            <p className="muted">
              Due {backlog?.dueCount ?? 0}; failed {backlog?.failedCount ?? 0};
              dead {backlog?.deadCount ?? 0}
              {backlog?.oldestDueAt
                ? `; oldest due ${new Date(backlog.oldestDueAt).toLocaleString()}`
                : ""}
            </p>
          </div>
          <button
            className="button button--ghost button--small"
            type="button"
            onClick={() => void runCleanup()}
            disabled={busy}
          >
            Run due cleanup
          </button>
        </div>

        {jobs.length ? (
          <div className="public-beta-ops__jobs">
            {jobs.map((job) => (
              <article className="diagnostics-card__item" key={job.id}>
                <div className="public-beta-ops__job-title">
                  <strong>{job.jobType}</strong>
                  <span className={job.status === "dead" || job.status === "failed" ? "pill pill--accent" : "pill pill--neutral"}>
                    {job.status}
                  </span>
                </div>
                <p className="muted">
                  Attempts {job.attemptCount}; next {new Date(job.nextAttemptAt).toLocaleString()}
                </p>
                {job.errorMessage ? <p className="error-text">{job.errorMessage}</p> : null}
                {job.status === "failed" || job.status === "dead" ? (
                  <button
                    className="button button--ghost button--small"
                    type="button"
                    onClick={() => void runCleanup(job.id)}
                    disabled={busy}
                  >
                    Retry
                  </button>
                ) : null}
              </article>
            ))}
          </div>
        ) : (
          <p className="muted">No pending or failed cleanup jobs.</p>
        )}
      </div>

      {notice ? <p className="notice-text">{notice}</p> : null}
      {error ? <p className="error-text">{error}</p> : null}
    </section>
  );
}
