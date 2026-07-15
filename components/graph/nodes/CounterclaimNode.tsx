import type { NodeProps } from "@xyflow/react";
import type { FlowNode } from "@/lib/graph/transforms";
import { NodeShell } from "./NodeShell";

export function CounterclaimNode({
  data,
  selected,
  sourcePosition,
  targetPosition
}: NodeProps<FlowNode>) {
  return (
    <NodeShell
      tone="counterclaim"
      kindLabel="Counterclaim"
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
