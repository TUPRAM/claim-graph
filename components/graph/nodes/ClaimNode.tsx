import type { NodeProps } from "@xyflow/react";
import type { FlowNode } from "@/lib/graph/transforms";
import { NodeShell } from "./NodeShell";

export function ClaimNode({
  data,
  selected,
  sourcePosition,
  targetPosition
}: NodeProps<FlowNode>) {
  return (
    <NodeShell
      tone="claim"
      kindLabel="Claim"
      title={data.title}
      summary={data.summary}
      stance={data.stance}
      confidence={data.confidence}
      sourceCount={data.sourceCount}
      selected={selected}
      sourcePosition={sourcePosition}
      targetPosition={targetPosition}
    />
  );
}
