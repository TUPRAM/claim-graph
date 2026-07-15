"use client";

import Link from "next/link";
import { useAnalysisRunControl } from "@/components/workspace/hooks/useAnalysisRunControl";
import {
  useWorkspaceGraphPayload
} from "@/components/workspace/hooks/useWorkspaceGraphPayload";
import { LiveClaimInventoryCard } from "@/components/workspace/LiveClaimInventoryCard";
import { LiveEvidenceCard } from "@/components/workspace/LiveEvidenceCard";
import { WorkspaceAlphaAssessmentCard } from "@/components/workspace/WorkspaceAlphaAssessmentCard";
import { WorkspaceFilesCard } from "@/components/workspace/WorkspaceFilesCard";
import { RunDiagnosticsCard } from "@/components/dev/RunDiagnosticsCard";

function isWorkspaceBuildActive(status?: string): boolean {
  return (
    status === "queued" ||
    status === "ingesting" ||
    status === "gathering" ||
    status === "extracting" ||
    status === "assembling"
  );
}

export function DevWorkspaceDiagnostics({ workspaceId }: { workspaceId: string }) {
  const {
    payload,
    error,
    setError,
    deletedWorkspace,
    setDeletedWorkspace,
    loadGraph
  } = useWorkspaceGraphPayload(workspaceId, { lane: "dev" });
  const {
    isAnalyzing,
    isCanceling,
    runAnalysis,
    cancelAnalysis
  } = useAnalysisRunControl({
    workspaceId,
    payload,
    deletedWorkspace,
    loadGraph,
    setError
  });

  if (error) {
    return (
      <main className="workspace-shell dev-shell">
        <section className="content-card">
          <p className="eyebrow">Developer workspace</p>
          <h1>Workspace diagnostics unavailable</h1>
          <p className="error-text">{error}</p>
          <div className="hero-actions">
            <button className="button button--primary" type="button" onClick={() => void loadGraph()}>
              Retry
            </button>
            <Link className="button button--ghost" href="/dev">
              Back to dev dashboard
            </Link>
          </div>
        </section>
      </main>
    );
  }

  if (deletedWorkspace) {
    return (
      <main className="workspace-shell dev-shell">
        <section className="content-card">
          <p className="eyebrow">Workspace deleted</p>
          <h1>{deletedWorkspace.question}</h1>
          <p className="muted">
            Deleted {deletedWorkspace.deletedLocalFilesCount} / {deletedWorkspace.totalFiles}
            local files.
          </p>
          <div className="hero-actions">
            <Link className="button button--primary" href="/dev">
              Back to dev dashboard
            </Link>
          </div>
        </section>
      </main>
    );
  }

  if (!payload) {
    return (
      <main className="workspace-shell dev-shell">
        <section className="content-card">
          <p className="eyebrow">Developer workspace</p>
          <h1>Loading diagnostics...</h1>
          <p className="muted">Reading the protected workspace payload.</p>
        </section>
      </main>
    );
  }

  const diagnosticRun = payload.activeRun ?? payload.latestRun ?? payload.graphRun;
  const diagnosticEvidence =
    payload.inProgressArtifacts?.evidence ??
    payload.latestRunArtifacts?.evidence ??
    payload.evidence;
  const diagnosticClaimInventory =
    payload.inProgressArtifacts?.claimInventory ??
    payload.latestRunArtifacts?.claimInventory ??
    payload.claimInventory;
  const buildActive = isWorkspaceBuildActive(payload.activeRun?.status) || isAnalyzing;
  const canAnalyze = payload.workspace.id !== "demo" && payload.runtime.liveAnalysisEnabled;

  return (
    <main className="workspace-shell dev-shell">
      <header className="workspace-command-bar">
        <Link href="/dev" className="button button--ghost button--small">
          Dev
        </Link>
        <div className="workspace-command-bar__title">
          <p className="eyebrow">Developer diagnostics</p>
          <h1>{payload.workspace.question}</h1>
        </div>
        <div className="workspace-command-bar__actions">
          <Link
            href={`/workspace/${payload.workspace.id}`}
            className="button button--ghost button--small"
          >
            Public view
          </Link>
          {buildActive ? (
            <button
              className="button button--ghost button--small"
              type="button"
              onClick={() => void cancelAnalysis()}
              disabled={!canAnalyze || isCanceling}
            >
              {isCanceling ? "Canceling..." : "Cancel run"}
            </button>
          ) : null}
          <button
            className="button button--primary button--small"
            type="button"
            onClick={() => void runAnalysis()}
            disabled={!canAnalyze || buildActive || isCanceling}
          >
            {buildActive ? "Building..." : "Run analysis"}
          </button>
        </div>
      </header>

      <div className="dev-workspace-grid">
        <section className="dev-workspace-grid__main">
          <RunDiagnosticsCard
            run={diagnosticRun}
            runtime={payload.runtime}
            graphBuild={payload.graphBuild}
            starterMode={payload.starterMode}
          />
          <WorkspaceFilesCard
            workspaceId={payload.workspace.id}
            files={payload.files}
            sourceUrls={payload.workspace.sourceUrls}
            maxFiles={payload.workspace.settings.maxFiles}
            canMutate={!buildActive}
            onFilesChanged={loadGraph}
            onWorkspaceDeleted={setDeletedWorkspace}
          />
          <WorkspaceAlphaAssessmentCard workspaceId={payload.workspace.id} />
        </section>

        <aside className="dev-workspace-grid__side">
          <LiveEvidenceCard
            evidence={diagnosticEvidence}
            run={diagnosticRun}
            starterMode={payload.starterMode}
          />
          <LiveClaimInventoryCard
            claimInventory={diagnosticClaimInventory}
            evidence={diagnosticEvidence}
            run={diagnosticRun}
            starterMode={payload.starterMode}
          />
        </aside>
      </div>
    </main>
  );
}
