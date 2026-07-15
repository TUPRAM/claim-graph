import { Handle, Position } from "@xyflow/react";
import type { CSSProperties, PropsWithChildren } from "react";

export interface NodeShellProps extends PropsWithChildren {
  tone: "question" | "claim" | "counterclaim" | "evidence" | "gap";
  kindLabel: string;
  title: string;
  summary: string;
  stance?: string;
  confidence?: number;
  sourceCount?: number;
  selected?: boolean;
  sourcePosition?: Position;
  targetPosition?: Position;
}

export function NodeShell({
  tone,
  kindLabel,
  title,
  summary,
  stance,
  sourceCount,
  selected,
  sourcePosition = Position.Bottom,
  targetPosition = Position.Top
}: NodeShellProps) {
  const normalizedSummary = summary.trim();
  const showSummary =
    tone === "question" &&
    normalizedSummary.length > 0 &&
    normalizedSummary.toLowerCase() !== title.trim().toLowerCase();
  const showFooter = typeof sourceCount === "number" && sourceCount > 0;
  const hiddenHandleStyle: CSSProperties = {
    width: 10,
    height: 10,
    opacity: 0,
    pointerEvents: "none",
    border: 0,
    background: "transparent"
  };

  return (
    <div
      className={[
        "graph-node",
        `graph-node--${tone}`,
        selected ? "graph-node--selected" : ""
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <Handle
        type="target"
        position={targetPosition}
        style={hiddenHandleStyle}
      />
      <Handle
        type="source"
        position={sourcePosition}
        style={hiddenHandleStyle}
      />
      <div className="graph-node__accent" aria-hidden="true" />
      <div className="graph-node__header">
        <span className="graph-node__kind">{kindLabel}</span>
        {stance ? <span className="graph-node__badge">{stance}</span> : null}
      </div>
      <h3 className="graph-node__title">{title}</h3>
      {showSummary ? <p className="graph-node__summary">{normalizedSummary}</p> : null}
      {showFooter ? (
        <div className="graph-node__footer">
          <span
            className="graph-node__meta"
            aria-label={`${sourceCount} linked source${sourceCount === 1 ? "" : "s"}`}
          >
            <span className="graph-node__meta-dot" aria-hidden="true" />
            {sourceCount} source{sourceCount === 1 ? "" : "s"}
          </span>
        </div>
      ) : null}
    </div>
  );
}
