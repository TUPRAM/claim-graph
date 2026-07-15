import Link from "next/link";
import { DevAuthGate } from "@/components/dev/DevAuthGate";
import { DevLogoutButton } from "@/components/dev/DevLogoutButton";
import { DevWorkspaceTable } from "@/components/dev/DevWorkspaceTable";
import { PublicBetaOperationsPanel } from "@/components/dev/PublicBetaOperationsPanel";
import { RuntimeReadinessCard } from "@/components/workspace/RuntimeReadinessCard";
import { hasDevSessionFromCookies } from "@/lib/server/dev-auth";
import { getRuntimeReadinessSummary } from "@/lib/server/runtime-readiness";
import { getClaimGraphStore } from "@/lib/server/storage/store-factory";
import type { RuntimeLaneReadiness } from "@/types/claimgraph";

export const dynamic = "force-dynamic";

function formatStatus(status: RuntimeLaneReadiness["status"]) {
  switch (status) {
    case "ready":
      return "Ready";
    case "configured":
      return "Configured";
    default:
      return "Blocked";
  }
}

function buildStatusToneClass(status: RuntimeLaneReadiness["status"]) {
  switch (status) {
    case "ready":
      return "pill pill--success";
    case "configured":
      return "pill pill--neutral";
    default:
      return "pill pill--accent";
  }
}

function buildStatusHeadline(status: RuntimeLaneReadiness["status"]) {
  switch (status) {
    case "ready":
      return "Ready to operate";
    case "configured":
      return "Configured, needs review";
    default:
      return "Blocked until configured";
  }
}

export default async function DevDashboardPage() {
  const authenticated = await hasDevSessionFromCookies();

  if (!authenticated) {
    return <DevAuthGate />;
  }

  const store = await getClaimGraphStore();
  const [readiness, workspaces] = await Promise.all([
    getRuntimeReadinessSummary(),
    store.listWorkspaces(50)
  ]);
  const readyLaneCount = readiness.lanes.filter((lane) => lane.status === "ready").length;
  const blockedLaneCount = readiness.lanes.filter((lane) => lane.status === "blocked").length;
  const configuredLaneCount = readiness.lanes.filter((lane) => lane.status === "configured").length;
  const selectedLane = readiness.lanes.find((lane) => lane.id === "selected_runtime");
  const checkedAt = new Date(readiness.checkedAt).toLocaleString();

  return (
    <main className="workspace-shell dev-shell">
      <nav className="public-nav" aria-label="Developer navigation">
        <Link href="/" className="brand-mark">
          ClaimGraph
        </Link>
        <div className="hero-actions">
          <Link href="/workspace/demo" className="button button--ghost button--small">
            Public demo
          </Link>
          <DevLogoutButton />
        </div>
      </nav>

      <header className="content-card dev-dashboard-hero">
        <p className="eyebrow">Developer lane</p>
        <h1>Internal diagnostics</h1>
        <p className="muted">
          Runtime readiness, run logs, raw artifacts, hosted health, and cleanup
          details stay here instead of the public product surface.
        </p>
      </header>

      <section className="content-card dev-status-summary" aria-label="Developer status summary">
        <div className="dev-status-summary__main">
          <p className="eyebrow">Status summary</p>
          <div className="dev-status-summary__headline">
            <h2>{buildStatusHeadline(readiness.overallStatus)}</h2>
            <span className={buildStatusToneClass(readiness.overallStatus)}>
              {formatStatus(readiness.overallStatus)}
            </span>
          </div>
          <p>{readiness.overallSummary}</p>
          <p className="muted">{readiness.nextAction}</p>
        </div>
        <dl className="dev-status-summary__metrics">
          <div>
            <dt>Mode</dt>
            <dd>{readiness.selectedMode}</dd>
          </div>
          <div>
            <dt>Lanes</dt>
            <dd>
              {readyLaneCount} ready / {configuredLaneCount} configured / {blockedLaneCount} blocked
            </dd>
          </div>
          <div>
            <dt>Selected lane</dt>
            <dd>{formatStatus(selectedLane?.status ?? readiness.overallStatus)}</dd>
          </div>
          <div>
            <dt>Backend</dt>
            <dd>{selectedLane?.backend ?? "unknown"}</dd>
          </div>
          <div>
            <dt>Recent records</dt>
            <dd>{workspaces.length}</dd>
          </div>
          <div>
            <dt>Checked</dt>
            <dd>{checkedAt}</dd>
          </div>
        </dl>
      </section>

      <RuntimeReadinessCard
        summary={readiness}
        heading="Runtime diagnostics"
        compact
      />

      <PublicBetaOperationsPanel />

      <section className="content-card dev-workspace-list">
        <div className="section-header">
          <div>
            <p className="eyebrow">Workspaces</p>
            <h2>Recent workspaces</h2>
            <p className="muted">
              Search by question, open protected diagnostics, or compare the
              public graph view.
            </p>
          </div>
          <Link href="/workspace/demo" className="button button--ghost button--small">
            Open public demo
          </Link>
        </div>

        {workspaces.length ? (
          <DevWorkspaceTable workspaces={workspaces} />
        ) : (
          <p className="muted">No workspaces have been created yet.</p>
        )}
      </section>

      <section className="content-card dev-dashboard-sections">
        <div className="section-header">
          <div>
            <p className="eyebrow">Moved from public UI</p>
            <h2>Developer-only surfaces</h2>
          </div>
        </div>
        <div className="diagnostics-card__grid">
          <article className="diagnostics-card__item">
            <h3>Runtime</h3>
            <p className="muted">Current mode, readiness, provider, and backend health.</p>
          </article>
          <article className="diagnostics-card__item">
            <h3>Runs</h3>
            <p className="muted">Stage timings, failure reasons, fallback reasons, and exports.</p>
          </article>
          <article className="diagnostics-card__item">
            <h3>Artifacts</h3>
            <p className="muted">Raw evidence packs, claim inventory, hosted health, and cleanup details.</p>
          </article>
          <article className="diagnostics-card__item">
            <h3>Operations</h3>
            <p className="muted">Abuse controls, retention cleanup, and provider limits.</p>
          </article>
        </div>
      </section>
    </main>
  );
}
