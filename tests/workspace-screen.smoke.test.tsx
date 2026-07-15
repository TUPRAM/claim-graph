// @vitest-environment jsdom

import type { ReactNode, Ref } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceScreen } from "@/components/workspace/WorkspaceScreen";
import type { ClaimGraphCanvasProps } from "@/components/graph/ClaimGraphCanvas";
import type { WorkspaceGraphPayload } from "@/types/claimgraph";

type PayloadWithoutRunIdentities = Omit<
  WorkspaceGraphPayload,
  | "latestRun"
  | "activeRun"
  | "graphRun"
  | "latestRunArtifacts"
  | "inProgressArtifacts"
>;

function withRunIdentities(
  payload: PayloadWithoutRunIdentities | WorkspaceGraphPayload
): WorkspaceGraphPayload {
  return {
    ...payload,
    latestRun: payload.run,
    activeRun: null,
    graphRun: payload.run,
    latestRunArtifacts: null,
    inProgressArtifacts: null,
    canWrite: payload.canWrite ?? true
  };
}

const { exportElementToPngMock } = vi.hoisted(() => ({
  exportElementToPngMock: vi.fn(async () => undefined)
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  )
}));

vi.mock("@/lib/export/client-png", () => ({
  exportElementToPng: exportElementToPngMock
}));

vi.mock("@/components/graph/ClaimGraphCanvas", () => ({
  ClaimGraphCanvas: ({
    graph,
    onNodeSelect,
    captureRef
  }: ClaimGraphCanvasProps) => (
    <div
      data-testid="mock-claimgraph-canvas"
      ref={(node) => {
        function assignRef<T>(ref: Ref<T> | undefined, value: T) {
          if (!ref) {
            return;
          }

          if (typeof ref === "function") {
            ref(value);
            return;
          }

          if ("current" in ref) {
            ref.current = value;
          }
        }

        if (node) {
          assignRef(captureRef, node);
        }
      }}
    >
      {graph.nodes.map((node) => (
        <button
          key={node.id}
          type="button"
          onClick={() => onNodeSelect(node.id)}
        >
          Select {node.title}
        </button>
      ))}
    </div>
  )
}));

function buildPayload(): WorkspaceGraphPayload {
  return withRunIdentities({
    workspace: {
      id: "workspace_1",
      question: "Should cities ban cars downtown?",
      createdAt: "2026-04-09T10:00:00.000Z",
      updatedAt: "2026-04-09T10:00:00.000Z",
      settings: {
        maxWebSources: 6,
        maxFiles: 5,
        freshnessBias: "high",
        preferPrimarySources: true,
        includeOpposingEvidence: true
      },
      sourceUrls: []
    },
    run: {
      id: "run_1",
      workspaceId: "workspace_1",
      status: "completed",
      createdAt: "2026-04-09T10:01:00.000Z",
      completedAt: "2026-04-09T10:02:00.000Z",
      statusMessage: "Live graph assembly completed.",
      observability: {
        stages: [],
        exportEvents: []
      }
    },
    graph: {
      question: "Should cities ban cars downtown?",
      graphSummary:
        "The main disagreement concerns public-health upside versus merchant access downside.",
      primaryClusterId: "cluster_1",
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
          title: "Air quality improves in the car-free core",
          summary: "The strongest upside is public-health improvement in the restricted zone.",
          topic: "Environment",
          stance: "pro",
          confidence: 0.85,
          sourceIds: ["source_web_1", "source_file_1"],
          snippetIds: ["snippet_web_excerpt", "snippet_web_cited", "snippet_file_1"]
        },
        {
          id: "counter_1",
          kind: "counterclaim",
          title: "Some merchants lose convenience-driven sales",
          summary: "Retail harm remains plausible where access changes are abrupt.",
          topic: "Business",
          stance: "con",
          confidence: 0.78,
          sourceIds: ["source_web_2"],
          snippetIds: ["snippet_web_summary"],
          metadata: {
            qualifiers: [
              "This downside signal is grounded in one web summary, not a direct comparative study."
            ]
          }
        },
        {
          id: "gap_1",
          kind: "gap",
          title: "Transit and loading access remain unresolved",
          summary: "The business outcome still depends on freight windows, exemptions, and transit backfill.",
          topic: "Implementation",
          confidence: 0.74,
          sourceIds: ["source_file_1"],
          snippetIds: ["snippet_file_1"],
          metadata: {
            gapType: "missing_context",
            importance: 0.74
          }
        }
      ],
      edges: [
        {
          id: "edge_claim_question",
          from: "claim_1",
          to: "question_root",
          relation: "supports",
          strength: 0.85
        },
        {
          id: "edge_counter_question",
          from: "counter_1",
          to: "question_root",
          relation: "refutes",
          strength: 0.78
        },
        {
          id: "edge_gap_claim",
          from: "gap_1",
          to: "claim_1",
          relation: "depends_on",
          strength: 0.73
        }
      ],
      disagreementClusters: [
        {
          id: "cluster_1",
          claimIds: ["claim_1", "counter_1"],
          score: 0.88,
          title: "Health gains versus merchant downside",
          explanation: "The evidence supports cleaner air while leaving merchant downside contested.",
          sourceIds: ["source_web_1", "source_web_2", "source_file_1"],
          snippetIds: [
            "snippet_web_excerpt",
            "snippet_web_cited",
            "snippet_web_summary",
            "snippet_file_1"
          ]
        },
        {
          id: "cluster_2",
          claimIds: ["claim_1", "counter_1"],
          score: 0.71,
          title: "Delivery and access uncertainty",
          explanation: "The same core business disagreement becomes sharper when freight and accessibility constraints dominate.",
          sourceIds: ["source_file_1", "source_web_2"],
          snippetIds: ["snippet_file_1", "snippet_web_summary"]
        }
      ]
    },
    sources: [
      {
        id: "source_web_1",
        type: "web",
        title: "Air Quality Study",
        url: "https://example.com/air",
        domain: "example.com",
        sourceKind: "research",
        publishedAt: "2026-04-01",
        isPrimary: true
      },
      {
        id: "source_web_2",
        type: "web",
        title: "Retail Outcome Summary",
        url: "https://example.com/retail",
        domain: "example.com"
      },
      {
        id: "source_file_1",
        type: "file",
        title: "Merchant Memo",
        fileName: "merchant-memo.pdf",
        sourceKind: "memo"
      }
    ],
    snippets: [
      {
        id: "snippet_web_excerpt",
        sourceId: "source_web_1",
        text: "Nitrogen dioxide levels fell after the downtown restriction.",
        rationale: "Source-side web result excerpt supporting the public-health upside.",
        relevance: 0.92,
        origin: "web_search_result_excerpt"
      },
      {
        id: "snippet_web_cited",
        sourceId: "source_web_1",
        text: "Air quality improved after pedestrianization.",
        rationale: "Model-cited web summary span preserved from the evidence pass.",
        relevance: 0.74,
        origin: "web_citation_summary_span",
        offsetStart: 0,
        offsetEnd: 43
      },
      {
        id: "snippet_web_summary",
        sourceId: "source_web_2",
        text: "Some pilots reported mixed merchant outcomes after access changes.",
        rationale: "Source-side search summary capturing retail downside.",
        relevance: 0.68,
        origin: "web_search_result_summary"
      },
      {
        id: "snippet_file_1",
        sourceId: "source_file_1",
        text: "Pickup-heavy merchants reported slower sales after curb access changed.",
        rationale: "Retrieved directly from the uploaded merchant memo.",
        relevance: 0.79,
        origin: "file_search_result"
      }
    ],
    files: [],
    evidence: null,
    claimInventory: null,
    starterMode: false,
    runtime: {
      mode: "full",
      provider: "openai",
      liveAnalysisEnabled: true,
      supportsUrlIntake: false,
      supportsWebSearch: true
    },
    graphBuild: {
      origin: "live",
      mode: "full",
      provider: "openai",
      model: "gpt-5.4",
      responseId: "resp_graph",
      runId: "run_1"
    }
  });
}

function buildOpenModelPayload(): WorkspaceGraphPayload {
  const payload = buildPayload();

  return withRunIdentities({
    ...payload,
    workspace: {
      ...payload.workspace,
      id: "workspace_open_model",
      sourceUrls: ["https://example.com/report"]
    },
    run: payload.run
      ? {
          ...payload.run,
          id: "run_open_model",
          workspaceId: "workspace_open_model",
          statusMessage: "Open-model graph assembly completed."
        }
      : null,
    sources: payload.sources.map((source) =>
      source.id === "source_file_1"
        ? {
            ...source,
            title: "Merchant Memo (DOCX)",
            fileName: "merchant-memo.docx"
          }
        : source
    ),
    snippets: payload.snippets.map((snippet) => {
      if (snippet.id === "snippet_web_excerpt") {
        return {
          ...snippet,
          origin: "url_ingest_excerpt" as const,
          offsetStart: 0,
          offsetEnd: 66
        };
      }

      if (snippet.id === "snippet_web_summary") {
        return {
          ...snippet,
          origin: "url_ingest_excerpt" as const,
          offsetStart: 67,
          offsetEnd: 132
        };
      }

      if (snippet.id === "snippet_web_cited") {
        return {
          ...snippet,
          origin: "url_ingest_excerpt" as const,
          offsetStart: 133,
          offsetEnd: 176
        };
      }

      if (snippet.id === "snippet_file_1") {
        return {
          ...snippet,
          origin: "file_ingest_excerpt" as const,
          locationLabel: "footnotes",
          offsetStart: 412,
          offsetEnd: 489
        };
      }

      return snippet;
    }),
    runtime: {
      mode: "open-model",
      provider: "open-model",
      liveAnalysisEnabled: true,
      supportsUrlIntake: true,
      supportsWebSearch: false,
      openModelBackend: "ollama",
      openModelModel: "qwen3:8b"
    },
    graphBuild: {
      origin: "live",
      mode: "open-model",
      provider: "open-model",
      backend: "ollama",
      model: "qwen3:8b",
      responseId: "resp_open_model_graph",
      runId: "run_open_model"
    }
  });
}

function buildWebSourcedPayload(): WorkspaceGraphPayload {
  const payload = buildPayload();
  const webSourceIds = new Set(["source_web_1", "source_web_2"]);
  const webSnippetIds = new Set([
    "snippet_web_excerpt",
    "snippet_web_cited",
    "snippet_web_summary"
  ]);

  return withRunIdentities({
    ...payload,
    workspace: {
      ...payload.workspace,
      id: "workspace_web_sourced",
      sourceUrls: []
    },
    run: payload.run
      ? {
          ...payload.run,
          id: "run_web_sourced",
          workspaceId: "workspace_web_sourced",
          statusMessage: "Web-sourced graph assembly completed."
        }
      : null,
    graph: {
      ...payload.graph,
      nodes: payload.graph.nodes.map((node) => {
        if (node.kind === "question") {
          return node;
        }

        return {
          ...node,
          sourceIds: node.sourceIds.filter((sourceId) => webSourceIds.has(sourceId)),
          snippetIds: node.snippetIds.filter((snippetId) =>
            webSnippetIds.has(snippetId)
          )
        };
      }),
      disagreementClusters: payload.graph.disagreementClusters.map((cluster) => ({
        ...cluster,
        sourceIds: cluster.sourceIds.filter((sourceId) =>
          webSourceIds.has(sourceId)
        ),
        snippetIds: cluster.snippetIds.filter((snippetId) =>
          webSnippetIds.has(snippetId)
        )
      }))
    },
    sources: payload.sources
      .filter((source) => webSourceIds.has(source.id))
      .map((source) =>
        source.id === "source_web_2"
          ? {
              ...source,
              url: "https://retail-association.org/outcomes",
              domain: "retail-association.org",
              sourceKind: "news" as const,
              publishedAt: "2026-04-02"
            }
          : source
      ),
    snippets: payload.snippets.filter((snippet) => webSnippetIds.has(snippet.id)),
    files: [],
    graphBuild: {
      ...payload.graphBuild,
      runId: "run_web_sourced"
    }
  });
}

function buildWeakWebSourcedPayload(): WorkspaceGraphPayload {
  const payload = buildWebSourcedPayload();

  return withRunIdentities({
    ...payload,
    workspace: {
      ...payload.workspace,
      id: "workspace_weak_web_sourced"
    },
    run: payload.run
      ? {
          ...payload.run,
          id: "run_weak_web_sourced",
          workspaceId: "workspace_weak_web_sourced"
        }
      : null,
    graph: {
      ...payload.graph,
      disagreementClusters: payload.graph.disagreementClusters.map((cluster) => ({
        ...cluster,
        score: 0.52,
        title: "Sources found, but conflict strength is weak"
      }))
    },
    graphBuild: {
      ...payload.graphBuild,
      runId: "run_weak_web_sourced"
    }
  });
}

function buildOneSidedOpenModelPayload(): WorkspaceGraphPayload {
  const payload = buildOpenModelPayload();

  return withRunIdentities({
    ...payload,
    graph: {
      ...payload.graph,
      primaryClusterId: undefined,
      nodes: payload.graph.nodes.filter(
        (node) => node.kind === "question" || node.kind === "claim"
      ),
      edges: payload.graph.edges.filter((edge) => edge.id === "edge_claim_question"),
      disagreementClusters: []
    }
  });
}

function buildSourceNotePayload(): WorkspaceGraphPayload {
  const payload = buildPayload();

  return withRunIdentities({
    ...payload,
    sources: payload.sources.map((source) =>
      source.id === "source_file_1"
        ? {
            ...source,
            title: "regulation-risk.md",
            fileName: "regulation-risk.md",
            sourceKind: "memo"
          }
        : source
    ),
    snippets: payload.snippets.map((snippet) =>
      snippet.id === "snippet_file_1"
        ? {
            ...snippet,
            text: "Evidence note 1: Source basis: reviewer-provided source note with source URLs.",
            rationale: "Extracted from an uploaded source note file."
          }
        : snippet
    )
  });
}

function buildDemoPayload(): WorkspaceGraphPayload {
  const payload = buildPayload();

  return withRunIdentities({
    ...payload,
    workspace: {
      ...payload.workspace,
      id: "demo",
      sourceUrls: []
    },
    run: null,
    evidence: null,
    claimInventory: null,
    starterMode: true,
    runtime: {
      mode: "demo",
      provider: "starter",
      liveAnalysisEnabled: false,
      supportsUrlIntake: false,
      supportsWebSearch: false
    },
    graphBuild: {
      origin: "starter",
      mode: "demo",
      provider: "starter",
      model: "starter-graph"
    }
  });
}

function buildHostedFailurePayload(): WorkspaceGraphPayload {
  const payload = buildOpenModelPayload();

  return withRunIdentities({
    ...payload,
    run: {
      id: "run_hosted_failure",
      workspaceId: "workspace_open_model",
      status: "failed",
      createdAt: "2026-04-12T12:00:00.000Z",
      completedAt: "2026-04-12T12:00:07.000Z",
      errorMessage:
        "Hosted open-model backend vllm at https://example.us-east-1.aws.endpoints.huggingface.cloud/v1 did not return the verified OpenAI-compatible payload shape from /chat/completions.",
      statusMessage:
        "Hosted vllm responded at https://example.us-east-1.aws.endpoints.huggingface.cloud/v1, but it did not return the verified OpenAI-compatible payload shape ClaimGraph requires, so the workspace stayed on the most recent safe graph path.",
      observability: {
        stages: [
          {
            stage: "queued",
            startedAt: "2026-04-12T12:00:00.000Z",
            completedAt: "2026-04-12T12:00:01.000Z",
            durationMs: 1000
          },
          {
            stage: "gathering",
            startedAt: "2026-04-12T12:00:01.000Z",
            completedAt: "2026-04-12T12:00:07.000Z",
            durationMs: 6000,
            model: "Qwen/Qwen3-8B"
          }
        ],
        exportEvents: [],
        fallbackReason: "open_model_misconfigured",
        hostedOpenModelHealth: {
          backend: "vllm",
          apiBaseUrl: "https://example.us-east-1.aws.endpoints.huggingface.cloud/v1",
          model: "Qwen/Qwen3-8B",
          checkedAt: "2026-04-12T12:00:07.000Z",
          timeoutMs: 90000,
          catalogRoute:
            "https://example.us-east-1.aws.endpoints.huggingface.cloud/v1/models",
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
        },
        providerFailureEvents: [
          {
            id: "provider_failure_1",
            provider: "open-model",
            backend: "vllm",
            stage: "gathering",
            createdAt: "2026-04-12T12:00:07.000Z",
            reason: "configuration_error",
            message:
              "Hosted open-model backend vllm at https://example.us-east-1.aws.endpoints.huggingface.cloud/v1 did not return the verified OpenAI-compatible payload shape from /chat/completions.",
            cleanupStatus: "not_required",
            cleanupMessage:
              "Hosted vllm failures in this repo do not create persisted remote retrieval artifacts, so no cleanup step was required."
          }
        ]
      }
    },
    starterMode: true,
    runtime: {
      mode: "open-model",
      provider: "open-model",
      liveAnalysisEnabled: true,
      supportsUrlIntake: true,
      supportsWebSearch: false,
      openModelBackend: "vllm",
      openModelModel: "Qwen/Qwen3-8B"
    },
    graphBuild: {
      origin: "starter",
      mode: "demo",
      provider: "starter",
      model: "starter-graph"
    }
  });
}

describe("WorkspaceScreen smoke path", () => {
  const originalFetch = global.fetch;
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  const anchorClickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click");

  beforeEach(() => {
    const payload = buildPayload();

    exportElementToPngMock.mockClear();
    anchorClickSpy.mockReset();
    anchorClickSpy.mockImplementation(() => undefined);
    window.localStorage.clear();

    URL.createObjectURL = vi.fn(() => "blob:claimgraph-export");
    URL.revokeObjectURL = vi.fn();

    global.fetch = vi.fn(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;

      if (url.endsWith("/graph")) {
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        });
      }

      if (url.endsWith("/export/markdown")) {
        return new Response("# ClaimGraph Export", {
          status: 200,
          headers: {
            "Content-Type": "text/markdown"
          }
        });
      }

      if (url.endsWith("/export/png")) {
        return new Response(JSON.stringify({ ok: true, method: init?.method ?? "POST" }), {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        });
      }

      throw new Error(`Unhandled fetch request in smoke test: ${url}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    anchorClickSpy.mockReset();
    global.fetch = originalFetch;
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
    cleanup();
  });

  it("loads a workspace, saves and reapplies a focused review state, browses disagreement clusters, toggles unresolved mode, and exports the visible review context", async () => {
    render(<WorkspaceScreen workspaceId="workspace_1" />);

    await screen.findByRole("heading", {
      name: "Should cities ban cars downtown?",
      level: 1
    });
    const primaryRegion = screen.getByRole("region", {
      name: "Argument map workspace"
    });
    expect(screen.getByRole("region", { name: "Argument map controls" })).not.toBeNull();
    expect(
      screen.queryByRole("complementary", {
        name: "Map inspector"
      })
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Inspector" })).toBeNull();

    const selectClaimButton = await screen.findByRole("button", {
      name: "Select Air quality improves in the car-free core"
    });
    selectClaimButton.click();

    const reviewSidebar = await screen.findByRole("complementary", {
      name: "Map inspector"
    });

    expect(
      primaryRegion.compareDocumentPosition(reviewSidebar) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      primaryRegion.compareDocumentPosition(reviewSidebar) &
        Node.DOCUMENT_POSITION_CONTAINED_BY
    ).toBeTruthy();
    expect(screen.queryByText("Live lane and launch readout")).toBeNull();
    expect(screen.queryByText("Workspace assessment")).toBeNull();
    expect(screen.queryByText("Run diagnostics")).toBeNull();

    expect((await screen.findAllByText("source excerpt")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("cited source summary")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("file excerpt")).length).toBeGreaterThan(0);
    screen.getByRole("heading", { name: "Map controls" }).click();
    screen.getByRole("heading", { name: "Health gains versus merchant downside" }).click();
    await screen.findByRole("region", { name: "Branch comparison overview" });
    const blockersRegion = screen.getByRole("region", { name: "Open gaps" });
    within(blockersRegion).getByText("Transit and loading access remain unresolved");

    screen.getByRole("button", { name: "Claim B" }).click();

    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "Claim A branch" })).toBeNull();
      expect(screen.getByRole("region", { name: "Claim B branch" })).not.toBeNull();
    });

    within(screen.getByRole("region", { name: "Claim B branch" }))
      .getByRole("button", { name: "Inspect node" })
      .click();

    const selectedNodeRegion = screen.getByRole("region", {
      name: "Selected node details"
    });

    await within(selectedNodeRegion).findByText(
      "Some merchants lose convenience-driven sales"
    );
    await within(selectedNodeRegion).findByText(/Source trail visible:/);
    await within(selectedNodeRegion).findByText("thin grounding");
    await within(selectedNodeRegion).findByText("source limits");

    const summaryRegion = screen.getByRole("region", {
      name: "Summary"
    });

    await within(summaryRegion).findByText(
      "This downside signal is grounded in one web summary, not a direct comparative study."
    );
    within(summaryRegion).getByText("Grounding notes").click();
    await within(summaryRegion).findByText(
      "Some source metadata is limited: source type or publication date could not be verified for every linked web source."
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Source filter" }), {
      target: { value: "source_file_1" }
    });

    await screen.findByText("No conflict sources remain after the current source filter.");

    screen.getByRole("button", { name: "Save view" }).click();
    await screen.findByRole("button", {
      name: /^Some merchants lose convenience-driven sales/
    });

    screen.getByRole("button", { name: "All branches" }).click();
    await screen.findByRole("region", { name: "Claim A branch" });

    screen.getByRole("button", {
      name: /^Some merchants lose convenience-driven sales/
    }).click();

    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "Claim A branch" })).toBeNull();
      expect(screen.getByRole("region", { name: "Claim B branch" })).not.toBeNull();
    });

    screen.getByRole("button", { name: "Export notes" }).click();

    await waitFor(() => {
      expect(URL.createObjectURL).toHaveBeenCalled();
      expect(anchorClickSpy).toHaveBeenCalled();
    });

    const markdownExportCall = vi.mocked(global.fetch).mock.calls.find(
      ([requestUrl]) => requestUrl === "/api/workspaces/workspace_1/export/markdown"
    );
    const markdownExportBody = markdownExportCall?.[1]?.body;

    expect(typeof markdownExportBody).toBe("string");
    expect(JSON.parse(markdownExportBody as string)).toEqual(
      expect.objectContaining({
        selectedNodeId: "counter_1",
        reviewBranchFilter: "right",
        reviewSourceFilterId: "source_file_1",
        savedReviewStateLabel: expect.stringContaining(
          "Some merchants lose convenience-driven sales"
        )
      })
    );

    const clusterPicker = screen.getByRole("combobox", { name: "Conflict" });
    fireEvent.change(clusterPicker, { target: { value: "cluster_2" } });

    await screen.findByRole("heading", {
      name: "Delivery and access uncertainty"
    });

    const unresolvedToggle = screen.getByRole("button", { name: "Open gaps" });
    expect(unresolvedToggle.getAttribute("aria-pressed")).toBe("false");
    unresolvedToggle.click();

    await waitFor(() => {
      expect(unresolvedToggle.getAttribute("aria-pressed")).toBe("true");
    });
    await screen.findByText("Selected node is part of the unresolved branch");

    const strongestToggle = screen.getByRole("button", { name: "Main conflict" });
    expect(strongestToggle.getAttribute("aria-pressed")).toBe("true");
    strongestToggle.click();

    await waitFor(() => {
      expect(strongestToggle.getAttribute("aria-pressed")).toBe("false");
    });

    screen.getByRole("button", { name: "Export image" }).click();

    await waitFor(() => {
      expect(exportElementToPngMock).toHaveBeenCalledWith(
        expect.objectContaining({
          filename: "claimgraph-workspace_1.png"
        })
      );
    });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/workspaces/workspace_1/export/png",
        expect.objectContaining({
          method: "POST"
        })
      );
    });
  });

  it("returns focus after closing the node inspector", async () => {
    render(<WorkspaceScreen workspaceId="workspace_1" />);

    await screen.findByRole("heading", {
      name: "Should cities ban cars downtown?",
      level: 1
    });

    const selectClaimButton = await screen.findByRole("button", {
      name: "Select Air quality improves in the car-free core"
    });
    selectClaimButton.focus();
    selectClaimButton.click();

    const closeInspectorButton = await screen.findByRole("button", {
      name: "Close map inspector"
    });

    await waitFor(() => {
      expect(document.activeElement).toBe(closeInspectorButton);
    });

    closeInspectorButton.click();

    await waitFor(() => {
      expect(
        screen.queryByRole("complementary", {
          name: "Map inspector"
        })
      ).toBeNull();
      expect(document.activeElement).toBe(selectClaimButton);
    });
  });

  it("uses a focused mobile filter sheet without duplicating the public toolbar flow", async () => {
    render(<WorkspaceScreen workspaceId="workspace_1" />);

    await screen.findByRole("heading", {
      name: "Should cities ban cars downtown?",
      level: 1
    });

    const filtersButton = screen.getByRole("button", { name: "Filters" });
    filtersButton.focus();
    filtersButton.click();

    const filtersSheet = await screen.findByRole("region", {
      name: "Map filters"
    });
    const closeFiltersButton = within(filtersSheet).getByRole("button", {
      name: "Close"
    });

    await waitFor(() => {
      expect(document.activeElement).toBe(closeFiltersButton);
    });

    within(filtersSheet).getByRole("button", { name: "Claims 1/1" }).click();
    await within(filtersSheet).findByRole("button", { name: "Claims 0/1" });

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "Map filters" })).toBeNull();
      expect(document.activeElement).toBe(filtersButton);
    });
  });

  it("surfaces uploaded source-note limitations in the public inspector column", async () => {
    const payload = buildSourceNotePayload();

    global.fetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url.endsWith("/graph")) {
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        });
      }

      throw new Error(`Unhandled fetch request in source-note smoke test: ${url}`);
    }) as typeof fetch;

    render(<WorkspaceScreen workspaceId="workspace_1" />);

    await screen.findByRole("heading", {
      name: "Should cities ban cars downtown?",
      level: 1
    });

    screen.getByRole("button", { name: "Review" }).click();
    await screen.findByText("Know what was checked");

    const sourceLimitations = screen
      .getByText("Know what was checked")
      .closest("details");

    expect(sourceLimitations).not.toBeNull();
    within(sourceLimitations as HTMLElement).getByText("Know what was checked").click();

    expect(within(sourceLimitations as HTMLElement).getByText("Know what was checked")).not.toBeNull();
    expect(
      within(sourceLimitations as HTMLElement).getAllByText(
        /Treat those links as leads unless the source itself appears in the evidence list/i
      ).length
    ).toBeGreaterThan(0);
    expect(within(sourceLimitations as HTMLElement).getAllByText("regulation-risk.md").length).toBeGreaterThan(0);
  });

  it("restores the last visible saved review state when the workspace is reopened", async () => {
    const firstRender = render(<WorkspaceScreen workspaceId="workspace_1" />);

    await screen.findByRole("heading", {
      name: "Should cities ban cars downtown?",
      level: 1
    });

    (await screen.findByRole("button", {
      name: "Select Air quality improves in the car-free core"
    })).click();
    await screen.findByRole("complementary", { name: "Map inspector" });

    screen.getByRole("heading", { name: "Map controls" }).click();
    screen.getByRole("heading", { name: "Health gains versus merchant downside" }).click();
    screen.getByRole("button", { name: "Claim B" }).click();
    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "Claim A branch" })).toBeNull();
    });

    fireEvent.change(screen.getByRole("combobox", { name: "Source filter" }), {
      target: { value: "source_file_1" }
    });
    await screen.findByText("No conflict sources remain after the current source filter.");

    screen.getByRole("button", { name: "Save view" }).click();
    firstRender.unmount();

    render(<WorkspaceScreen workspaceId="workspace_1" />);

    await screen.findByRole("heading", {
      name: "Should cities ban cars downtown?",
      level: 1
    });

    await screen.findByRole("complementary", { name: "Map inspector" });
    screen.getByRole("heading", { name: "Map controls" }).click();
    screen.getByRole("heading", { name: "Health gains versus merchant downside" }).click();

    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "Claim A branch" })).toBeNull();
      expect(screen.getByRole("region", { name: "Claim B branch" })).not.toBeNull();
    });

    expect(
      (screen.getByRole("combobox", { name: "Source filter" }) as HTMLSelectElement).value
    ).toBe("source_file_1");
  });

  it("supports keyboard-first graph review controls without changing the export surface contract", async () => {
    render(<WorkspaceScreen workspaceId="workspace_1" />);

    await screen.findByRole("heading", {
      name: "Should cities ban cars downtown?",
      level: 1
    });

    await screen.findByRole("combobox", { name: "Conflict" });
    fireEvent.keyDown(window, { key: "]" });

    await waitFor(() => {
      expect(
        (screen.getByRole("combobox", { name: "Conflict" }) as HTMLSelectElement).value
      ).toBe("cluster_2");
    });

    fireEvent.keyDown(window, { key: "1" });

    await screen.findByRole("button", {
      name: "Claims 0/1"
    });

    fireEvent.keyDown(window, { key: "1" });

    await screen.findByRole("button", {
      name: "Claims 1/1"
    });

    fireEvent.keyDown(window, { key: "u" });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Open gaps" }).getAttribute("aria-pressed")).toBe(
        "true"
      );
    });

    fireEvent.keyDown(window, { key: "d" });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Main conflict" }).getAttribute("aria-pressed")
      ).toBe("false");
    });
  });

  it("renders the demo workspace honestly as starter mode without implying live analysis", async () => {
    const payload = buildDemoPayload();

    global.fetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url.endsWith("/graph")) {
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        });
      }

      if (url.endsWith("/export/markdown")) {
        return new Response("# Demo Export", {
          status: 200,
          headers: {
            "Content-Type": "text/markdown"
          }
        });
      }

      if (url.endsWith("/export/png")) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        });
      }

      throw new Error(`Unhandled fetch request in demo smoke test: ${url}`);
    }) as typeof fetch;

    render(<WorkspaceScreen workspaceId="demo" />);

    await screen.findByRole("heading", {
      name: "Should cities ban cars downtown?",
      level: 1
    });

    expect(screen.getByText("Curated demo")).not.toBeNull();
    expect(screen.getByText(/sample starter data/i)).not.toBeNull();
    expect(screen.getByText(/sample sources/)).not.toBeNull();
    expect(screen.getByRole("button", { name: "Build graph" }).hasAttribute("disabled")).toBe(
      true
    );
    expect(screen.queryByText("starter graph")).toBeNull();
    expect(screen.queryByText(/limited source/i)).toBeNull();
    expect(screen.queryByText(/linked snippet/i)).toBeNull();
  });

  it("renders an open-model workspace without public runtime labeling", async () => {
    const payload = buildOpenModelPayload();

    global.fetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url.endsWith("/graph")) {
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        });
      }

      if (url.endsWith("/export/markdown")) {
        return new Response("# Open Model Export", {
          status: 200,
          headers: {
            "Content-Type": "text/markdown"
          }
        });
      }

      if (url.endsWith("/export/png")) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        });
      }

      throw new Error(`Unhandled fetch request in open-model smoke test: ${url}`);
    }) as typeof fetch;

    render(<WorkspaceScreen workspaceId="workspace_open_model" />);

    await screen.findByRole("heading", {
      name: "Should cities ban cars downtown?",
      level: 1
    });

    expect(screen.queryByText("open-model mode")).toBeNull();
    expect(screen.queryByText("open-model graph")).toBeNull();
    expect(screen.queryByText("ollama")).toBeNull();
    expect(screen.queryByText("qwen3:8b")).toBeNull();
    expect(screen.getByText("Graph complete")).not.toBeNull();

    const selectClaimButton = await screen.findByRole("button", {
      name: "Select Air quality improves in the car-free core"
    });
    selectClaimButton.click();

    expect((await screen.findAllByText("source URL excerpt")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("file excerpt")).length).toBeGreaterThan(0);
    expect(
      (await screen.findAllByText("report / example.com / published 2026-04-01 / primary")).length
    ).toBeGreaterThan(0);
    expect((await screen.findAllByText("report / merchant-memo.docx")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Location: footnotes / offset 412-489")).length).toBeGreaterThan(0);
  });

  it("labels a question-only full-mode result as a web-sourced graph", async () => {
    const payload = buildWebSourcedPayload();

    global.fetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url.endsWith("/graph")) {
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        });
      }

      if (url.endsWith("/export/markdown")) {
        return new Response("# Web-Sourced Export", {
          status: 200,
          headers: {
            "Content-Type": "text/markdown"
          }
        });
      }

      if (url.endsWith("/export/png")) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        });
      }

      throw new Error(`Unhandled fetch request in web-sourced smoke test: ${url}`);
    }) as typeof fetch;

    render(<WorkspaceScreen workspaceId="workspace_web_sourced" />);

    await screen.findByRole("heading", {
      name: "Should cities ban cars downtown?",
      level: 1
    });

    expect(screen.getByText("Web-sourced graph")).not.toBeNull();
    expect(screen.getByText("2 web sources")).not.toBeNull();
    expect(screen.queryByText("Graph complete")).toBeNull();

    const selectClaimButton = await screen.findByRole("button", {
      name: "Select Air quality improves in the car-free core"
    });
    selectClaimButton.click();

    expect((await screen.findAllByText("Air Quality Study")).length).toBeGreaterThan(0);
    expect(
      (await screen.findAllByText("Nitrogen dioxide levels fell after the downtown restriction.")).length
    ).toBeGreaterThan(0);
  });

  it("downgrades web-sourced graphs when the main conflict is weak", async () => {
    const payload = buildWeakWebSourcedPayload();

    global.fetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url.endsWith("/graph")) {
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        });
      }

      if (url.endsWith("/export/markdown")) {
        return new Response("# Weak Web-Sourced Export", {
          status: 200,
          headers: {
            "Content-Type": "text/markdown"
          }
        });
      }

      if (url.endsWith("/export/png")) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        });
      }

      throw new Error(`Unhandled fetch request in weak web-sourced smoke test: ${url}`);
    }) as typeof fetch;

    render(<WorkspaceScreen workspaceId="workspace_weak_web_sourced" />);

    await screen.findByRole("heading", {
      name: "Should cities ban cars downtown?",
      level: 1
    });

    expect(screen.getByText("Sources found, conflict weak")).not.toBeNull();
    expect(screen.getByText("Main conflict 52%")).not.toBeNull();
    expect(screen.queryByText("Graph complete")).toBeNull();
  });

  it("does not call a source-backed one-sided graph complete", async () => {
    const payload = buildOneSidedOpenModelPayload();

    global.fetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url.endsWith("/graph")) {
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        });
      }

      if (url.endsWith("/export/markdown")) {
        return new Response("# One-Sided Export", {
          status: 200,
          headers: {
            "Content-Type": "text/markdown"
          }
        });
      }

      if (url.endsWith("/export/png")) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        });
      }

      throw new Error(`Unhandled fetch request in one-sided smoke test: ${url}`);
    }) as typeof fetch;

    render(<WorkspaceScreen workspaceId="workspace_one_sided" />);

    await screen.findByRole("heading", {
      name: "Should cities ban cars downtown?",
      level: 1
    });

    expect(screen.getByText("Needs disagreement")).not.toBeNull();
    expect(screen.getByText("Main conflict not found")).not.toBeNull();
    expect(screen.queryByText("Graph complete")).toBeNull();
  });

  it("keeps hosted failure diagnostics out of the public workspace", async () => {
    const payload = buildHostedFailurePayload();

    global.fetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url.endsWith("/graph")) {
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        });
      }

      if (url.endsWith("/export/markdown")) {
        return new Response("# Hosted Failure Export", {
          status: 200,
          headers: {
            "Content-Type": "text/markdown"
          }
        });
      }

      if (url.endsWith("/export/png")) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        });
      }

      throw new Error(`Unhandled fetch request in hosted failure smoke test: ${url}`);
    }) as typeof fetch;

    render(<WorkspaceScreen workspaceId="workspace_open_model" />);

    await screen.findByRole("heading", {
      name: "Should cities ban cars downtown?",
      level: 1
    });

    expect(screen.getByText("Not enough evidence")).not.toBeNull();
    expect(screen.queryByText("Run diagnostics")).toBeNull();
    expect(screen.queryByText("starter fallback")).toBeNull();
    expect(screen.queryByText("Hosted backend")).toBeNull();
    expect(screen.queryByText("Provider failure log")).toBeNull();
    expect(
      screen.queryByText("https://example.us-east-1.aws.endpoints.huggingface.cloud/v1")
    ).toBeNull();
    expect(screen.queryByText("catalog succeeded")).toBeNull();
    expect(screen.queryByText("request invalid payload")).toBeNull();
  });

  it("shows shared visitors that the graph is view-only", async () => {
    const payload = buildPayload();
    payload.canWrite = false;

    global.fetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url.endsWith("/graph")) {
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      throw new Error(`View-only workspace attempted a mutation: ${url}`);
    }) as typeof fetch;

    render(<WorkspaceScreen workspaceId="workspace_1" />);

    await screen.findByText("View-only shared workspace");
    expect(
      screen.getByText(
        "You can inspect the graph; changes stay with the creator's browser."
      )
    ).not.toBeNull();
    expect(
      (screen.getByRole("button", { name: "Rebuild graph" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Export notes" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });
});
