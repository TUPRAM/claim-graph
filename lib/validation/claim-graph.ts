import { z } from "zod";
import type { ClaimGraph, Snippet, Source } from "@/types/claimgraph";

const stanceSchema = z.enum(["pro", "con", "mixed", "unknown"]);
const nodeKindSchema = z.enum([
  "question",
  "claim",
  "counterclaim",
  "evidence",
  "gap"
]);
const edgeRelationSchema = z.enum([
  "supports",
  "refutes",
  "qualifies",
  "depends_on"
]);

export const graphNodeSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    kind: nodeKindSchema,
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(800),
    topic: z.string().trim().min(1).max(120).optional(),
    stance: stanceSchema.optional(),
    confidence: z.number().min(0).max(1).optional(),
    sourceIds: z.array(z.string().trim().min(1).max(80)).max(20),
    snippetIds: z.array(z.string().trim().min(1).max(80)).max(24),
    metadata: z.record(z.string(), z.unknown()).optional()
  })
  .superRefine((node, context) => {
    if (node.kind === "question") {
      return;
    }

    if (node.sourceIds.length < 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Every non-question node must preserve at least one source id.",
        path: ["sourceIds"]
      });
    }

    if (node.snippetIds.length < 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Every non-question node must preserve at least one snippet id.",
        path: ["snippetIds"]
      });
    }

    if (node.kind === "evidence") {
      if (node.sourceIds.length !== 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Evidence nodes must preserve exactly one source id.",
          path: ["sourceIds"]
        });
      }

      if (node.snippetIds.length !== 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Evidence nodes must preserve exactly one snippet id.",
          path: ["snippetIds"]
        });
      }
    }
  })
  .strict();

export const graphEdgeSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    from: z.string().trim().min(1).max(80),
    to: z.string().trim().min(1).max(80),
    relation: edgeRelationSchema,
    strength: z.number().min(0).max(1)
  })
  .strict();

export const disagreementClusterSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    claimIds: z
      .tuple([z.string().trim().min(1).max(80), z.string().trim().min(1).max(80)])
      .refine(([left, right]) => left !== right, {
        message: "Disagreement clusters must reference two distinct claim ids."
      }),
    score: z.number().min(0).max(1),
    title: z.string().trim().min(1).max(200),
    explanation: z.string().trim().min(1).max(500),
    sourceIds: z.array(z.string().trim().min(1).max(80)).min(1).max(20),
    snippetIds: z.array(z.string().trim().min(1).max(80)).min(1).max(24)
  })
  .strict();

export const claimGraphSchema = z
  .object({
    question: z.string().trim().min(1).max(600),
    nodes: z.array(graphNodeSchema).min(1).max(25),
    edges: z.array(graphEdgeSchema).max(60),
    disagreementClusters: z.array(disagreementClusterSchema).max(6),
    primaryClusterId: z.string().trim().min(1).max(120).optional(),
    graphSummary: z.string().trim().min(1).max(1600)
  })
  .superRefine((graph, context) => {
    const questionNodes = graph.nodes.filter((node) => node.kind === "question");

    if (questionNodes.length !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A ClaimGraph must contain exactly one question node.",
        path: ["nodes"]
      });
    }

    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));

    for (const edge of graph.edges) {
      if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Every edge must reference existing node ids.",
          path: ["edges"]
        });
      }
    }

    for (const cluster of graph.disagreementClusters) {
      const leftClaim = nodeById.get(cluster.claimIds[0]);
      const rightClaim = nodeById.get(cluster.claimIds[1]);

      if (
        !leftClaim ||
        !rightClaim ||
        leftClaim.kind === "question" ||
        rightClaim.kind === "question" ||
        leftClaim.kind === "gap" ||
        rightClaim.kind === "gap" ||
        leftClaim.kind === "evidence" ||
        rightClaim.kind === "evidence"
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Disagreement clusters must point to grounded claim or counterclaim nodes.",
          path: ["disagreementClusters"]
        });
      }
    }
  })
  .strict();

export function validateClaimGraphArtifacts(input: {
  graph: ClaimGraph;
  sources: Source[];
  snippets: Snippet[];
}) {
  const graph = claimGraphSchema.parse(input.graph);
  const sourceIds = new Set(input.sources.map((source) => source.id));
  const snippetById = new Map(input.snippets.map((snippet) => [snippet.id, snippet]));

  for (const node of graph.nodes) {
    if (node.kind === "question") {
      continue;
    }

    for (const sourceId of node.sourceIds) {
      if (!sourceIds.has(sourceId)) {
        throw new Error(
          `Graph node "${node.id}" references missing source "${sourceId}".`
        );
      }
    }

    for (const snippetId of node.snippetIds) {
      const snippet = snippetById.get(snippetId);

      if (!snippet) {
        throw new Error(
          `Graph node "${node.id}" references missing snippet "${snippetId}".`
        );
      }

      if (!node.sourceIds.includes(snippet.sourceId)) {
        throw new Error(
          `Graph node "${node.id}" references snippet "${snippetId}" without preserving its source id "${snippet.sourceId}".`
        );
      }
    }
  }

  for (const cluster of graph.disagreementClusters) {
    for (const sourceId of cluster.sourceIds) {
      if (!sourceIds.has(sourceId)) {
        throw new Error(
          `Disagreement cluster "${cluster.id}" references missing source "${sourceId}".`
        );
      }
    }

    for (const snippetId of cluster.snippetIds) {
      const snippet = snippetById.get(snippetId);

      if (!snippet) {
        throw new Error(
          `Disagreement cluster "${cluster.id}" references missing snippet "${snippetId}".`
        );
      }

      if (!cluster.sourceIds.includes(snippet.sourceId)) {
        throw new Error(
          `Disagreement cluster "${cluster.id}" references snippet "${snippetId}" without preserving its source id "${snippet.sourceId}".`
        );
      }
    }
  }

  return graph;
}
