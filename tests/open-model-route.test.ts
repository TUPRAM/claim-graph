import { rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Run, WorkspaceGraphPayload } from "@/types/claimgraph";
import { buildTestDocx } from "./helpers/docx";
import { buildTestPdf } from "./helpers/pdf";
import { withDevSession } from "./helpers/dev-auth";
import { getWorkspaceOwnerCookie } from "./helpers/workspace-capability";

const requestStructuredOpenModelOutputMock = vi.hoisted(() => vi.fn());

class TestOpenModelConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenModelConfigurationError";
  }
}

class TestOpenModelBackendUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenModelBackendUnavailableError";
  }
}

class TestOpenModelModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenModelModelUnavailableError";
  }
}

vi.mock("@/lib/open-model/client", () => ({
  OpenModelConfigurationError: TestOpenModelConfigurationError,
  OpenModelBackendUnavailableError: TestOpenModelBackendUnavailableError,
  OpenModelModelUnavailableError: TestOpenModelModelUnavailableError,
  OpenModelRequestTimeoutError: class OpenModelRequestTimeoutError extends Error {
    readonly timeoutMs: number;

    constructor(message: string, timeoutMs: number) {
      super(message);
      this.name = "OpenModelRequestTimeoutError";
      this.timeoutMs = timeoutMs;
    }
  },
  requestStructuredOpenModelOutput: requestStructuredOpenModelOutputMock
}));

vi.mock("@/lib/open-model/retrieval/url-fetch", () => ({
  DefaultUrlFetchAdapter: class DefaultUrlFetchAdapter {
    readonly kind = "url-fetch" as const;

    async fetch(url: string, signal?: AbortSignal) {
      const response = await global.fetch(url, { signal });

      return {
        url,
        resolvedUrl: response.url || url,
        status: response.status,
        contentType: response.headers.get("content-type") ?? undefined,
        title: new URL(url).hostname,
        bodyText: await response.text()
      };
    }
  }
}));

const originalDataDir = process.env.CLAIMGRAPH_DATA_DIR;
const originalMode = process.env.CLAIMGRAPH_MODE;
const originalApiKey = process.env.OPENAI_API_KEY;
const originalBackend = process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND;
const originalModel = process.env.CLAIMGRAPH_OPEN_MODEL_NAME;
const originalOllamaBaseUrl = process.env.OLLAMA_BASE_URL;
const originalFetch = global.fetch;
const testDataDir = path.join(process.cwd(), "runtime_data", "test_state", "open-model-route");

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
  const getDevRunRoute = (await import("@/app/api/dev/runs/[runId]/route")).GET;
  let ownerCookie: string | null = null;
  const createWorkspaceRoute: typeof createWorkspaceRouteImpl = async (request) => {
    const response = await createWorkspaceRouteImpl(request);

    if (response.ok) {
      ownerCookie = getWorkspaceOwnerCookie(response);
    }

    return response;
  };
  const analyzeWorkspaceRoute: typeof analyzeWorkspaceRouteImpl = (request, context) => {
    if (!ownerCookie) {
      return analyzeWorkspaceRouteImpl(request, context);
    }

    const headers = new Headers(request.headers);
    headers.set("Cookie", ownerCookie);
    headers.set("Origin", new URL(request.url).origin);
    return analyzeWorkspaceRouteImpl(new Request(request, { headers }), context);
  };

  return {
    runnerModule,
    storeModule,
    createWorkspaceRoute,
    analyzeWorkspaceRoute,
    getGraphRoute: ((request, context) =>
      getDevGraphRoute(withDevSession(request), context)) as typeof getDevGraphRoute,
    getRunRoute: ((request, context) =>
      getDevRunRoute(withDevSession(request), context)) as typeof getDevRunRoute
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

describe("open-model route flow", () => {
  beforeEach(() => {
    process.env.CLAIMGRAPH_DATA_DIR = testDataDir;
    process.env.CLAIMGRAPH_MODE = "open-model";
    process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND = "ollama";
    process.env.CLAIMGRAPH_OPEN_MODEL_NAME = "qwen3:8b";
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";
    delete process.env.OPENAI_API_KEY;
    rmSync(testDataDir, { recursive: true, force: true });
    requestStructuredOpenModelOutputMock.mockReset();
    vi.resetModules();
    global.fetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url === "https://example.com/report") {
        return new Response(
          [
            "<html><head><title>Downtown Access Report</title></head><body>",
            "<article>",
            "<p>Walkable centers increased foot traffic across the pilot corridor after through-traffic was removed.</p>",
            "<p>Pickup-oriented merchants still reported losses where curb access changed and loading windows remained constrained.</p>",
            "</article>",
            "</body></html>"
          ].join(""),
          {
            status: 200,
            headers: {
              "Content-Type": "text/html"
            }
          }
        );
      }

      if (url === "https://city.gov/report") {
        return new Response(
          [
            "<html><head>",
            '<meta property="og:title" content="Downtown Freight Review" />',
            '<meta property="article:published_time" content="2026-03-02" />',
            "</head><body>",
            "<article>",
            "<p>City engineers found the freight corridor preserved loading access for morning deliveries while bus lanes reduced idle traffic across downtown.</p>",
            "<p>A retail survey recorded stronger midday foot traffic after the pilot and kept the business case contested.</p>",
            "</article>",
            "</body></html>"
          ].join(""),
          {
            status: 200,
            headers: {
              "Content-Type": "text/html"
            }
          }
        );
      }

      if (url === "https://example.com/noisy-note") {
        return new Response("<html><body><nav>Home</nav><p>legend</p></body></html>", {
          status: 200,
          headers: {
            "Content-Type": "text/html"
          }
        });
      }

      throw new Error(`Unhandled fetch request in open-model route test: ${url}`);
    }) as typeof fetch;
  });

  afterAll(() => {
    rmSync(testDataDir, { recursive: true, force: true });
    requestStructuredOpenModelOutputMock.mockReset();
    vi.resetModules();
    global.fetch = originalFetch;

    if (originalDataDir === undefined) {
      delete process.env.CLAIMGRAPH_DATA_DIR;
    } else {
      process.env.CLAIMGRAPH_DATA_DIR = originalDataDir;
    }

    if (originalMode === undefined) {
      delete process.env.CLAIMGRAPH_MODE;
    } else {
      process.env.CLAIMGRAPH_MODE = originalMode;
    }

    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }

    if (originalBackend === undefined) {
      delete process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND;
    } else {
      process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND = originalBackend;
    }

    if (originalModel === undefined) {
      delete process.env.CLAIMGRAPH_OPEN_MODEL_NAME;
    } else {
      process.env.CLAIMGRAPH_OPEN_MODEL_NAME = originalModel;
    }

    if (originalOllamaBaseUrl === undefined) {
      delete process.env.OLLAMA_BASE_URL;
    } else {
      process.env.OLLAMA_BASE_URL = originalOllamaBaseUrl;
    }
  });

  it("builds a live graph in open-model mode from a user-provided URL", async () => {
    requestStructuredOpenModelOutputMock
      .mockResolvedValueOnce({
        backend: "ollama",
        model: "qwen3:8b",
        output: {
          summary:
            "The deterministic retrieval preserves one grounded branch for business upside and one for merchant downside.",
          subquestions: ["What happens to merchant foot traffic?"],
          evidenceAxes: [
            {
              label: "Business impact",
              description: "Retail upside and merchant downside remain contested."
            }
          ],
          openQuestions: ["How much do loading windows change the result?"]
        }
      })
      .mockResolvedValueOnce({
        backend: "ollama",
        model: "qwen3:8b",
        output: {
          question: "Should cities ban cars downtown?",
          claims: [
            {
              id: "claim_1",
              kind: "claim",
              title: "Walkable centers can increase foot traffic",
              summary:
                "The retrieved report ties calmer streets to stronger foot traffic in the pilot corridor.",
              topic: "Business",
              stance: "pro",
              confidence: 0.79,
              evidenceQuality: "medium",
              sourceIds: ["src_url_1"],
              snippetIds: ["snp_url_1"],
              qualifiers: [],
              dependsOnGapIds: ["gap_1"]
            },
            {
              id: "counter_1",
              kind: "counterclaim",
              title: "Pickup-oriented merchants reported losses",
              summary:
                "The same report notes that some merchants lost sales when curb access changed.",
              topic: "Business",
              stance: "con",
              confidence: 0.74,
              evidenceQuality: "medium",
              sourceIds: ["src_url_1"],
              snippetIds: ["snp_url_1"],
              qualifiers: [],
              dependsOnGapIds: []
            }
          ],
          contradictionPairs: [
            {
              id: "pair_1",
              leftClaimId: "claim_1",
              rightClaimId: "counter_1",
              contradictionStrength: 0.77,
              explanation:
                "The business case remains contested between overall foot traffic gains and merchant-specific downside."
            }
          ],
          unresolvedGaps: [
            {
              id: "gap_1",
              title: "Loading windows remain unresolved",
              summary:
                "The report leaves freight exemptions and delivery access unresolved.",
              gapType: "mixed_evidence",
              sourceIds: ["src_url_1"],
              snippetIds: ["snp_url_1"],
              importance: 0.71
            }
          ]
        }
      })
      .mockResolvedValueOnce({
        backend: "ollama",
        model: "qwen3:8b",
        output: {
          graphSummary:
            "The strongest open-model disagreement is business upside versus merchant-specific downside, with loading access still unresolved.",
          claimSelections: [
            {
              claimId: "claim_1",
              importance: 0.82
            },
            {
              claimId: "counter_1",
              importance: 0.76
            }
          ],
          gapSelections: [
            {
              gapId: "gap_1",
              importance: 0.71
            }
          ],
          claimRelations: [
            {
              fromClaimId: "counter_1",
              toClaimId: "claim_1",
              relation: "refutes",
              strength: 0.77
            }
          ],
          gapRelations: [
            {
              gapId: "gap_1",
              claimId: "claim_1",
              relation: "depends_on",
              strength: 0.71
            }
          ],
          disagreementClusters: [
            {
              contradictionPairId: "pair_1",
              title: "Business upside versus merchant downside",
              explanation:
                "The local report supports a downtown upside but preserves explicit merchant downside.",
              topicRelevance: 0.84
            }
          ]
        }
      });

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
          question: "Should cities ban cars downtown?",
          sourceUrls: ["https://example.com/report"]
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
    const completedRun = await waitForRunToReachTerminal(getRunRoute, analyzePayload.runId);

    expect(completedRun.status).toBe("completed");

    const graphResponse = await getGraphRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/graph`),
      workspaceRouteContext(createPayload.workspaceId)
    );
    const graphPayload = (await graphResponse.json()) as WorkspaceGraphPayload;

    expect(graphPayload.starterMode).toBe(false);
    expect(graphPayload.runtime).toMatchObject({
      mode: "open-model",
      provider: "open-model",
      supportsUrlIntake: true,
      supportsWebSearch: false,
      openModelBackend: "ollama",
      openModelModel: "qwen3:8b"
    });
    expect(graphPayload.graphBuild).toMatchObject({
      origin: "live",
      mode: "open-model",
      provider: "open-model",
      backend: "ollama",
      model: "qwen3:8b",
      runId: analyzePayload.runId
    });
    expect(graphPayload.workspace.sourceUrls).toEqual(["https://example.com/report"]);
    expect(graphPayload.evidence?.evidencePack.sources[0]).toMatchObject({
      type: "web",
      title: "Downtown Access Report",
      url: "https://example.com/report"
    });
    expect(graphPayload.evidence?.evidencePack.snippets[0]?.origin).toBe("url_ingest_excerpt");
    expect(graphPayload.claimInventory?.claimInventory.claims.length).toBeGreaterThan(0);
    expect(graphPayload.graph.nodes.some((node) => node.kind === "counterclaim")).toBe(true);
    expect(graphPayload.graph.nodes.some((node) => node.kind === "gap")).toBe(true);
    expect(requestStructuredOpenModelOutputMock).toHaveBeenCalledTimes(3);
  });

  it("surfaces one-sided deterministic warnings when only one of two URLs yields grounded snippets", async () => {
    requestStructuredOpenModelOutputMock
      .mockResolvedValueOnce({
        backend: "ollama",
        model: "qwen3:8b",
        output: {
          summary:
            "The deterministic retrieval preserves one grounded corridor-access branch while the second URL stays too thin to ground directly.",
          subquestions: ["How does loading access affect business activity?"],
          evidenceAxes: [
            {
              label: "Freight access",
              description: "The readable source preserves a loading-access branch."
            }
          ],
          openQuestions: ["What direct evidence survives outside the city report?"]
        }
      })
      .mockResolvedValueOnce({
        backend: "ollama",
        model: "qwen3:8b",
        output: {
          question: "Should cities ban cars downtown?",
          claims: [
            {
              id: "claim_url_1",
              kind: "claim",
              title: "Freight corridors can preserve loading access during a downtown pilot",
              summary:
                "The city report says morning delivery access was preserved while bus lanes reduced idle traffic downtown.",
              topic: "Freight",
              stance: "pro",
              confidence: 0.78,
              evidenceQuality: "medium",
              sourceIds: ["src_url_1"],
              snippetIds: ["snp_url_1"],
              qualifiers: [],
              dependsOnGapIds: ["gap_url_1"]
            }
          ],
          contradictionPairs: [],
          unresolvedGaps: [
            {
              id: "gap_url_1",
              title: "Independent corroboration remains thin",
              summary:
                "Only one of the supplied URLs yielded grounded passage evidence, so the disagreement surface stays one-sided.",
              gapType: "insufficient_evidence",
              sourceIds: ["src_url_1"],
              snippetIds: ["snp_url_1"],
              importance: 0.7
            }
          ]
        }
      })
      .mockResolvedValueOnce({
        backend: "ollama",
        model: "qwen3:8b",
        output: {
          graphSummary:
            "The grounded URL evidence currently depends on one city report, with the second URL too weak to widen the disagreement surface.",
          claimSelections: [
            {
              claimId: "claim_url_1",
              importance: 0.8
            }
          ],
          gapSelections: [
            {
              gapId: "gap_url_1",
              importance: 0.7
            }
          ],
          claimRelations: [],
          gapRelations: [
            {
              gapId: "gap_url_1",
              claimId: "claim_url_1",
              relation: "depends_on",
              strength: 0.7
            }
          ],
          disagreementClusters: []
        }
      });

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
          question: "Should cities ban cars downtown?",
          sourceUrls: ["https://city.gov/report", "https://example.com/noisy-note"]
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
    const completedRun = await waitForRunToReachTerminal(getRunRoute, analyzePayload.runId);

    expect(completedRun.status).toBe("completed");

    const graphResponse = await getGraphRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/graph`),
      workspaceRouteContext(createPayload.workspaceId)
    );
    const graphPayload = (await graphResponse.json()) as WorkspaceGraphPayload;
    const evidencePack = graphPayload.evidence?.evidencePack;
    const contributingSourceIds = new Set(
      (evidencePack?.snippets ?? []).map((snippet) => snippet.sourceId)
    );

    expect(graphPayload.starterMode).toBe(false);
    expect(evidencePack?.sources).toHaveLength(2);
    expect(evidencePack?.sources[0]).toMatchObject({
      title: "Downtown Freight Review",
      url: "https://city.gov/report",
      sourceKind: "government",
      isPrimary: true,
      publishedAt: "2026-03-02"
    });
    expect(evidencePack?.sources[1]).toMatchObject({
      title: "example.com",
      url: "https://example.com/noisy-note",
      sourceKind: "company",
      isPrimary: true
    });
    expect(contributingSourceIds).toEqual(new Set(["src_url_1"]));
    expect(evidencePack?.warnings.join(" ")).toContain(
      "example.com (https://example.com/noisy-note): The fetched page did not yield enough readable text for deterministic open-model grounding."
    );
    expect(evidencePack?.warnings.join(" ")).toContain(
      "Only Downtown Freight Review contributed grounded snippets to this run."
    );
    expect(evidencePack?.snippets[0]).toMatchObject({
      origin: "url_ingest_excerpt",
      offsetStart: 0
    });
    expect(typeof evidencePack?.snippets[0]?.offsetEnd).toBe("number");
    expect(requestStructuredOpenModelOutputMock).toHaveBeenCalledTimes(3);
  });

  it("builds a live graph in open-model mode from a grounded PDF upload with page-aware snippets", async () => {
    requestStructuredOpenModelOutputMock
      .mockResolvedValueOnce({
        backend: "ollama",
        model: "qwen3:8b",
        output: {
          summary:
            "The uploaded PDF preserves a business upside branch, a merchant downside branch, and a remaining freight-access gap.",
          subquestions: ["What happens to merchants when curb access changes?"],
          evidenceAxes: [
            {
              label: "Business impact",
              description: "The PDF keeps both business upside and merchant downside grounded."
            }
          ],
          openQuestions: ["How much do loading-window changes explain the downside?"]
        }
      })
      .mockResolvedValueOnce({
        backend: "ollama",
        model: "qwen3:8b",
        output: {
          question: "Should cities ban cars downtown?",
          claims: [
            {
              id: "claim_pdf_1",
              kind: "claim",
              title: "Calmer streets can increase foot traffic",
              summary:
                "The uploaded memo says the pilot increased bus speed and retail foot traffic.",
              topic: "Business",
              stance: "pro",
              confidence: 0.8,
              evidenceQuality: "medium",
              sourceIds: ["src_file_1"],
              snippetIds: ["snp_file_ingest_1"],
              qualifiers: [],
              dependsOnGapIds: ["gap_pdf_1"]
            },
            {
              id: "counter_pdf_1",
              kind: "counterclaim",
              title: "Loading changes still hurt some merchants",
              summary:
                "The same uploaded memo says some merchants still reported losses when loading access changed.",
              topic: "Business",
              stance: "con",
              confidence: 0.75,
              evidenceQuality: "medium",
              sourceIds: ["src_file_1"],
              snippetIds: ["snp_file_ingest_1"],
              qualifiers: [],
              dependsOnGapIds: []
            }
          ],
          contradictionPairs: [
            {
              id: "pair_pdf_1",
              leftClaimId: "claim_pdf_1",
              rightClaimId: "counter_pdf_1",
              contradictionStrength: 0.74,
              explanation:
                "The uploaded PDF preserves a business upside while keeping merchant-specific downside explicit."
            }
          ],
          unresolvedGaps: [
            {
              id: "gap_pdf_1",
              title: "Freight access still needs direct evidence",
              summary:
                "The memo flags loading access as unresolved, but it does not quantify the freight tradeoff.",
              gapType: "mixed_evidence",
              sourceIds: ["src_file_1"],
              snippetIds: ["snp_file_ingest_1"],
              importance: 0.69
            }
          ]
        }
      })
      .mockResolvedValueOnce({
        backend: "ollama",
        model: "qwen3:8b",
        output: {
          graphSummary:
            "The strongest disagreement in the uploaded PDF is overall retail upside versus merchant downside, with freight access still unresolved.",
          claimSelections: [
            {
              claimId: "claim_pdf_1",
              importance: 0.82
            },
            {
              claimId: "counter_pdf_1",
              importance: 0.77
            }
          ],
          gapSelections: [
            {
              gapId: "gap_pdf_1",
              importance: 0.69
            }
          ],
          claimRelations: [
            {
              fromClaimId: "counter_pdf_1",
              toClaimId: "claim_pdf_1",
              relation: "refutes",
              strength: 0.74
            }
          ],
          gapRelations: [
            {
              gapId: "gap_pdf_1",
              claimId: "claim_pdf_1",
              relation: "depends_on",
              strength: 0.69
            }
          ],
          disagreementClusters: [
            {
              contradictionPairId: "pair_pdf_1",
              title: "Retail upside versus merchant downside",
              explanation:
                "The uploaded PDF supports a broader upside while preserving merchant-specific losses.",
              topicRelevance: 0.8
            }
          ]
        }
      });

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

    const formData = new FormData();
    formData.set("question", "Should cities ban cars downtown?");
    formData.append(
      "files",
      new File(
        [
          buildTestPdf([
            "The pilot increased bus speed and foot traffic, but some merchants still reported losses when loading access changed and curb pickup was removed."
          ])
        ],
        "downtown-pilot.pdf",
        { type: "application/pdf" }
      )
    );

    const createResponse = await createWorkspaceRoute(
      new Request("http://localhost/api/workspaces", {
        method: "POST",
        body: formData
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
    const completedRun = await waitForRunToReachTerminal(getRunRoute, analyzePayload.runId);

    expect(completedRun.status).toBe("completed");

    const graphResponse = await getGraphRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/graph`),
      workspaceRouteContext(createPayload.workspaceId)
    );
    const graphPayload = (await graphResponse.json()) as WorkspaceGraphPayload;

    expect(graphPayload.starterMode).toBe(false);
    expect(graphPayload.evidence?.evidencePack.sources[0]).toMatchObject({
      type: "file",
      title: "downtown-pilot.pdf",
      fileName: "downtown-pilot.pdf"
    });
    expect(graphPayload.evidence?.evidencePack.snippets[0]).toMatchObject({
      origin: "file_ingest_excerpt",
      pageNumber: 1
    });
    expect(graphPayload.claimInventory?.claimInventory.claims.length).toBeGreaterThan(0);
    expect(graphPayload.graph.nodes.some((node) => node.kind === "counterclaim")).toBe(true);
    expect(graphPayload.graph.nodes.some((node) => node.kind === "gap")).toBe(true);
    expect(requestStructuredOpenModelOutputMock).toHaveBeenCalledTimes(3);
  });

  it("builds a live graph in open-model mode from a grounded DOCX upload with text offsets", async () => {
    requestStructuredOpenModelOutputMock
      .mockResolvedValueOnce({
        backend: "ollama",
        model: "qwen3:8b",
        output: {
          summary:
            "The uploaded DOCX preserves a retail upside branch, a merchant downside branch, and an unresolved freight-access condition.",
          subquestions: ["How much of the downside comes from loading changes?"],
          evidenceAxes: [
            {
              label: "Business impact",
              description: "The DOCX keeps both business upside and merchant downside grounded."
            }
          ],
          openQuestions: ["What delivery exemptions were available during the trial?"]
        }
      })
      .mockResolvedValueOnce({
        backend: "ollama",
        model: "qwen3:8b",
        output: {
          question: "Should cities ban cars downtown?",
          claims: [
            {
              id: "claim_docx_1",
              kind: "claim",
              title: "Walkable pilots can improve corridor foot traffic",
              summary:
                "The uploaded DOCX says the pilot increased foot traffic and transit throughput.",
              topic: "Business",
              stance: "pro",
              confidence: 0.81,
              evidenceQuality: "medium",
              sourceIds: ["src_file_1"],
              snippetIds: ["snp_file_ingest_1"],
              qualifiers: [],
              dependsOnGapIds: ["gap_docx_1"]
            },
            {
              id: "counter_docx_1",
              kind: "counterclaim",
              title: "Pickup-oriented merchants still report downside",
              summary:
                "The same uploaded DOCX says some merchants still reported losses when loading access narrowed.",
              topic: "Business",
              stance: "con",
              confidence: 0.76,
              evidenceQuality: "medium",
              sourceIds: ["src_file_1"],
              snippetIds: ["snp_file_ingest_2"],
              qualifiers: [],
              dependsOnGapIds: []
            }
          ],
          contradictionPairs: [
            {
              id: "pair_docx_1",
              leftClaimId: "claim_docx_1",
              rightClaimId: "counter_docx_1",
              contradictionStrength: 0.75,
              explanation:
                "The uploaded DOCX preserves a corridor upside while keeping merchant-specific downside explicit."
            }
          ],
          unresolvedGaps: [
            {
              id: "gap_docx_1",
              title: "Freight exemptions still need direct evidence",
              summary:
                "The DOCX mentions delivery access, but the freight exceptions remain under-specified.",
              gapType: "mixed_evidence",
              sourceIds: ["src_file_1"],
              snippetIds: ["snp_file_ingest_3"],
              importance: 0.68
            }
          ]
        }
      })
      .mockResolvedValueOnce({
        backend: "ollama",
        model: "qwen3:8b",
        output: {
          graphSummary:
            "The strongest disagreement in the uploaded DOCX is corridor upside versus merchant-specific downside, with freight exemptions still unresolved.",
          claimSelections: [
            {
              claimId: "claim_docx_1",
              importance: 0.83
            },
            {
              claimId: "counter_docx_1",
              importance: 0.78
            }
          ],
          gapSelections: [
            {
              gapId: "gap_docx_1",
              importance: 0.68
            }
          ],
          claimRelations: [
            {
              fromClaimId: "counter_docx_1",
              toClaimId: "claim_docx_1",
              relation: "refutes",
              strength: 0.75
            }
          ],
          gapRelations: [
            {
              gapId: "gap_docx_1",
              claimId: "claim_docx_1",
              relation: "depends_on",
              strength: 0.68
            }
          ],
          disagreementClusters: [
            {
              contradictionPairId: "pair_docx_1",
              title: "Corridor upside versus merchant downside",
              explanation:
                "The uploaded DOCX supports a broader upside while preserving merchant-specific losses.",
              topicRelevance: 0.81
            }
          ]
        }
      });

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

    const formData = new FormData();
    formData.set("question", "Should cities ban cars downtown?");
    formData.append(
      "files",
      new File(
        [
          buildTestDocx({
            paragraphs: [
              "The pilot increased foot traffic and transit throughput across the downtown corridor after through-traffic was removed.",
              "Some pickup-oriented merchants still reported downside when loading access narrowed and curb pickup changed."
            ],
            footnotes: [
              "Delivery exemptions varied block by block and still need direct comparison data."
            ]
          })
        ],
        "downtown-pilot.docx",
        {
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        }
      )
    );

    const createResponse = await createWorkspaceRoute(
      new Request("http://localhost/api/workspaces", {
        method: "POST",
        body: formData
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
    const completedRun = await waitForRunToReachTerminal(getRunRoute, analyzePayload.runId);

    expect(completedRun.status).toBe("completed");

    const graphResponse = await getGraphRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/graph`),
      workspaceRouteContext(createPayload.workspaceId)
    );
    const graphPayload = (await graphResponse.json()) as WorkspaceGraphPayload;
    const [firstSnippet, secondSnippet, thirdSnippet] =
      graphPayload.evidence?.evidencePack.snippets ?? [];

    expect(graphPayload.starterMode).toBe(false);
    expect(graphPayload.evidence?.evidencePack.sources[0]).toMatchObject({
      type: "file",
      title: "downtown-pilot.docx",
      fileName: "downtown-pilot.docx"
    });
    expect(firstSnippet).toMatchObject({
      origin: "file_ingest_excerpt",
      locationLabel: "document body",
      offsetStart: 0
    });
    expect(typeof firstSnippet?.offsetEnd).toBe("number");
    expect(secondSnippet?.locationLabel).toBe("document body");
    expect(secondSnippet?.offsetStart).toBeGreaterThan(firstSnippet?.offsetEnd ?? 0);
    expect(thirdSnippet?.locationLabel).toBe("footnotes");
    expect(thirdSnippet?.rationale).toContain("footnotes");
    expect(graphPayload.claimInventory?.claimInventory.claims.length).toBeGreaterThan(0);
    expect(graphPayload.graph.nodes.some((node) => node.kind === "counterclaim")).toBe(true);
    expect(graphPayload.graph.nodes.some((node) => node.kind === "gap")).toBe(true);
    expect(requestStructuredOpenModelOutputMock).toHaveBeenCalledTimes(3);
  });

  it("fails honestly with an open-model-unavailable fallback reason when the local backend is unreachable", async () => {
    requestStructuredOpenModelOutputMock.mockRejectedValue(
      new TestOpenModelBackendUnavailableError(
        "Open-model backend ollama is unavailable at http://127.0.0.1:11434."
      )
    );

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
          question: "Should cities ban cars downtown?",
          sourceUrls: ["https://example.com/report"]
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
    const failedRun = await waitForRunToReachTerminal(getRunRoute, analyzePayload.runId);

    expect(failedRun.status).toBe("failed");
    expect(failedRun.observability?.fallbackReason).toBe("open_model_unavailable");
    expect(failedRun.errorMessage).toContain("unavailable");

    const graphResponse = await getGraphRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/graph`),
      workspaceRouteContext(createPayload.workspaceId)
    );
    const graphPayload = (await graphResponse.json()) as WorkspaceGraphPayload;

    expect(graphPayload.starterMode).toBe(true);
    expect(graphPayload.runtime.mode).toBe("open-model");
    expect(graphPayload.run).toBeNull();
    expect(graphPayload.latestRun?.status).toBe("failed");
    expect(graphPayload.latestRun?.observability?.fallbackReason).toBe(
      "open_model_unavailable"
    );
    expect(graphPayload.evidence).toBeNull();
    expect(graphPayload.claimInventory).toBeNull();
  });

  it("keeps a weak DOCX upload honest and stops before model extraction when no grounded snippets survive", async () => {
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

    const formData = new FormData();
    formData.set("question", "Should cities ban cars downtown?");
    formData.append(
      "files",
      new File(
        [
          buildTestDocx({
            paragraphs: ["legend"]
          })
        ],
        "scan-export.docx",
        {
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        }
      )
    );

    const createResponse = await createWorkspaceRoute(
      new Request("http://localhost/api/workspaces", {
        method: "POST",
        body: formData
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
    expect(insufficientRun.observability?.fallbackReason).toBe("insufficient_grounding");
    expect(requestStructuredOpenModelOutputMock).not.toHaveBeenCalled();

    const graphResponse = await getGraphRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/graph`),
      workspaceRouteContext(createPayload.workspaceId)
    );
    const graphPayload = (await graphResponse.json()) as WorkspaceGraphPayload;

    expect(graphPayload.starterMode).toBe(true);
    expect(graphPayload.run).toBeNull();
    expect(graphPayload.latestRun?.status).toBe("insufficient_evidence");
    expect(graphPayload.evidence).toBeNull();
    expect(
      graphPayload.latestRunArtifacts?.evidence?.evidencePack.groundingStatus
    ).toBe("insufficient_grounding");
    expect(
      graphPayload.latestRunArtifacts?.evidence?.evidencePack.warnings.join(" ")
    ).toContain(
      "scan-export.docx did not contain enough readable DOCX text for grounded extraction."
    );
    expect(graphPayload.claimInventory).toBeNull();
    expect(graphPayload.latestRunArtifacts?.claimInventory).toBeNull();
  });

  it("keeps a weak URL run honest and stops before model extraction when no grounded snippets survive", async () => {
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
          question: "Should cities ban cars downtown?",
          sourceUrls: ["https://example.com/noisy-note"]
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
    expect(insufficientRun.observability?.fallbackReason).toBe("insufficient_grounding");
    expect(requestStructuredOpenModelOutputMock).not.toHaveBeenCalled();

    const graphResponse = await getGraphRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/graph`),
      workspaceRouteContext(createPayload.workspaceId)
    );
    const graphPayload = (await graphResponse.json()) as WorkspaceGraphPayload;

    expect(graphPayload.starterMode).toBe(true);
    expect(graphPayload.run).toBeNull();
    expect(graphPayload.latestRun?.status).toBe("insufficient_evidence");
    expect(graphPayload.evidence).toBeNull();
    expect(
      graphPayload.latestRunArtifacts?.evidence?.evidencePack.groundingStatus
    ).toBe("insufficient_grounding");
    expect(
      graphPayload.latestRunArtifacts?.evidence?.evidencePack.sources[0]
    ).toMatchObject({
      title: "example.com",
      url: "https://example.com/noisy-note",
      sourceKind: "company",
      isPrimary: true
    });
    expect(
      graphPayload.latestRunArtifacts?.evidence?.evidencePack.warnings.join(" ")
    ).toContain(
      "example.com (https://example.com/noisy-note): The fetched page did not yield enough readable text for deterministic open-model grounding."
    );
    expect(graphPayload.claimInventory).toBeNull();
    expect(graphPayload.latestRunArtifacts?.claimInventory).toBeNull();
  });

  it("fails honestly with an open-model-misconfigured fallback reason when the configured model is missing", async () => {
    requestStructuredOpenModelOutputMock.mockRejectedValue(
      new TestOpenModelModelUnavailableError(
        'Open-model backend ollama is reachable at http://127.0.0.1:11434, but model qwen3:8b is not installed there. Run "ollama pull qwen3:8b" or set CLAIMGRAPH_OPEN_MODEL_NAME to one of the installed models from "ollama list".'
      )
    );

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
          question: "Should cities ban cars downtown?",
          sourceUrls: ["https://example.com/report"]
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
    const failedRun = await waitForRunToReachTerminal(getRunRoute, analyzePayload.runId);

    expect(failedRun.status).toBe("failed");
    expect(failedRun.observability?.fallbackReason).toBe("open_model_misconfigured");
    expect(failedRun.errorMessage).toContain("ollama pull qwen3:8b");

    const graphResponse = await getGraphRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/graph`),
      workspaceRouteContext(createPayload.workspaceId)
    );
    const graphPayload = (await graphResponse.json()) as WorkspaceGraphPayload;

    expect(graphPayload.starterMode).toBe(true);
    expect(graphPayload.runtime.mode).toBe("open-model");
    expect(graphPayload.run).toBeNull();
    expect(graphPayload.latestRun?.status).toBe("failed");
    expect(graphPayload.latestRun?.observability?.fallbackReason).toBe(
      "open_model_misconfigured"
    );
    expect(graphPayload.evidence).toBeNull();
    expect(graphPayload.claimInventory).toBeNull();
  });

  it("persists hosted vllm auth diagnostics on the failed run instead of flattening them into a generic open-model error", async () => {
    process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND = "vllm";
    process.env.CLAIMGRAPH_OPEN_MODEL_NAME = "Qwen/Qwen3-8B";
    process.env.OPEN_MODEL_BASE_URL =
      "https://example.us-east-1.aws.endpoints.huggingface.cloud";
    process.env.OPEN_MODEL_API_KEY = "hf_test_token";

    const authError = new TestOpenModelConfigurationError(
      "Hosted open-model backend vllm rejected the configured OPEN_MODEL_API_KEY at https://example.us-east-1.aws.endpoints.huggingface.cloud/v1."
    ) as TestOpenModelConfigurationError & {
      hostedOpenModelHealth?: {
        backend: "vllm";
        apiBaseUrl: string;
        model: string;
        checkedAt: string;
        timeoutMs: number;
        catalogRoute: string;
        catalogStatus: "auth_rejected";
        catalogCache: "miss";
        completionRoute: string;
        requestStatus: "not_started";
        lastErrorMessage: string;
      };
    };
    authError.hostedOpenModelHealth = {
      backend: "vllm",
      apiBaseUrl: "https://example.us-east-1.aws.endpoints.huggingface.cloud/v1",
      model: "Qwen/Qwen3-8B",
      checkedAt: "2026-04-12T12:00:00.000Z",
      timeoutMs: 90000,
      catalogRoute: "https://example.us-east-1.aws.endpoints.huggingface.cloud/v1/models",
      catalogStatus: "auth_rejected",
      catalogCache: "miss",
      completionRoute:
        "https://example.us-east-1.aws.endpoints.huggingface.cloud/v1/chat/completions",
      requestStatus: "not_started",
      lastErrorMessage:
        "Hosted open-model backend vllm rejected the configured OPEN_MODEL_API_KEY at https://example.us-east-1.aws.endpoints.huggingface.cloud/v1."
    };
    requestStructuredOpenModelOutputMock.mockRejectedValue(authError);

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
          question: "Should cities ban cars downtown?",
          sourceUrls: ["https://example.com/report"]
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
    const failedRun = await waitForRunToReachTerminal(getRunRoute, analyzePayload.runId);

    expect(failedRun.status).toBe("failed");
    expect(failedRun.observability?.fallbackReason).toBe("open_model_misconfigured");
    expect(failedRun.statusMessage).toContain("rejected the configured OPEN_MODEL_API_KEY");
    expect(failedRun.observability?.hostedOpenModelHealth).toMatchObject({
      backend: "vllm",
      model: "Qwen/Qwen3-8B",
      catalogStatus: "auth_rejected",
      requestStatus: "not_started"
    });
    expect(failedRun.observability?.providerFailureEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "open-model",
          backend: "vllm",
          stage: "gathering",
          reason: "configuration_error",
          cleanupStatus: "not_required"
        })
      ])
    );
    expect(
      failedRun.observability?.providerFailureEvents?.[0]?.cleanupMessage
    ).toContain("do not create persisted remote retrieval artifacts");

    const graphResponse = await getGraphRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/graph`),
      workspaceRouteContext(createPayload.workspaceId)
    );
    const graphPayload = (await graphResponse.json()) as WorkspaceGraphPayload;

    expect(graphPayload.run).toBeNull();
    expect(graphPayload.latestRun?.observability?.hostedOpenModelHealth).toMatchObject({
      backend: "vllm",
      catalogStatus: "auth_rejected"
    });
    expect(
      graphPayload.latestRun?.observability?.providerFailureEvents?.[0]
    ).toMatchObject({
      backend: "vllm",
      cleanupStatus: "not_required"
    });
  });

  it("surfaces invalid hosted payload classification on the failed run when the verified route shape is not satisfied", async () => {
    process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND = "vllm";
    process.env.CLAIMGRAPH_OPEN_MODEL_NAME = "Qwen/Qwen3-8B";
    process.env.OPEN_MODEL_BASE_URL =
      "https://example.us-east-1.aws.endpoints.huggingface.cloud";
    process.env.OPEN_MODEL_API_KEY = "hf_test_token";

    const payloadError = new TestOpenModelConfigurationError(
      "Hosted open-model backend vllm at https://example.us-east-1.aws.endpoints.huggingface.cloud/v1 did not return the verified OpenAI-compatible payload shape from /chat/completions."
    ) as TestOpenModelConfigurationError & {
      hostedOpenModelHealth?: {
        backend: "vllm";
        apiBaseUrl: string;
        model: string;
        checkedAt: string;
        timeoutMs: number;
        catalogRoute: string;
        catalogStatus: "succeeded";
        catalogCache: "miss";
        advertisedModelCount: number;
        completionRoute: string;
        requestStatus: "invalid_payload";
        requestAttempt: number;
        requestMaxAttempts: number;
        lastErrorMessage: string;
      };
    };
    payloadError.hostedOpenModelHealth = {
      backend: "vllm",
      apiBaseUrl: "https://example.us-east-1.aws.endpoints.huggingface.cloud/v1",
      model: "Qwen/Qwen3-8B",
      checkedAt: "2026-04-12T12:05:00.000Z",
      timeoutMs: 90000,
      catalogRoute: "https://example.us-east-1.aws.endpoints.huggingface.cloud/v1/models",
      catalogStatus: "succeeded",
      catalogCache: "miss",
      advertisedModelCount: 1,
      completionRoute:
        "https://example.us-east-1.aws.endpoints.huggingface.cloud/v1/chat/completions",
      requestStatus: "invalid_payload",
      requestAttempt: 1,
      requestMaxAttempts: 2,
      lastErrorMessage:
        "Hosted open-model backend vllm at https://example.us-east-1.aws.endpoints.huggingface.cloud/v1 did not return the verified OpenAI-compatible payload shape from /chat/completions."
    };
    requestStructuredOpenModelOutputMock.mockRejectedValue(payloadError);

    const {
      runnerModule,
      storeModule,
      createWorkspaceRoute,
      analyzeWorkspaceRoute,
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
          question: "Should cities ban cars downtown?",
          sourceUrls: ["https://example.com/report"]
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
    const failedRun = await waitForRunToReachTerminal(getRunRoute, analyzePayload.runId);

    expect(failedRun.status).toBe("failed");
    expect(failedRun.observability?.fallbackReason).toBe("open_model_misconfigured");
    expect(failedRun.statusMessage).toContain("verified OpenAI-compatible payload shape");
    expect(failedRun.observability?.hostedOpenModelHealth).toMatchObject({
      requestStatus: "invalid_payload",
      catalogStatus: "succeeded"
    });
  });
});
