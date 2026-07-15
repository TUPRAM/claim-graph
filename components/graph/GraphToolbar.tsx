"use client";

import type { RefObject } from "react";
import type { NodeKind } from "@/types/claimgraph";

type FilterableKind = Exclude<NodeKind, "question">;
const KINDS: FilterableKind[] = ["claim", "counterclaim", "evidence", "gap"];

const KIND_LABELS: Record<FilterableKind, string> = {
  claim: "Claims",
  counterclaim: "Counterclaims",
  evidence: "Evidence",
  gap: "Gaps"
};
const KIND_SHORTCUTS: Record<FilterableKind, string> = {
  claim: "1",
  counterclaim: "2",
  evidence: "3",
  gap: "4"
};
const KIND_TONE_CLASS: Record<FilterableKind, string> = {
  claim: "toolbar__kind-toggle--claim",
  counterclaim: "toolbar__kind-toggle--counterclaim",
  evidence: "toolbar__kind-toggle--evidence",
  gap: "toolbar__kind-toggle--gap"
};

export interface GraphToolbarKindCount {
  total: number;
  visible: number;
}

export interface GraphToolbarProps {
  strongestOnly: boolean;
  unresolvedOnly: boolean;
  canFocusUnresolved: boolean;
  hiddenKinds: NodeKind[];
  kindCounts: Record<FilterableKind, GraphToolbarKindCount>;
  mobileFiltersOpen?: boolean;
  mobileFilterTriggerRef?: RefObject<HTMLButtonElement | null>;
  mobileFilterCloseButtonRef?: RefObject<HTMLButtonElement | null>;
  focusedClusterId?: string | null;
  focusedClusterTitle?: string | null;
  focusedClusterIndex?: number;
  clusterCount?: number;
  clusterOptions?: Array<{
    id: string;
    title: string;
    score: number;
  }>;
  onToggleStrongest: () => void;
  onToggleUnresolved: () => void;
  onSelectCluster?: (clusterId: string) => void;
  onPreviousCluster?: () => void;
  onNextCluster?: () => void;
  onToggleKind: (kind: NodeKind) => void;
  onResetView: () => void;
  onOpenMobileFilters?: () => void;
  onCloseMobileFilters?: () => void;
}

function KindFilterButtons({
  hiddenKinds,
  kindCounts,
  onToggleKind
}: {
  hiddenKinds: NodeKind[];
  kindCounts: Record<FilterableKind, GraphToolbarKindCount>;
  onToggleKind: (kind: NodeKind) => void;
}) {
  return (
    <>
      {KINDS.map((kind) => {
        const hidden = hiddenKinds.includes(kind);
        const counts = kindCounts[kind];
        const visibleSummary =
          counts.total > 0 ? `${counts.visible}/${counts.total}` : "0/0";

        return (
          <button
            key={kind}
            type="button"
            className={
              hidden
                ? `button button--ghost button--small toolbar__kind-toggle ${KIND_TONE_CLASS[kind]}`
                : `button button--subtle button--small toolbar__kind-toggle ${KIND_TONE_CLASS[kind]}`
            }
            onClick={() => onToggleKind(kind)}
            aria-pressed={!hidden}
            aria-keyshortcuts={KIND_SHORTCUTS[kind]}
            title={`Toggle ${KIND_LABELS[kind].toLowerCase()} visibility (${KIND_SHORTCUTS[kind]})`}
          >
            <span className="toolbar__kind-dot" aria-hidden="true" />
            <span>{`${KIND_LABELS[kind]} ${visibleSummary}`}</span>
          </button>
        );
      })}
    </>
  );
}

export function GraphToolbar({
  strongestOnly,
  unresolvedOnly,
  canFocusUnresolved,
  hiddenKinds,
  kindCounts,
  mobileFiltersOpen = false,
  mobileFilterTriggerRef,
  mobileFilterCloseButtonRef,
  focusedClusterId,
  focusedClusterTitle,
  focusedClusterIndex = 0,
  clusterCount = 0,
  clusterOptions = [],
  onToggleStrongest,
  onToggleUnresolved,
  onSelectCluster,
  onPreviousCluster,
  onNextCluster,
  onToggleKind,
  onResetView,
  onOpenMobileFilters,
  onCloseMobileFilters
}: GraphToolbarProps) {
  return (
    <div className="toolbar">
      <div className="toolbar__group toolbar__group--primary">
        <button
          type="button"
          className={
            strongestOnly
              ? "button button--primary button--small toolbar__action toolbar__action--conflict"
              : "button button--ghost button--small toolbar__action toolbar__action--conflict"
          }
          onClick={onToggleStrongest}
          aria-pressed={strongestOnly}
          aria-keyshortcuts="D"
          aria-label="Main conflict"
          title="Focus the main conflict (D)"
        >
          <span className="toolbar__button-icon toolbar__button-icon--conflict" aria-hidden="true" />
          <span className="toolbar__label toolbar__label--desktop">Main conflict</span>
          <span className="toolbar__label toolbar__label--mobile">Conflict</span>
        </button>
        <button
          type="button"
          className={
            unresolvedOnly
              ? "button button--primary button--small toolbar__action toolbar__action--gaps"
              : "button button--ghost button--small toolbar__action toolbar__action--gaps"
          }
          onClick={onToggleUnresolved}
          disabled={!canFocusUnresolved}
          aria-pressed={unresolvedOnly}
          aria-keyshortcuts="U"
          aria-label="Open gaps"
          title="Show open gaps (U)"
        >
          <span className="toolbar__button-icon toolbar__button-icon--gaps" aria-hidden="true" />
          <span className="toolbar__label toolbar__label--desktop">Open gaps</span>
          <span className="toolbar__label toolbar__label--mobile">Gaps</span>
        </button>
        <button
          type="button"
          className="button button--ghost button--small toolbar__action toolbar__action--reset"
          onClick={onResetView}
          aria-keyshortcuts="Escape"
          aria-label="Reset"
          title="Reset the graph view (Escape)"
        >
          <span className="toolbar__button-icon toolbar__button-icon--reset" aria-hidden="true" />
          <span className="toolbar__label">Reset</span>
        </button>
        {onOpenMobileFilters ? (
          <button
            type="button"
            ref={mobileFilterTriggerRef}
            className="button button--ghost button--small toolbar__action toolbar__action--filters toolbar__mobile-filters-trigger"
            onClick={onOpenMobileFilters}
            aria-expanded={mobileFiltersOpen}
            aria-controls="workspace-mobile-filter-sheet"
            aria-label="Filters"
          >
            <span className="toolbar__button-icon toolbar__button-icon--filters" aria-hidden="true" />
            <span className="toolbar__label">Filters</span>
          </button>
        ) : null}
        {strongestOnly && clusterCount > 1 ? (
          <>
            <button
              type="button"
              className="button button--ghost button--small toolbar__cluster-nav"
              onClick={onPreviousCluster}
              aria-keyshortcuts="["
              title="Focus the previous conflict ([)"
            >
              Previous
            </button>
            <button
              type="button"
              className="button button--ghost button--small toolbar__cluster-nav"
              onClick={onNextCluster}
              aria-keyshortcuts="]"
              title="Focus the next conflict (])"
            >
              Next
            </button>
            <span className="pill pill--neutral">
              Conflict {focusedClusterIndex + 1} / {clusterCount}
            </span>
          </>
        ) : null}
        {strongestOnly && clusterCount > 1 && onSelectCluster ? (
          <details className="toolbar__cluster-menu">
            <summary>
              Conflict {focusedClusterIndex + 1} / {clusterCount}
            </summary>
            <div className="toolbar__cluster-menu-body">
              <label className="toolbar__select">
                <span className="toolbar__select-label">Conflict</span>
                <select
                  value={focusedClusterId ?? ""}
                  onChange={(event) => onSelectCluster(event.target.value)}
                >
                  {clusterOptions.map((cluster, index) => (
                    <option key={cluster.id} value={cluster.id}>
                      {`#${index + 1} ${cluster.title} (${Math.round(cluster.score * 100)}%)`}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </details>
        ) : null}
        {strongestOnly && focusedClusterTitle && clusterCount <= 1 ? (
          <span className="pill pill--neutral">{focusedClusterTitle}</span>
        ) : null}
      </div>

      <div className="toolbar__group toolbar__group--wrap">
        <div className="toolbar__kind-block">
          <span className="toolbar__group-label">Filter</span>
          <KindFilterButtons
            hiddenKinds={hiddenKinds}
            kindCounts={kindCounts}
            onToggleKind={onToggleKind}
          />
        </div>
      </div>
      {mobileFiltersOpen ? (
        <section
          id="workspace-mobile-filter-sheet"
          className="toolbar__mobile-filter-sheet"
          aria-label="Map filters"
        >
          <div className="toolbar__mobile-filter-sheet-header">
            <div>
              <p className="eyebrow">Filter map</p>
              <h2>Visible node types</h2>
            </div>
            <button
              type="button"
              ref={mobileFilterCloseButtonRef}
              className="button button--ghost button--small"
              onClick={onCloseMobileFilters}
            >
              Close
            </button>
          </div>
          <div className="toolbar__mobile-filter-grid">
            <KindFilterButtons
              hiddenKinds={hiddenKinds}
              kindCounts={kindCounts}
              onToggleKind={onToggleKind}
            />
          </div>
          {strongestOnly && clusterCount > 1 && onSelectCluster ? (
            <label className="toolbar__select toolbar__select--mobile">
              <span className="toolbar__select-label">Conflict focus</span>
              <select
                value={focusedClusterId ?? ""}
                onChange={(event) => onSelectCluster(event.target.value)}
              >
                {clusterOptions.map((cluster, index) => (
                  <option key={cluster.id} value={cluster.id}>
                    {`#${index + 1} ${cluster.title} (${Math.round(cluster.score * 100)}%)`}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
