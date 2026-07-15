"use client";

import type { Run } from "@/types/claimgraph";
import type { PublicGraphQuality } from "@/lib/graph/public-quality";

interface RunStatusBannerProps {
  run: Run | null;
  starterMode: boolean;
  graphSourceLabel: string;
  publicGraphQuality: PublicGraphQuality;
  sourceCountLabel: string;
  nodeCount: number;
  openGapCount: number;
  strongestDisagreementScore: number | null;
}

function isActiveStatus(status?: Run["status"]): boolean {
  return (
    status === "queued" ||
    status === "ingesting" ||
    status === "gathering" ||
    status === "extracting" ||
    status === "assembling"
  );
}

function formatPercent(score: number | null): string | null {
  if (score === null || Number.isNaN(score)) {
    return null;
  }

  return `${Math.round(score * 100)}%`;
}

function buildStatus(
  run: Run | null,
  starterMode: boolean,
  publicGraphQuality: PublicGraphQuality,
  graphSourceLabel: string
): {
  label: string;
  tone: "ready" | "working" | "complete" | "warning";
  message: string;
} {
  if (isActiveStatus(run?.status)) {
    return {
      label: "Building graph",
      tone: "working",
      message: "ClaimGraph is reading the sources and updating the map.",
    };
  }

  if (run?.status === "failed") {
    return {
      label: "Not enough evidence",
      tone: "warning",
      message:
        "The graph could not be rebuilt from the current sources. The saved map remains available.",
    };
  }

  if (starterMode) {
    return {
      label: "Curated demo",
      tone: "ready",
      message:
        "This is sample starter data. Add sources and rebuild before treating it as evidence-backed.",
    };
  }

  if (run?.status === "completed") {
    return {
      label:
        graphSourceLabel === "Web-sourced graph" || publicGraphQuality.label !== "Graph complete"
          ? publicGraphQuality.label
          : "Graph complete",
      tone: publicGraphQuality.tone,
      message:
        graphSourceLabel === "Web-sourced graph" || publicGraphQuality.label !== "Graph complete"
          ? publicGraphQuality.message
          : "The map is ready to inspect.",
    };
  }

  if (run?.status === "canceled") {
    return {
      label: "Build canceled",
      tone: "warning",
      message: "The latest build was canceled. The saved map remains available.",
    };
  }

  return {
    label: "Ready",
    tone: "ready",
    message: "Add or review sources, then build the argument map.",
  };
}

export function RunStatusBanner({
  run,
  starterMode,
  graphSourceLabel,
  publicGraphQuality,
  sourceCountLabel,
  nodeCount,
  openGapCount,
  strongestDisagreementScore,
}: RunStatusBannerProps) {
  const strongestDisagreement = formatPercent(strongestDisagreementScore);
  const status = buildStatus(
    run,
    starterMode,
    publicGraphQuality,
    graphSourceLabel
  );
  const mainConflictLabel = strongestDisagreement
    ? `Main conflict ${strongestDisagreement}`
    : run?.status === "completed" && !starterMode
      ? "Main conflict not found"
      : "Main conflict pending";

  return (
    <section className={`status-banner status-banner--public status-banner--${status.tone}`}>
      <div className="status-banner__summary">
        <span className="status-banner__dot" aria-hidden="true" />
        <div>
          <p className="status-banner__label">{status.label}</p>
          <p className="status-banner__message">{status.message}</p>
        </div>
      </div>

      <div className="status-banner__facts" aria-label="Map summary">
        <span>{sourceCountLabel}</span>
        <span>{nodeCount} nodes</span>
        <span>{mainConflictLabel}</span>
        <span>{openGapCount} open gaps</span>
      </div>
    </section>
  );
}
