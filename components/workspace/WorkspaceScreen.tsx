"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ClaimGraphCanvas } from "@/components/graph/ClaimGraphCanvas";
import { GraphLegend } from "@/components/graph/GraphLegend";
import { GraphToolbar } from "@/components/graph/GraphToolbar";
import { CitationPanel } from "@/components/sidebar/CitationPanel";
import { useAnalysisRunControl } from "@/components/workspace/hooks/useAnalysisRunControl";
import { useGraphFocusMode } from "@/components/workspace/hooks/useGraphFocusMode";
import { useWorkspaceReviewState } from "@/components/workspace/hooks/useWorkspaceReviewState";
import {
  formatCleanupSummary,
  useWorkspaceGraphPayload
} from "@/components/workspace/hooks/useWorkspaceGraphPayload";
import { useWorkspaceExports } from "@/components/workspace/hooks/useWorkspaceExports";
import { buildSourceNoteLimitationSummary } from "@/lib/provenance/source-notes";
import { assessPublicGraphQuality } from "@/lib/graph/public-quality";
import {
  getGraphSourceCountLabel,
  getGraphSourceMode,
  getGraphSourceModeLabel
} from "@/lib/provenance/graph-source-mode";
import { RunStatusBanner } from "@/components/workspace/RunStatusBanner";
import type { NodeKind, ReviewBranchFilter } from "@/types/claimgraph";

const KEYBOARD_KIND_MAP: Record<string, NodeKind> = {
  "1": "claim",
  "2": "counterclaim",
  "3": "evidence",
  "4": "gap"
};

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function isWorkspaceBuildActive(status?: string): boolean {
  return (
    status === "queued" ||
    status === "ingesting" ||
    status === "gathering" ||
    status === "extracting" ||
    status === "assembling"
  );
}

function formatInspectorKind(kind?: NodeKind | null): string {
  switch (kind) {
    case "claim":
      return "Selected claim";
    case "counterclaim":
      return "Selected counterclaim";
    case "evidence":
      return "Selected evidence";
    case "gap":
      return "Selected gap";
    case "question":
      return "Selected question";
    default:
      return "Node details";
  }
}

export function WorkspaceScreen({ workspaceId }: { workspaceId: string }) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const inspectorCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const inspectorReturnFocusRef = useRef<HTMLElement | null>(null);
  const inspectorWasOpenRef = useRef(false);
  const mobileFilterTriggerRef = useRef<HTMLButtonElement | null>(null);
  const mobileFilterCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const [branchFilter, setBranchFilter] = useState<ReviewBranchFilter>("all");
  const [sourceFilterId, setSourceFilterId] = useState("all");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [selectionFitToken, setSelectionFitToken] = useState(0);
  const {
    payload,
    error,
    setError,
    deletedWorkspace,
    loadGraph
  } = useWorkspaceGraphPayload(workspaceId);
  const {
    selectedNodeId,
    setSelectedNodeId,
    selectedNode,
    strongestOnly,
    setStrongestOnly,
    unresolvedOnly,
    setUnresolvedOnly,
    hiddenKinds,
    setHiddenKinds,
    toggleKind,
    focusedCluster,
    setFocusedClusterId,
    sortedClusters,
    focusNodeIds,
    visibleNodeIds,
    viewportNodeIds,
    viewportKey,
    resetToken,
    resetView,
    cycleCluster,
    hasGapNodes
  } = useGraphFocusMode(payload);

  useEffect(() => {
    const previousBodyOverflow = document.body.style.overflow;
    const previousDocumentOverflow = document.documentElement.style.overflow;

    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousDocumentOverflow;
    };
  }, []);

  const selectedSource = useMemo(() => {
    if (!payload || sourceFilterId === "all") {
      return null;
    }

    return payload.sources.find((source) => source.id === sourceFilterId) ?? null;
  }, [payload, sourceFilterId]);
  const sourceNoteLimitations = useMemo(() => {
    if (!payload || payload.starterMode) {
      return null;
    }

    return buildSourceNoteLimitationSummary(payload.sources, payload.snippets);
  }, [payload]);
  const currentReviewState = useMemo(() => {
    return {
      strongestOnly,
      unresolvedOnly,
      hiddenKinds,
      focusClusterId: focusedCluster?.id ?? null,
      selectedNodeId,
      branchFilter,
      sourceFilterId
    };
  }, [
    branchFilter,
    focusedCluster?.id,
    hiddenKinds,
    selectedNodeId,
    sourceFilterId,
    strongestOnly,
    unresolvedOnly
  ]);
  const {
    pendingRestoredReviewState,
    acknowledgeRestoredReviewState,
    savedReviewStates,
    matchedSavedReviewState,
    saveCurrentReviewState,
    deleteSavedReviewState
  } = useWorkspaceReviewState({
    workspaceId,
    currentState: currentReviewState
  });
  const {
    notice,
    isExportingMarkdown,
    isExportingPng,
    exportMarkdown,
    exportPng
  } = useWorkspaceExports({
    workspaceId,
    canvasRef,
    strongestOnly,
    unresolvedOnly,
    focusClusterId: focusedCluster?.id ?? null,
    hiddenKinds,
    selectedNodeId,
    savedReviewStateId: matchedSavedReviewState?.id ?? null,
    savedReviewStateLabel: matchedSavedReviewState?.label ?? null,
    reviewBranchFilter: branchFilter,
    reviewSourceFilterId: sourceFilterId === "all" ? null : sourceFilterId,
    reviewSourceFilterLabel:
      sourceFilterId === "all"
        ? null
        : selectedSource?.title ?? sourceFilterId
  });
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
  const kindCounts = useMemo(() => {
    const total = {
      claim: 0,
      counterclaim: 0,
      evidence: 0,
      gap: 0
    };
    const visible = {
      claim: 0,
      counterclaim: 0,
      evidence: 0,
      gap: 0
    };

    if (!payload) {
      return {
        claim: {
          total: 0,
          visible: 0
        },
        counterclaim: {
          total: 0,
          visible: 0
        },
        evidence: {
          total: 0,
          visible: 0
        },
        gap: {
          total: 0,
          visible: 0
        }
      };
    }

    for (const node of payload.graph.nodes) {
      if (node.kind === "question") {
        continue;
      }

      switch (node.kind) {
        case "claim":
        case "counterclaim":
        case "evidence":
        case "gap":
          total[node.kind] += 1;

          if (!visibleNodeIds || visibleNodeIds.has(node.id)) {
            visible[node.kind] += 1;
          }

          break;
      }
    }

    return {
      claim: {
        total: total.claim,
        visible: visible.claim
      },
      counterclaim: {
        total: total.counterclaim,
        visible: visible.counterclaim
      },
      evidence: {
        total: total.evidence,
        visible: visible.evidence
      },
      gap: {
        total: total.gap,
        visible: visible.gap
      }
    };
  }, [payload, visibleNodeIds]);

  const applyReviewState = useCallback((reviewState: {
    strongestOnly: boolean;
    unresolvedOnly: boolean;
    hiddenKinds: NodeKind[];
    focusClusterId: string | null;
    selectedNodeId: string | null;
    branchFilter: ReviewBranchFilter;
    sourceFilterId: string;
  }) => {
    setStrongestOnly(reviewState.strongestOnly);
    setUnresolvedOnly(reviewState.unresolvedOnly);
    setHiddenKinds(reviewState.hiddenKinds);
    setFocusedClusterId(reviewState.focusClusterId);
    setSelectedNodeId(reviewState.selectedNodeId);
    setBranchFilter(reviewState.branchFilter);
    setSourceFilterId(reviewState.sourceFilterId);
    setInspectorOpen(Boolean(reviewState.selectedNodeId));
    resetView();
  }, [
    resetView,
    setFocusedClusterId,
    setHiddenKinds,
    setSelectedNodeId,
    setStrongestOnly,
    setUnresolvedOnly
  ]);

  const openInspector = useCallback((returnFocusElement?: HTMLElement | null) => {
    if (returnFocusElement) {
      inspectorReturnFocusRef.current = returnFocusElement;
    } else if (!inspectorOpen && document.activeElement instanceof HTMLElement) {
      const activeElement = document.activeElement;
      if (activeElement !== document.body) {
        inspectorReturnFocusRef.current = activeElement;
      }
    }

    setInspectorOpen(true);
  }, [inspectorOpen]);

  const closeInspector = useCallback(() => {
    setInspectorOpen(false);
    setSelectedNodeId(null);

    window.setTimeout(() => {
      const returnTarget = inspectorReturnFocusRef.current;
      if (returnTarget?.isConnected) {
        returnTarget.focus();
      }
    }, 0);
  }, [setSelectedNodeId]);

  const inspectNode = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
    setSelectionFitToken((value) => value + 1);
    openInspector();
  }, [openInspector, setSelectedNodeId]);

  const openMobileFilters = useCallback(() => {
    setMobileFiltersOpen(true);
  }, []);

  const closeMobileFilters = useCallback(() => {
    setMobileFiltersOpen(false);

    window.setTimeout(() => {
      mobileFilterTriggerRef.current?.focus();
    }, 0);
  }, []);

  const saveVisibleReviewState = useCallback(() => {
    saveCurrentReviewState({
      selectedNodeTitle: selectedNode?.title ?? null,
      focusedClusterTitle: focusedCluster?.title ?? null,
      sourceFilterLabel: selectedSource?.title ?? null
    });
  }, [
    focusedCluster?.title,
    saveCurrentReviewState,
    selectedNode?.title,
    selectedSource?.title
  ]);

  useEffect(() => {
    setBranchFilter("all");
    setSourceFilterId("all");
    setInspectorOpen(false);
    setMobileFiltersOpen(false);
    setSelectionFitToken(0);
  }, [workspaceId]);

  useEffect(() => {
    if (inspectorOpen && !inspectorWasOpenRef.current) {
      window.setTimeout(() => {
        inspectorCloseButtonRef.current?.focus();
      }, 0);
    }

    inspectorWasOpenRef.current = inspectorOpen;
  }, [inspectorOpen]);

  useEffect(() => {
    if (!mobileFiltersOpen) {
      return;
    }

    window.setTimeout(() => {
      mobileFilterCloseButtonRef.current?.focus();
    }, 0);
  }, [mobileFiltersOpen]);

  useEffect(() => {
    if (!payload || !pendingRestoredReviewState) {
      return;
    }

    applyReviewState(pendingRestoredReviewState);
    acknowledgeRestoredReviewState();
  }, [
    acknowledgeRestoredReviewState,
    applyReviewState,
    payload,
    pendingRestoredReviewState
  ]);

  useEffect(() => {
    if (!payload) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }

      if (isEditableTarget(event.target)) {
        return;
      }

      const lowerKey = event.key.toLowerCase();

      if (lowerKey === "d") {
        event.preventDefault();
        setStrongestOnly((value) => !value);
        return;
      }

      if (lowerKey === "u") {
        if (!hasGapNodes) {
          return;
        }

        event.preventDefault();
        setUnresolvedOnly((value) => !value);
        return;
      }

      if (event.key === "[") {
        if (!strongestOnly || sortedClusters.length <= 1) {
          return;
        }

        event.preventDefault();
        cycleCluster("previous");
        return;
      }

      if (event.key === "]") {
        if (!strongestOnly || sortedClusters.length <= 1) {
          return;
        }

        event.preventDefault();
        cycleCluster("next");
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        if (mobileFiltersOpen) {
          closeMobileFilters();
          return;
        }

        if (inspectorOpen) {
          closeInspector();
          return;
        }

        resetView();
        return;
      }

      const mappedKind = KEYBOARD_KIND_MAP[event.key];

      if (!mappedKind) {
        return;
      }

      event.preventDefault();
      toggleKind(mappedKind);
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    cycleCluster,
    closeInspector,
    closeMobileFilters,
    hasGapNodes,
    inspectorOpen,
    mobileFiltersOpen,
    payload,
    resetView,
    setStrongestOnly,
    setUnresolvedOnly,
    sortedClusters.length,
    strongestOnly,
    toggleKind
  ]);

  if (error) {
    return (
      <main className="workspace-shell">
        <div className="content-card">
          <h1>Workspace error</h1>
          <p>{error}</p>
          <div className="hero-actions">
            <button
              className="button button--primary"
              type="button"
              onClick={() => void loadGraph()}
            >
              Retry
            </button>
            <Link className="button button--ghost" href="/">
              Back home
            </Link>
          </div>
        </div>
      </main>
    );
  }

  if (deletedWorkspace) {
    return (
      <main className="workspace-shell">
        <div className="content-card">
          <p className="eyebrow">Workspace deleted</p>
          <h1>{deletedWorkspace.question}</h1>
          <p className="muted">
            This workspace and its persisted local metadata were removed.
          </p>
          <p className="muted">
            Local uploads deleted: {deletedWorkspace.deletedLocalFilesCount} / {deletedWorkspace.totalFiles}
          </p>
          <p className="muted">
            Remote cleanup: {formatCleanupSummary(deletedWorkspace.cleanup)}
          </p>
          {deletedWorkspace.cleanup.failedCount > 0 || deletedWorkspace.cleanup.pendingCount > 0 ? (
            <p className="error-text">
              Some linked cleanup steps could not be fully completed. The summary above is the final cleanup report for this workspace.
            </p>
          ) : null}
          <div className="hero-actions">
            <Link className="button button--primary" href="/">
              Back home
            </Link>
          </div>
        </div>
      </main>
    );
  }

  if (!payload) {
    return (
      <main className="workspace-shell">
        <div className="content-card">
          <p className="eyebrow">Loading</p>
          <h1>Preparing workspace...</h1>
          <p className="muted">
            The workspace is loading its saved map and source trail.
          </p>
        </div>
      </main>
    );
  }

  const canFocusUnresolved = hasGapNodes;
  const canWrite = payload.canWrite === true;
  const canAnalyze =
    canWrite &&
    payload.workspace.id !== "demo" &&
    payload.runtime.liveAnalysisEnabled;
  const buildActive = isWorkspaceBuildActive(payload.activeRun?.status) || isAnalyzing;
  const nodeCount = payload.graph.nodes.length;
  const openGapCount = payload.graph.nodes.filter((node) => node.kind === "gap").length;
  const graphSourceMode = getGraphSourceMode(payload);
  const graphSourceLabel = getGraphSourceModeLabel(graphSourceMode);
  const publicGraphQuality = assessPublicGraphQuality(payload);
  const sourceCountLabel = getGraphSourceCountLabel(
    graphSourceMode,
    payload.sources.length
  );
  const strongestDisagreementScore =
    payload.graph.disagreementClusters.length > 0
      ? payload.graph.disagreementClusters[0].score
      : null;
  const focusedClusterIndex = focusedCluster
    ? sortedClusters.findIndex((cluster) => cluster.id === focusedCluster.id)
    : 0;
  const inspectorKindLabel = formatInspectorKind(selectedNode?.kind);

  const inspector = (
    <>
      <CitationPanel
        graph={payload.graph}
        selectedNode={selectedNode}
        sources={payload.sources}
        snippets={payload.snippets}
        strongestOnly={strongestOnly}
        focusClusterId={strongestOnly ? focusedCluster?.id ?? null : null}
        branchFilter={branchFilter}
        onBranchFilterChange={setBranchFilter}
        sourceFilterId={sourceFilterId}
        onSourceFilterChange={setSourceFilterId}
        savedReviewStates={savedReviewStates}
        matchedSavedReviewStateId={matchedSavedReviewState?.id ?? null}
        onSaveReviewState={saveVisibleReviewState}
        onApplySavedReviewState={(savedReviewStateId) => {
          const savedReviewState = savedReviewStates.find(
            (value) => value.id === savedReviewStateId
          );

          if (!savedReviewState) {
            return;
          }

          applyReviewState(savedReviewState);
        }}
        onDeleteSavedReviewState={deleteSavedReviewState}
        onSelectNode={inspectNode}
        variant="drawer"
      />
      {sourceNoteLimitations ? (
        <details className="content-card workspace-source-limits-card workspace-source-limits-card--drawer" aria-label="Source limitations">
          <summary className="workspace-source-limits-card__header">
            <div>
              <p className="eyebrow">Source limitations</p>
              <h2>Know what was checked</h2>
            </div>
            <span className="pill pill--accent">Limited sources</span>
          </summary>
          <div className="workspace-source-limits-card__body">
            <p className="muted">
              Some uploaded files summarize sources or point to outside URLs.
              Treat those links as leads unless the source itself appears in the
              evidence list.
            </p>
            <div className="status-banner__chips">
              <span className="pill pill--neutral">
                {sourceNoteLimitations.sourceCount} limited source
                {sourceNoteLimitations.sourceCount === 1 ? "" : "s"}
              </span>
              <span className="pill pill--neutral">
                {sourceNoteLimitations.snippetCount} linked snippet
                {sourceNoteLimitations.snippetCount === 1 ? "" : "s"}
              </span>
            </div>
            <ul className="readiness-lane__list">
              {sourceNoteLimitations.sources.map((source) => (
                <li key={source.id}>{source.title}</li>
              ))}
            </ul>
          </div>
        </details>
      ) : null}
    </>
  );

  return (
    <main className="workspace-shell workspace-shell--public workspace-shell--map">
      <section
        className={`workspace-map-board ${inspectorOpen ? "workspace-map-board--inspector-open" : ""}`}
        aria-label="Argument map workspace"
      >
        <ClaimGraphCanvas
          graph={payload.graph}
          selectedNodeId={selectedNodeId}
          focusNodeIds={focusNodeIds}
          visibleNodeIds={visibleNodeIds}
          viewportNodeIds={viewportNodeIds}
          viewportKey={viewportKey}
          focusClusterId={strongestOnly ? focusedCluster?.id ?? null : null}
          selectionFitToken={selectionFitToken}
          resetToken={resetToken}
          captureRef={canvasRef}
          fitPadding={0.12}
          showMiniMap={false}
          onNodeSelect={inspectNode}
        />

        <div className="workspace-top-layer" aria-label="Workspace controls">
          <header className="workspace-command-bar workspace-command-bar--floating">
            <Link href="/" className="button button--ghost button--small">
              Home
            </Link>
            <div className="workspace-command-bar__title">
              <p className="eyebrow">Argument map</p>
              <h1>{payload.workspace.question}</h1>
            </div>
            <div className="workspace-command-bar__actions" aria-label="Workspace actions">
              {!canWrite && payload.workspace.id !== "demo" ? (
                <div className="workspace-view-only-notice" role="status">
                  <strong>View-only shared workspace</strong>
                  <span>
                    You can inspect the graph; changes stay with the creator's browser.
                  </span>
                </div>
              ) : null}
              {buildActive ? (
                <button
                  className="button button--ghost button--small"
                  type="button"
                  onClick={() => void cancelAnalysis()}
                  disabled={!canAnalyze || isCanceling}
                >
                  {isCanceling ? "Canceling..." : "Cancel"}
                </button>
              ) : null}
              <button
                className="button button--primary button--small"
                type="button"
                onClick={() => void runAnalysis()}
                disabled={!canAnalyze || buildActive || isCanceling}
              >
                {buildActive ? "Building..." : payload.latestRun ? "Rebuild graph" : "Build graph"}
              </button>
              <button
                className="button button--ghost button--small"
                type="button"
                onClick={() => void exportMarkdown()}
                disabled={!canWrite || isExportingMarkdown}
              >
                {isExportingMarkdown ? "Exporting..." : "Export notes"}
              </button>
              <button
                className="button button--ghost button--small"
                type="button"
                onClick={() => void exportPng()}
                disabled={!canWrite || isExportingPng}
              >
                {isExportingPng ? "Exporting..." : "Export image"}
              </button>
            </div>
          </header>

          <RunStatusBanner
            run={payload.graphRun}
            starterMode={payload.starterMode}
            graphSourceLabel={graphSourceLabel}
            publicGraphQuality={publicGraphQuality}
            sourceCountLabel={sourceCountLabel}
            nodeCount={nodeCount}
            openGapCount={openGapCount}
            strongestDisagreementScore={strongestDisagreementScore}
          />
        </div>

        <section className="workspace-floating-toolbar" aria-label="Argument map controls">
          <div className="workspace-floating-toolbar__header">
            <div>
              <p className="eyebrow">Inspect the disagreement</p>
              <p className="workspace-floating-toolbar__summary">{payload.graph.graphSummary}</p>
            </div>
            <GraphLegend compact />
          </div>
          <GraphToolbar
            strongestOnly={strongestOnly}
            unresolvedOnly={unresolvedOnly}
            canFocusUnresolved={canFocusUnresolved}
            hiddenKinds={hiddenKinds}
            kindCounts={kindCounts}
            mobileFiltersOpen={mobileFiltersOpen}
            mobileFilterTriggerRef={mobileFilterTriggerRef}
            mobileFilterCloseButtonRef={mobileFilterCloseButtonRef}
            focusedClusterId={focusedCluster?.id ?? null}
            focusedClusterTitle={focusedCluster?.title ?? null}
            focusedClusterIndex={focusedClusterIndex}
            clusterCount={sortedClusters.length}
            clusterOptions={sortedClusters.map((cluster) => ({
              id: cluster.id,
              title: cluster.title,
              score: cluster.score
            }))}
            onToggleStrongest={() => setStrongestOnly((value) => !value)}
            onToggleUnresolved={() => {
              if (!canFocusUnresolved) {
                return;
              }

              setUnresolvedOnly((value) => !value);
            }}
            onSelectCluster={setFocusedClusterId}
            onPreviousCluster={() => cycleCluster("previous")}
            onNextCluster={() => cycleCluster("next")}
            onToggleKind={toggleKind}
            onResetView={resetView}
            onOpenMobileFilters={openMobileFilters}
            onCloseMobileFilters={closeMobileFilters}
          />
        </section>

        {notice ? (
          <div className={`callout workspace-floating-notice ${notice.tone === "error" ? "callout--error" : ""}`}>
            <p className="eyebrow">Export status</p>
            <p className={notice.tone === "error" ? "error-text" : undefined}>
              {notice.text}
            </p>
          </div>
        ) : null}

        {sourceNoteLimitations ? (
          <section className="workspace-source-limits-note" aria-label="Source limitations">
            <div>
              <p className="eyebrow">Source limitations</p>
              <p>
                {sourceNoteLimitations.sourceCount} limited source
                {sourceNoteLimitations.sourceCount === 1 ? "" : "s"} / {sourceNoteLimitations.snippetCount} linked snippet
                {sourceNoteLimitations.snippetCount === 1 ? "" : "s"}
              </p>
            </div>
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={(event) => openInspector(event.currentTarget)}
              aria-expanded={inspectorOpen}
              aria-controls="workspace-node-inspector"
            >
              Review
            </button>
          </section>
        ) : null}

        <aside
          id="workspace-node-inspector"
          className={`workspace-inspector-drawer ${inspectorOpen ? "workspace-inspector-drawer--open" : ""}`}
          aria-label="Map inspector"
          aria-describedby="workspace-inspector-status"
          aria-hidden={!inspectorOpen}
        >
          <div className="workspace-inspector-drawer__header">
            <div>
              <p className="eyebrow">{inspectorKindLabel}</p>
              <h2>{selectedNode ? selectedNode.title : "Select a box"}</h2>
              <p id="workspace-inspector-status" className="workspace-inspector-drawer__status">
                {selectedNode ? `${selectedNode.kind} details and provenance` : "Select a graph node to inspect its evidence and related gaps."}
              </p>
            </div>
            <button
              type="button"
              ref={inspectorCloseButtonRef}
              className="button button--ghost button--small"
              onClick={closeInspector}
              aria-label="Close map inspector"
            >
              Close
            </button>
          </div>
          <div className="workspace-inspector-drawer__body">
            {inspectorOpen ? inspector : null}
          </div>
        </aside>
      </section>
    </main>
  );
}
