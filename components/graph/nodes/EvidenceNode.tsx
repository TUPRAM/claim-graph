import type { NodeProps } from "@xyflow/react";
import type { FlowNode } from "@/lib/graph/transforms";
import { NodeShell } from "./NodeShell";

export function EvidenceNode({
  data,
  selected,
  sourcePosition,
  targetPosition
}: NodeProps<FlowNode>) {
  return (
    <NodeShell
      tone="evidence"
      kindLabel="Evidence"
      title={data.title}
      summary={data.summary}
      sourceCount={data.sourceCount}
      selected={selected}
      sourcePosition={sourcePosition}
      targetPosition={targetPosition}
    />
  );
}
