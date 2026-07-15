export type ClaimGraphDurableRunnerProvider = "vercel-workflow";

export function isWorkflowDurableAnalysisEnabled(
  env: NodeJS.ProcessEnv = process.env
) {
  const value =
    env.CLAIMGRAPH_DURABLE_RUNNER?.trim().toLowerCase() ??
    env.CLAIMGRAPH_DURABLE_ANALYSIS?.trim().toLowerCase();

  return value === "workflow" || value === "vercel-workflow";
}

export function getDurableAnalysisSummary(
  env: NodeJS.ProcessEnv = process.env
) {
  const configured = isWorkflowDurableAnalysisEnabled(env);

  return {
    provider: "vercel-workflow" satisfies ClaimGraphDurableRunnerProvider,
    implemented: true,
    configured,
    message: configured
      ? "Workflow-backed hosted analysis is enabled. Public status remains in Neon while workflow internals stay out of public routes."
      : "Workflow-backed hosted analysis is implemented but disabled until CLAIMGRAPH_DURABLE_RUNNER=workflow is configured."
  };
}
