import { rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Run, WorkspaceGraphPayload } from "@/types/claimgraph";
import { withDevSession } from "./helpers/dev-auth";
import { getWorkspaceOwnerCookie } from "./helpers/workspace-capability";

const originalDataDir = process.env.CLAIMGRAPH_DATA_DIR;
const originalApiKey = process.env.OPENAI_API_KEY;
const originalHeartbeatMs = process.env.CLAIMGRAPH_RUN_HEARTBEAT_MS;
const originalStaleAfterMs = process.env.CLAIMGRAPH_RUN_STALE_AFTER_MS;
const testDataDir = path.join(process.cwd(), "runtime_data", "test_state", "analyze-route");

function workspaceRouteContext(workspaceId: string) {
  return {
    params: Promise.resolve({ workspaceId })
  };
}

function runRouteContext(runId: string) {
  return {
    params: Promise.resolve({ runId })
  };
}

async function importRoutes() {
  const runnerModule = await import("@/lib/server/analyze-runner");
  const storeModule = await import("@/lib/server/store");
  const createWorkspaceRouteImpl = (await import("@/app/api/workspaces/route")).POST;
  const analyzeWorkspaceRouteImpl = (
    await import("@/app/api/workspaces/[workspaceId]/analyze/route")
  ).POST;
  const getDevGraphRoute = (
    await import("@/app/api/dev/workspaces/[workspaceId]/graph/route")
  ).GET;
  const runRouteModule = await import("@/app/api/runs/[runId]/route");
  const devRunRouteModule = await import("@/app/api/dev/runs/[runId]/route");
  let ownerCookie: string | null = null;
  const withOwnerCapability = (request: Request) => {
    if (!ownerCookie) {
      return request;
    }

    const headers = new Headers(request.headers);
    headers.set("Cookie", ownerCookie);
    headers.set("Origin", new URL(request.url).origin);
    return new Request(request, { headers });
  };
  const createWorkspaceRoute: typeof createWorkspaceRouteImpl = async (request) => {
    const response = await createWorkspaceRouteImpl(request);

    if (response.ok) {
      ownerCookie = getWorkspaceOwnerCookie(response);
    }

    return response;
  };
  const analyzeWorkspaceRoute: typeof analyzeWorkspaceRouteImpl = (request, context) =>
    analyzeWorkspaceRouteImpl(withOwnerCapability(request), context);

  return {
    runnerModule,
    storeModule,
    createWorkspaceRoute,
    analyzeWorkspaceRoute,
    getGraphRoute: ((request, context) =>
      getDevGraphRoute(withDevSession(request), context)) as typeof getDevGraphRoute,
    getRunRoute: ((request, context) =>
      devRunRouteModule.GET(withDevSession(request), context)) as typeof devRunRouteModule.GET,
    deleteRunRoute: ((request, context) =>
      runRouteModule.DELETE(
        withOwnerCapability(request),
        context
      )) as typeof runRouteModule.DELETE
  };
}

async function waitForRunToReachTerminal(
  getRunRoute: typeof import("@/app/api/runs/[runId]/route").GET,
  runId: string
) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await getRunRoute(
      new Request(`http://localhost/api/runs/${runId}`),
      runRouteContext(runId)
    );
    const payload = (await response.json()) as Run;

    if (
      payload.status === "completed" ||
      payload.status === "failed" ||
      payload.status === "canceled" ||
      payload.status === "insufficient_evidence"
    ) {
      return payload;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(`Timed out waiting for run ${runId} to finish.`);
}

describe("workspace analyze route", () => {
  beforeEach(() => {
    process.env.CLAIMGRAPH_DATA_DIR = testDataDir;
    rmSync(testDataDir, { recursive: true, force: true });
    delete process.env.CLAIMGRAPH_RUN_HEARTBEAT_MS;
    delete process.env.CLAIMGRAPH_RUN_STALE_AFTER_MS;
    vi.resetModules();
    vi.doUnmock("@/lib/openai/evidence");
    vi.doUnmock("@/lib/openai/extraction");
    vi.doUnmock("@/lib/openai/assemble");
  });

  afterAll(() => {
    rmSync(testDataDir, { recursive: true, force: true });
    vi.resetModules();

    if (originalDataDir === undefined) {
      delete process.env.CLAIMGRAPH_DATA_DIR;
    } else {
      process.env.CLAIMGRAPH_DATA_DIR = originalDataDir;
    }

    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }

    if (originalHeartbeatMs === undefined) {
      delete process.env.CLAIMGRAPH_RUN_HEARTBEAT_MS;
    } else {
      process.env.CLAIMGRAPH_RUN_HEARTBEAT_MS = originalHeartbeatMs;
    }

    if (originalStaleAfterMs === undefined) {
      delete process.env.CLAIMGRAPH_RUN_STALE_AFTER_MS;
    } else {
      process.env.CLAIMGRAPH_RUN_STALE_AFTER_MS = originalStaleAfterMs;
    }
  });

  it("persists a live graph after a detached analysis run completes", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    vi.doMock("@/lib/openai/evidence", () => ({
      gatherEvidence: vi.fn(async () => ({
        model: "gpt-5.4",
        responseId: "resp_success",
        evidencePack: {
          question: "Should cities ban cars downtown?",
          summary: "Live evidence points to air-quality gains with mixed retail effects.",
          subquestions: ["What happens to local retail?"],
          evidenceAxes: [
            {
              id: "axis_1",
              label: "Environment",
              description: "Air quality outcomes.",
              snippetIds: ["snippet_1"]
            }
          ],
          sources: [
            {
              id: "source_1",
              type: "web",
              title: "Air Quality Study",
              url: "https://example.com/air",
              domain: "example.com"
            }
          ],
          snippets: [
            {
              id: "snippet_1",
              sourceId: "source_1",
              text: "Air quality improved after the downtown pilot.",
              rationale: "Model-cited web evidence.",
              relevance: 0.9
            }
          ],
          openQuestions: ["How important is local transit quality?"],
          warnings: []
        }
      }))
    }));
    vi.doMock("@/lib/openai/extraction", () => ({
      extractClaimsWithPro: vi.fn(async () => ({
        model: "gpt-5.4-pro",
        responseId: "resp_claims",
        claimInventory: {
          question: "Should cities ban cars downtown?",
          claims: [
            {
              id: "claim_1",
              kind: "claim",
              title: "Pedestrianization improves air quality",
              summary: "The saved evidence points to air-quality gains in downtown pilots.",
              topic: "Environment",
              stance: "pro",
              confidence: 0.81,
              evidenceQuality: "high",
              sourceIds: ["source_1"],
              snippetIds: ["snippet_1"],
              qualifiers: [],
              dependsOnGapIds: ["gap_1"]
            }
          ],
          contradictionPairs: [],
          unresolvedGaps: [
            {
              id: "gap_1",
              title: "Transit readiness varies",
              summary: "The available evidence does not settle whether transit can absorb displaced trips everywhere.",
              gapType: "mixed_evidence",
              sourceIds: ["source_1"],
              snippetIds: ["snippet_1"],
              importance: 0.74
            }
          ]
        }
      }))
    }));
    vi.doMock("@/lib/openai/assemble", () => ({
      assembleGraph: vi.fn(async () => ({
        model: "gpt-5.4",
        responseId: "resp_graph",
        graph: {
          question: "Should cities ban cars downtown?",
          graphSummary:
            "The strongest live disagreement concerns retail upside versus merchant downside, while transit readiness remains unresolved.",
          nodes: [
            {
              id: "question_root",
              kind: "question",
              title: "Should cities ban cars downtown?",
              summary: "question",
              sourceIds: [],
              snippetIds: []
            },
            {
              id: "claim_1",
              kind: "claim",
              title: "Pedestrianization improves air quality",
              summary: "The saved evidence points to air-quality gains in downtown pilots.",
              topic: "Environment",
              stance: "pro",
              confidence: 0.81,
              sourceIds: ["source_1"],
              snippetIds: ["snippet_1"]
            },
            {
              id: "gap_1",
              kind: "gap",
              title: "Transit readiness varies",
              summary: "Transit capacity still conditions the result.",
              topic: "Implementation",
              confidence: 0.74,
              sourceIds: ["source_1"],
              snippetIds: ["snippet_1"]
            },
            {
              id: "evidence_snippet_1",
              kind: "evidence",
              title: "Air Quality Study",
              summary: "Air quality improved after the downtown pilot.",
              sourceIds: ["source_1"],
              snippetIds: ["snippet_1"]
            }
          ],
          edges: [
            {
              id: "edge_question",
              from: "claim_1",
              to: "question_root",
              relation: "supports",
              strength: 0.81
            },
            {
              id: "edge_gap",
              from: "gap_1",
              to: "claim_1",
              relation: "depends_on",
              strength: 0.74
            },
            {
              id: "edge_evidence",
              from: "evidence_snippet_1",
              to: "claim_1",
              relation: "supports",
              strength: 0.9
            }
          ],
          disagreementClusters: []
        }
      }))
    }));

    const {
      runnerModule,
      storeModule,
      createWorkspaceRoute,
      analyzeWorkspaceRoute,
      getGraphRoute,
      getRunRoute
    } = await importRoutes();
    runnerModule.resetAnalysisRunnerForTests();
    storeModule.resetStoreForTests();

    const createResponse = await createWorkspaceRoute(
      new Request("http://localhost/api/workspaces", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          question: "Should cities ban cars downtown?"
        })
      })
    );
    const createPayload = (await createResponse.json()) as { workspaceId: string };

    const analyzeResponse = await analyzeWorkspaceRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/analyze`, {
        method: "POST"
      }),
      workspaceRouteContext(createPayload.workspaceId)
    );

    expect(analyzeResponse.status).toBe(202);
    const analyzePayload = (await analyzeResponse.json()) as {
      runId: string;
      status: string;
      starterMode: boolean;
      accepted: boolean;
      created: boolean;
    };

    expect(analyzePayload).toMatchObject({
      runId: expect.any(String),
      starterMode: true,
      accepted: true,
      created: true
    });

    expect(analyzePayload.status).toMatch(/^(queued|gathering)$/);

    const completedRun = await waitForRunToReachTerminal(getRunRoute, analyzePayload.runId);

    expect(completedRun.status).toBe("completed");
    expect(completedRun.statusMessage).toContain("graph assembly completed");
    expect(completedRun.observability?.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: "queued" }),
        expect.objectContaining({ stage: "gathering", model: "gpt-5.4" }),
        expect.objectContaining({ stage: "extracting", model: "gpt-5.4-pro" }),
        expect.objectContaining({ stage: "assembling", model: "gpt-5.4" })
      ])
    );
    expect(completedRun.observability?.execution).toMatchObject({
      mode: "in_process",
      finishedAt: expect.any(String)
    });

    let graphResponse = await getGraphRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/graph`),
      workspaceRouteContext(createPayload.workspaceId)
    );
    let graphPayload = (await graphResponse.json()) as WorkspaceGraphPayload;

    expect(graphPayload.evidence?.responseId).toBe("resp_success");
    expect(graphPayload.claimInventory?.responseId).toBe("resp_claims");
    expect(graphPayload.starterMode).toBe(false);
    expect(graphPayload.graph.graphSummary).toContain("live disagreement");

    storeModule.resetStoreForTests();
    runnerModule.resetAnalysisRunnerForTests();

    graphResponse = await getGraphRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/graph`),
      workspaceRouteContext(createPayload.workspaceId)
    );
    graphPayload = (await graphResponse.json()) as WorkspaceGraphPayload;

    expect(graphPayload.evidence?.responseId).toBe("resp_success");
    expect(graphPayload.claimInventory?.responseId).toBe("resp_claims");
    expect(graphPayload.starterMode).toBe(false);
  });

  it("marks the run failed and keeps the starter fallback when gatherEvidence throws", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    vi.doMock("@/lib/openai/evidence", () => ({
      gatherEvidence: vi.fn(async () => {
        throw new Error("Responses API unavailable");
      })
    }));

    const {
      runnerModule,
      storeModule,
      createWorkspaceRoute,
      analyzeWorkspaceRoute,
      getGraphRoute,
      getRunRoute
    } = await importRoutes();
    runnerModule.resetAnalysisRunnerForTests();
    storeModule.resetStoreForTests();

    const createResponse = await createWorkspaceRoute(
      new Request("http://localhost/api/workspaces", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          question: "Should cities ban cars downtown?"
        })
      })
    );
    const createPayload = (await createResponse.json()) as { workspaceId: string };

    const analyzeResponse = await analyzeWorkspaceRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/analyze`, {
        method: "POST"
      }),
      workspaceRouteContext(createPayload.workspaceId)
    );

    expect(analyzeResponse.status).toBe(202);
    const analyzePayload = (await analyzeResponse.json()) as {
      runId: string;
      status: string;
    };

    const failedRun = await waitForRunToReachTerminal(getRunRoute, analyzePayload.runId);

    expect(failedRun.status).toBe("failed");
    expect(failedRun.errorMessage).toContain("Responses API unavailable");
    expect(failedRun.observability?.fallbackReason).toBe("gathering_failed");

    const graphResponse = await getGraphRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/graph`),
      workspaceRouteContext(createPayload.workspaceId)
    );
    const graphPayload = (await graphResponse.json()) as WorkspaceGraphPayload;

    expect(graphPayload.starterMode).toBe(true);
    expect(graphPayload.evidence).toBeNull();
    expect(graphPayload.claimInventory).toBeNull();
    expect(graphPayload.run).toBeNull();
    expect(graphPayload.latestRun?.status).toBe("failed");
    expect(graphPayload.latestRun?.errorMessage).toContain("Responses API unavailable");
    expect(graphPayload.latestRunArtifacts).toMatchObject({
      runId: analyzePayload.runId,
      evidence: null,
      claimInventory: null
    });
  });

  it("marks the run as insufficient evidence and keeps the safe graph path when grounded snippets are missing", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    vi.doMock("@/lib/openai/evidence", () => ({
      gatherEvidence: vi.fn(async () => ({
        model: "gpt-5.4",
        responseId: "resp_thin_evidence",
        groundingStatus: "insufficient_grounding" as const,
        evidencePack: {
          question: "Should cities ban cars downtown?",
          summary: "The search pass raised open questions but did not preserve grounded snippets.",
          groundingStatus: "insufficient_grounding" as const,
          subquestions: ["What evidence is still missing?"],
          evidenceAxes: [],
          sources: [],
          snippets: [],
          openQuestions: ["Which sources directly address local transit readiness?"],
          warnings: [
            "No grounded source snippets were preserved for this run. ClaimGraph will keep the most recent safe graph path and surface the unresolved evidence state instead of fabricating a live graph."
          ]
        }
      }))
    }));

    const {
      runnerModule,
      storeModule,
      createWorkspaceRoute,
      analyzeWorkspaceRoute,
      getGraphRoute,
      getRunRoute
    } = await importRoutes();
    runnerModule.resetAnalysisRunnerForTests();
    storeModule.resetStoreForTests();

    const createResponse = await createWorkspaceRoute(
      new Request("http://localhost/api/workspaces", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          question: "Should cities ban cars downtown?"
        })
      })
    );
    const createPayload = (await createResponse.json()) as { workspaceId: string };

    const analyzeResponse = await analyzeWorkspaceRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/analyze`, {
        method: "POST"
      }),
      workspaceRouteContext(createPayload.workspaceId)
    );

    expect(analyzeResponse.status).toBe(202);
    const analyzePayload = (await analyzeResponse.json()) as { runId: string };

    const insufficientRun = await waitForRunToReachTerminal(getRunRoute, analyzePayload.runId);

    expect(insufficientRun.status).toBe("insufficient_evidence");
    expect(insufficientRun.statusMessage).toContain("not enough grounded snippets");
    expect(insufficientRun.observability?.fallbackReason).toBe("insufficient_grounding");

    const graphResponse = await getGraphRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/graph`),
      workspaceRouteContext(createPayload.workspaceId)
    );
    const graphPayload = (await graphResponse.json()) as WorkspaceGraphPayload;

    expect(graphPayload.starterMode).toBe(true);
    expect(graphPayload.run).toBeNull();
    expect(graphPayload.evidence).toBeNull();
    expect(graphPayload.claimInventory).toBeNull();
    expect(graphPayload.latestRun?.status).toBe("insufficient_evidence");
    expect(graphPayload.latestRunArtifacts?.evidence?.responseId).toBe(
      "resp_thin_evidence"
    );
    expect(
      graphPayload.latestRunArtifacts?.evidence?.evidencePack.groundingStatus
    ).toBe("insufficient_grounding");
    expect(graphPayload.latestRunArtifacts?.claimInventory).toBeNull();
    expect(graphPayload.graph.graphSummary).toBeTruthy();
  });

  it("keeps the saved evidence pack when claim extraction fails after retrieval succeeds", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    vi.doMock("@/lib/openai/evidence", () => ({
      gatherEvidence: vi.fn(async () => ({
        model: "gpt-5.4",
        responseId: "resp_success",
        evidencePack: {
          question: "Should cities ban cars downtown?",
          summary: "Live evidence points to air-quality gains with mixed retail effects.",
          subquestions: ["What happens to local retail?"],
          evidenceAxes: [
            {
              id: "axis_1",
              label: "Environment",
              description: "Air quality outcomes.",
              snippetIds: ["snippet_1"]
            }
          ],
          sources: [
            {
              id: "source_1",
              type: "web",
              title: "Air Quality Study",
              url: "https://example.com/air",
              domain: "example.com"
            }
          ],
          snippets: [
            {
              id: "snippet_1",
              sourceId: "source_1",
              text: "Air quality improved after the downtown pilot.",
              rationale: "Model-cited web evidence.",
              relevance: 0.9
            }
          ],
          openQuestions: ["How important is local transit quality?"],
          warnings: []
        }
      }))
    }));
    vi.doMock("@/lib/openai/extraction", () => ({
      extractClaimsWithPro: vi.fn(async () => {
        throw new Error("Claim extraction failed");
      })
    }));

    const {
      runnerModule,
      storeModule,
      createWorkspaceRoute,
      analyzeWorkspaceRoute,
      getGraphRoute,
      getRunRoute
    } = await importRoutes();
    runnerModule.resetAnalysisRunnerForTests();
    storeModule.resetStoreForTests();

    const createResponse = await createWorkspaceRoute(
      new Request("http://localhost/api/workspaces", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          question: "Should cities ban cars downtown?"
        })
      })
    );
    const createPayload = (await createResponse.json()) as { workspaceId: string };

    const analyzeResponse = await analyzeWorkspaceRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/analyze`, {
        method: "POST"
      }),
      workspaceRouteContext(createPayload.workspaceId)
    );
    const analyzePayload = (await analyzeResponse.json()) as { runId: string };
    const failedRun = await waitForRunToReachTerminal(getRunRoute, analyzePayload.runId);

    expect(failedRun.status).toBe("failed");
    expect(failedRun.errorMessage).toContain("Claim extraction failed");
    expect(failedRun.observability?.fallbackReason).toBe("extracting_failed");

    const graphResponse = await getGraphRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/graph`),
      workspaceRouteContext(createPayload.workspaceId)
    );
    const graphPayload = (await graphResponse.json()) as WorkspaceGraphPayload;

    expect(graphPayload.starterMode).toBe(true);
    expect(graphPayload.run).toBeNull();
    expect(graphPayload.evidence).toBeNull();
    expect(graphPayload.claimInventory).toBeNull();
    expect(graphPayload.latestRun?.status).toBe("failed");
    expect(graphPayload.latestRunArtifacts?.evidence?.responseId).toBe("resp_success");
    expect(graphPayload.latestRunArtifacts?.claimInventory).toBeNull();
  });

  it("keeps the saved evidence pack and claim inventory when graph assembly fails", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    vi.doMock("@/lib/openai/evidence", () => ({
      gatherEvidence: vi.fn(async () => ({
        model: "gpt-5.4",
        responseId: "resp_success",
        evidencePack: {
          question: "Should cities ban cars downtown?",
          summary: "Live evidence points to air-quality gains with mixed retail effects.",
          subquestions: ["What happens to local retail?"],
          evidenceAxes: [
            {
              id: "axis_1",
              label: "Environment",
              description: "Air quality outcomes.",
              snippetIds: ["snippet_1"]
            }
          ],
          sources: [
            {
              id: "source_1",
              type: "web",
              title: "Air Quality Study",
              url: "https://example.com/air",
              domain: "example.com"
            }
          ],
          snippets: [
            {
              id: "snippet_1",
              sourceId: "source_1",
              text: "Air quality improved after the downtown pilot.",
              rationale: "Model-cited web evidence.",
              relevance: 0.9
            }
          ],
          openQuestions: ["How important is local transit quality?"],
          warnings: []
        }
      }))
    }));
    vi.doMock("@/lib/openai/extraction", () => ({
      extractClaimsWithPro: vi.fn(async () => ({
        model: "gpt-5.4-pro",
        responseId: "resp_claims",
        claimInventory: {
          question: "Should cities ban cars downtown?",
          claims: [
            {
              id: "claim_1",
              kind: "claim",
              title: "Pedestrianization improves air quality",
              summary: "The saved evidence points to air-quality gains in downtown pilots.",
              topic: "Environment",
              stance: "pro",
              confidence: 0.81,
              evidenceQuality: "high",
              sourceIds: ["source_1"],
              snippetIds: ["snippet_1"],
              qualifiers: [],
              dependsOnGapIds: ["gap_1"]
            }
          ],
          contradictionPairs: [],
          unresolvedGaps: [
            {
              id: "gap_1",
              title: "Transit readiness varies",
              summary: "The available evidence does not settle whether transit can absorb displaced trips everywhere.",
              gapType: "mixed_evidence",
              sourceIds: ["source_1"],
              snippetIds: ["snippet_1"],
              importance: 0.74
            }
          ]
        }
      }))
    }));
    vi.doMock("@/lib/openai/assemble", () => ({
      assembleGraph: vi.fn(async () => {
        throw new Error("Graph assembly failed");
      })
    }));

    const {
      runnerModule,
      storeModule,
      createWorkspaceRoute,
      analyzeWorkspaceRoute,
      getGraphRoute,
      getRunRoute
    } = await importRoutes();
    runnerModule.resetAnalysisRunnerForTests();
    storeModule.resetStoreForTests();

    const createResponse = await createWorkspaceRoute(
      new Request("http://localhost/api/workspaces", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          question: "Should cities ban cars downtown?"
        })
      })
    );
    const createPayload = (await createResponse.json()) as { workspaceId: string };

    const analyzeResponse = await analyzeWorkspaceRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/analyze`, {
        method: "POST"
      }),
      workspaceRouteContext(createPayload.workspaceId)
    );
    const analyzePayload = (await analyzeResponse.json()) as { runId: string };
    const failedRun = await waitForRunToReachTerminal(getRunRoute, analyzePayload.runId);

    expect(failedRun.status).toBe("failed");
    expect(failedRun.errorMessage).toContain("Graph assembly failed");
    expect(failedRun.observability?.fallbackReason).toBe("assembling_failed");

    const graphResponse = await getGraphRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/graph`),
      workspaceRouteContext(createPayload.workspaceId)
    );
    const graphPayload = (await graphResponse.json()) as WorkspaceGraphPayload;

    expect(graphPayload.starterMode).toBe(true);
    expect(graphPayload.run).toBeNull();
    expect(graphPayload.evidence).toBeNull();
    expect(graphPayload.claimInventory).toBeNull();
    expect(graphPayload.latestRun?.status).toBe("failed");
    expect(graphPayload.latestRunArtifacts?.evidence?.responseId).toBe("resp_success");
    expect(graphPayload.latestRunArtifacts?.claimInventory?.responseId).toBe(
      "resp_claims"
    );
  });

  it("cancels a queued run honestly", async () => {
    const {
      runnerModule,
      storeModule,
      createWorkspaceRoute,
      deleteRunRoute,
      getRunRoute
    } = await importRoutes();
    runnerModule.resetAnalysisRunnerForTests();
    storeModule.resetStoreForTests();

    const createResponse = await createWorkspaceRoute(
      new Request("http://localhost/api/workspaces", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          question: "Should cities ban cars downtown?"
        })
      })
    );
    const createPayload = (await createResponse.json()) as { workspaceId: string };
    const queuedRun = storeModule.createRun(createPayload.workspaceId, {
      staleAfterMs: 60_000
    });

    const cancelResponse = await deleteRunRoute(
      new Request(`http://localhost/api/runs/${queuedRun.id}`, {
        method: "DELETE"
      }),
      runRouteContext(queuedRun.id)
    );

    expect(cancelResponse.status).toBe(200);
    const cancelPayload = (await cancelResponse.json()) as {
      accepted: boolean;
      run: Run;
    };

    expect(cancelPayload.accepted).toBe(true);
    expect(cancelPayload.run.status).toBe("canceled");
    expect(cancelPayload.run.observability).toBeUndefined();

    const runResponse = await getRunRoute(
      new Request(`http://localhost/api/runs/${queuedRun.id}`),
      runRouteContext(queuedRun.id)
    );
    const runPayload = (await runResponse.json()) as Run;

    expect(runPayload.status).toBe("canceled");
    expect(runPayload.statusMessage).toContain("Queued analysis canceled");
  });

  it("cancels an in-flight run and allows a clean rerun", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const successfulEvidence = {
      model: "gpt-5.4",
      responseId: "resp_success_after_cancel",
      evidencePack: {
        question: "Should cities ban cars downtown?",
        summary: "Live evidence points to air-quality gains with mixed retail effects.",
        subquestions: ["What happens to local retail?"],
        evidenceAxes: [
          {
            id: "axis_1",
            label: "Environment",
            description: "Air quality outcomes.",
            snippetIds: ["snippet_1"]
          }
        ],
        sources: [
          {
            id: "source_1",
            type: "web" as const,
            title: "Air Quality Study",
            url: "https://example.com/air",
            domain: "example.com"
          }
        ],
        snippets: [
          {
            id: "snippet_1",
            sourceId: "source_1",
            text: "Air quality improved after the downtown pilot.",
            rationale: "Model-cited web evidence.",
            relevance: 0.9
          }
        ],
        openQuestions: ["How important is local transit quality?"],
        warnings: []
      }
    };

    const gatherEvidence = vi
      .fn()
      .mockImplementationOnce(async (input: { signal?: AbortSignal }) => {
        await new Promise<void>((resolve, reject) => {
          const timeoutHandle = setTimeout(resolve, 30_000);

          function handleAbort() {
            clearTimeout(timeoutHandle);
            reject(new DOMException("The operation was aborted.", "AbortError"));
          }

          input.signal?.addEventListener("abort", handleAbort, { once: true });
        });

        return successfulEvidence;
      })
      .mockResolvedValue(successfulEvidence);

    vi.doMock("@/lib/openai/evidence", () => ({
      gatherEvidence
    }));
    vi.doMock("@/lib/openai/extraction", () => ({
      extractClaimsWithPro: vi.fn(async () => ({
        model: "gpt-5.4-pro",
        responseId: "resp_claims_after_cancel",
        claimInventory: {
          question: "Should cities ban cars downtown?",
          claims: [
            {
              id: "claim_1",
              kind: "claim" as const,
              title: "Pedestrianization improves air quality",
              summary: "The saved evidence points to air-quality gains in downtown pilots.",
              topic: "Environment",
              stance: "pro" as const,
              confidence: 0.81,
              evidenceQuality: "high" as const,
              sourceIds: ["source_1"],
              snippetIds: ["snippet_1"],
              qualifiers: [],
              dependsOnGapIds: ["gap_1"]
            }
          ],
          contradictionPairs: [],
          unresolvedGaps: [
            {
              id: "gap_1",
              title: "Transit readiness varies",
              summary: "The available evidence does not settle whether transit can absorb displaced trips everywhere.",
              gapType: "mixed_evidence" as const,
              sourceIds: ["source_1"],
              snippetIds: ["snippet_1"],
              importance: 0.74
            }
          ]
        }
      }))
    }));
    vi.doMock("@/lib/openai/assemble", () => ({
      assembleGraph: vi.fn(async () => ({
        model: "gpt-5.4",
        responseId: "resp_graph_after_cancel",
        graph: {
          question: "Should cities ban cars downtown?",
          graphSummary:
            "The strongest live disagreement concerns retail upside versus merchant downside, while transit readiness remains unresolved.",
          nodes: [
            {
              id: "question_root",
              kind: "question" as const,
              title: "Should cities ban cars downtown?",
              summary: "question",
              sourceIds: [],
              snippetIds: []
            },
            {
              id: "claim_1",
              kind: "claim" as const,
              title: "Pedestrianization improves air quality",
              summary: "The saved evidence points to air-quality gains in downtown pilots.",
              topic: "Environment",
              stance: "pro" as const,
              confidence: 0.81,
              sourceIds: ["source_1"],
              snippetIds: ["snippet_1"]
            }
          ],
          edges: [
            {
              id: "edge_question",
              from: "claim_1",
              to: "question_root",
              relation: "supports" as const,
              strength: 0.81
            }
          ],
          disagreementClusters: []
        }
      }))
    }));

    const {
      runnerModule,
      storeModule,
      createWorkspaceRoute,
      analyzeWorkspaceRoute,
      getGraphRoute,
      getRunRoute,
      deleteRunRoute
    } = await importRoutes();
    runnerModule.resetAnalysisRunnerForTests();
    storeModule.resetStoreForTests();

    const createResponse = await createWorkspaceRoute(
      new Request("http://localhost/api/workspaces", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          question: "Should cities ban cars downtown?"
        })
      })
    );
    const createPayload = (await createResponse.json()) as { workspaceId: string };

    const analyzeResponse = await analyzeWorkspaceRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/analyze`, {
        method: "POST"
      }),
      workspaceRouteContext(createPayload.workspaceId)
    );
    const analyzePayload = (await analyzeResponse.json()) as {
      runId: string;
    };

    const cancelResponse = await deleteRunRoute(
      new Request(`http://localhost/api/runs/${analyzePayload.runId}`, {
        method: "DELETE"
      }),
      runRouteContext(analyzePayload.runId)
    );

    expect(cancelResponse.status).toBe(200);
    const cancelPayload = (await cancelResponse.json()) as {
      accepted: boolean;
      run: Run;
    };

    expect(cancelPayload.accepted).toBe(true);
    expect(cancelPayload.run.status).toBe("canceled");

    const canceledRun = await waitForRunToReachTerminal(getRunRoute, analyzePayload.runId);

    expect(canceledRun.status).toBe("canceled");
    expect(canceledRun.observability?.fallbackReason).toBe("analysis_canceled");
    expect(canceledRun.statusMessage).toContain("best-effort");

    const rerunResponse = await analyzeWorkspaceRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/analyze`, {
        method: "POST"
      }),
      workspaceRouteContext(createPayload.workspaceId)
    );
    const rerunPayload = (await rerunResponse.json()) as {
      runId: string;
      created: boolean;
    };

    expect(rerunPayload.created).toBe(true);
    expect(rerunPayload.runId).not.toBe(analyzePayload.runId);

    const completedRun = await waitForRunToReachTerminal(getRunRoute, rerunPayload.runId);

    expect(completedRun.status).toBe("completed");
    expect(gatherEvidence).toHaveBeenCalledTimes(2);

    const graphResponse = await getGraphRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/graph`),
      workspaceRouteContext(createPayload.workspaceId)
    );
    const graphPayload = (await graphResponse.json()) as WorkspaceGraphPayload;

    expect(graphPayload.run?.id).toBe(rerunPayload.runId);
    expect(graphPayload.run?.status).toBe("completed");
    expect(graphPayload.starterMode).toBe(false);
  });

  it("marks stale in-flight runs failed when they stop heartbeating", async () => {
    process.env.CLAIMGRAPH_RUN_STALE_AFTER_MS = "5";

    const {
      runnerModule,
      storeModule,
      createWorkspaceRoute,
      getRunRoute,
      getGraphRoute
    } = await importRoutes();
    runnerModule.resetAnalysisRunnerForTests();
    storeModule.resetStoreForTests();

    const createResponse = await createWorkspaceRoute(
      new Request("http://localhost/api/workspaces", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          question: "Should cities ban cars downtown?"
        })
      })
    );
    const createPayload = (await createResponse.json()) as { workspaceId: string };

    const run = storeModule.createRun(createPayload.workspaceId, {
      staleAfterMs: 5
    });

    storeModule.markRunExecutionStarted(run.id, {
      ownerId: "test-runner",
      startedAt: new Date(Date.now() - 20).toISOString(),
      heartbeatAt: new Date(Date.now() - 20).toISOString(),
      staleAfterMs: 5
    });
    storeModule.updateRunStatus(run.id, "gathering", "Gathering evidence.");

    const runResponse = await getRunRoute(
      new Request(`http://localhost/api/runs/${run.id}`),
      runRouteContext(run.id)
    );
    const runPayload = (await runResponse.json()) as Run;

    expect(runPayload.status).toBe("failed");
    expect(runPayload.errorMessage).toContain("stopped heartbeating");
    expect(runPayload.observability?.fallbackReason).toBe("analysis_stale");
    expect(runPayload.observability?.execution?.finishedAt).toBeTruthy();

    const graphResponse = await getGraphRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/graph`),
      workspaceRouteContext(createPayload.workspaceId)
    );
    const graphPayload = (await graphResponse.json()) as WorkspaceGraphPayload;

    expect(graphPayload.starterMode).toBe(true);
    expect(graphPayload.run).toBeNull();
    expect(graphPayload.latestRun?.status).toBe("failed");
    expect(graphPayload.latestRun?.statusMessage).toContain(
      "single-instance app runs analysis in process"
    );
  });
});
