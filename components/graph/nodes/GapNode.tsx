import type { NodeProps } from "@xyflow/react";
import type { FlowNode } from "@/lib/graph/transforms";
import { NodeShell } from "./NodeShell";

export function GapNode({
  data,
  selected,
  sourcePosition,
  targetPosition
}: NodeProps<FlowNode>) {
  return (
    <NodeShell
      tone="gap"
      kindLabel="Open gap"
      title={data.title}
      summary={data.summary}
      confidence={data.confidence}
      sourceCount={data.sourceCount}
      selected={selected}
      sourcePosition={sourcePosition}
      targetPosition={targetPosition}
    />
  );
}
