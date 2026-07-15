import type { NodeProps } from "@xyflow/react";
import type { FlowNode } from "@/lib/graph/transforms";
import { NodeShell } from "./NodeShell";

export function QuestionNode({
  data,
  selected,
  sourcePosition,
  targetPosition
}: NodeProps<FlowNode>) {
  return (
    <NodeShell
      tone="question"
      kindLabel="Question"
      title={data.title}
      summary={data.summary}
      sourceCount={0}
      selected={selected}
      sourcePosition={sourcePosition}
      targetPosition={targetPosition}
    />
  );
}
