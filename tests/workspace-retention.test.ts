import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceGraphPayload } from "@/types/claimgraph";
import { withDevSession } from "./helpers/dev-auth";
import { getWorkspaceOwnerCookie } from "./helpers/workspace-capability";

const originalDataDir = process.env.CLAIMGRAPH_DATA_DIR;
const originalApiKey = process.env.OPENAI_API_KEY;
const testDataDir = path.join(process.cwd(), "runtime_data", "test_state", "workspace-retention");

function workspaceRouteContext(workspaceId: string) {
  return {
    params: Promise.resolve({ workspaceId })
  };
}

async function importRoutes() {
  const runtimeDataModule = await import("@/lib/server/runtime-data");
  const storeModule = await import("@/lib/server/store");
  const createWorkspaceRouteImpl = (await import("@/app/api/workspaces/route")).POST;
  const workspaceFilesRoute = await import("@/app/api/workspaces/[workspaceId]/files/route");
  const deleteWorkspaceRouteImpl = (await import("@/app/api/workspaces/[workspaceId]/route")).DELETE;
  const getDevGraphRoute = (
    await import("@/app/api/dev/workspaces/[workspaceId]/graph/route")
  ).GET;
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

  return {
    runtimeDataModule,
    storeModule,
    createWorkspaceRoute,
    uploadWorkspaceFilesRoute: ((request, context) =>
      workspaceFilesRoute.POST(
        withOwnerCapability(request),
        context
      )) as typeof workspaceFilesRoute.POST,
    deleteWorkspaceFileRoute: ((request, context) =>
      workspaceFilesRoute.DELETE(
        withOwnerCapability(request),
        context
      )) as typeof workspaceFilesRoute.DELETE,
    deleteWorkspaceRoute: ((request, context) =>
      deleteWorkspaceRouteImpl(
        withOwnerCapability(request),
        context
      )) as typeof deleteWorkspaceRouteImpl,
    getGraphRoute: ((request, context) =>
      getDevGraphRoute(withDevSession(request), context)) as typeof getDevGraphRoute
  };
}

describe("workspace retention lifecycle", () => {
  beforeEach(() => {
    process.env.CLAIMGRAPH_DATA_DIR = testDataDir;
    rmSync(testDataDir, { recursive: true, force: true });
    delete process.env.OPENAI_API_KEY;
    vi.resetModules();
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
  });

  it("deletes an unindexed workspace file and keeps the starter workspace clean", async () => {
    const {
      runtimeDataModule,
      storeModule,
      createWorkspaceRoute,
      uploadWorkspaceFilesRoute,
      deleteWorkspaceFileRoute,
      getGraphRoute
    } = await importRoutes();

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
    const createPayload = (await createResponse.json()) as {
      workspaceId: string;
    };

    const uploadForm = new FormData();
    uploadForm.append(
      "files",
      new File(["Transit capacity audit"], "capacity.txt", { type: "text/plain" })
    );
    const uploadResponse = await uploadWorkspaceFilesRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/files`, {
        method: "POST",
        body: uploadForm
      }),
      workspaceRouteContext(createPayload.workspaceId)
    );
    const uploadPayload = (await uploadResponse.json()) as {
      files: Array<{ id: string; storedName: string }>;
    };

    const uploadedFile = uploadPayload.files[0];
    const storedFile = storeModule.getWorkspaceFile(
      createPayload.workspaceId,
      uploadedFile!.id
    )!;

    expect(uploadedFile).toBeTruthy();
    expect(
      existsSync(
        runtimeDataModule.getWorkspaceUploadFilePath(
          createPayload.workspaceId,
          storedFile.storedName
        )
      )
    ).toBe(true);

    const deleteResponse = await deleteWorkspaceFileRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/files`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          fileId: uploadedFile!.id
        })
      }),
      workspaceRouteContext(createPayload.workspaceId)
    );

    expect(deleteResponse.status).toBe(200);
    const deletePayload = (await deleteResponse.json()) as {
      localFileDeleted: boolean;
      invalidatedLiveArtifacts: boolean;
      cleanup: { attemptedCount: number };
    };

    expect(deletePayload.localFileDeleted).toBe(true);
    expect(deletePayload.invalidatedLiveArtifacts).toBe(false);
    expect(deletePayload.cleanup.attemptedCount).toBe(0);

    const graphResponse = await getGraphRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/graph`),
      workspaceRouteContext(createPayload.workspaceId)
    );
    const graphPayload = (await graphResponse.json()) as WorkspaceGraphPayload;

    expect(graphPayload.files).toEqual([]);
    expect(graphPayload.starterMode).toBe(true);
  });

  it("deletes an indexed workspace file, cleans known remote artifacts, and invalidates live analysis", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const clientMock = {
      files: {
        delete: vi.fn(async () => ({ deleted: true }))
      },
      vectorStores: {
        delete: vi.fn(async () => ({ deleted: true })),
        files: {
          delete: vi.fn(async () => ({ deleted: true }))
        }
      }
    };

    vi.doMock("@/lib/openai/client", () => ({
      getOpenAIClient: () => clientMock
    }));

    const {
      runtimeDataModule,
      storeModule,
      createWorkspaceRoute,
      uploadWorkspaceFilesRoute,
      deleteWorkspaceFileRoute,
      getGraphRoute
    } = await importRoutes();
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
    const createPayload = (await createResponse.json()) as {
      workspaceId: string;
    };

    const uploadForm = new FormData();
    uploadForm.append(
      "files",
      new File(["Transit capacity audit"], "capacity.txt", { type: "text/plain" })
    );
    const uploadResponse = await uploadWorkspaceFilesRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/files`, {
        method: "POST",
        body: uploadForm
      }),
      workspaceRouteContext(createPayload.workspaceId)
    );
    const uploadPayload = (await uploadResponse.json()) as {
      files: Array<{
        id: string;
        originalName: string;
        storedName: string;
      }>;
    };
    const uploadedFile = uploadPayload.files[0]!;
    const storedFile = storeModule.getWorkspaceFile(
      createPayload.workspaceId,
      uploadedFile.id
    )!;

    const liveRun = storeModule.createRun(createPayload.workspaceId);
    storeModule.updateRunStatus(
      liveRun.id,
      "gathering",
      "Preparing retained evidence fixture."
    );
    storeModule.saveWorkspaceRetrievalState({
      workspaceId: createPayload.workspaceId,
      vectorStoreId: "vs_live",
      fileBindings: [
        {
          workspaceFileId: uploadedFile.id,
          openAIFileId: "file_openai_live",
          vectorStoreFileId: "vs_file_live",
          syncedAt: new Date().toISOString()
        }
      ],
      transientArtifacts: [],
      pendingCleanup: [],
      cleanupHistory: []
    });
    storeModule.saveEvidencePack({
      runId: liveRun.id,
      createdAt: new Date().toISOString(),
      model: "gpt-5.4",
      responseId: "resp_live_evidence",
      vectorStoreId: "vs_live",
      evidencePack: {
        question: "Should cities ban cars downtown?",
        summary: "Live evidence summary.",
        subquestions: [],
        evidenceAxes: [],
        sources: [
          {
            id: "source_file_1",
            type: "file",
            title: uploadedFile.originalName,
            fileName: uploadedFile.originalName
          }
        ],
        snippets: [
          {
            id: "snippet_file_1",
            sourceId: "source_file_1",
            text: "Transit capacity audit snippet.",
            rationale: "Retrieved from file search.",
            relevance: 0.91
          }
        ],
        openQuestions: [],
        warnings: []
      }
    });
    storeModule.updateRunStatus(
      liveRun.id,
      "extracting",
      "Preparing retained claim fixture."
    );
    storeModule.saveClaimInventory({
      runId: liveRun.id,
      createdAt: new Date().toISOString(),
      model: "gpt-5.4-pro",
      responseId: "resp_live_claims",
      claimInventory: {
        question: "Should cities ban cars downtown?",
        claims: [
          {
            id: "claim_file_1",
            kind: "claim",
            title: "Transit can absorb displaced trips",
            summary: "The uploaded transit audit suggests capacity exists.",
            topic: "Transit",
            stance: "pro",
            confidence: 0.8,
            evidenceQuality: "high",
            sourceIds: ["source_file_1"],
            snippetIds: ["snippet_file_1"],
            qualifiers: [],
            dependsOnGapIds: []
          }
        ],
        contradictionPairs: [],
        unresolvedGaps: []
      }
    });
    storeModule.updateRunStatus(
      liveRun.id,
      "assembling",
      "Preparing retained graph fixture."
    );
    storeModule.saveWorkspaceGraph(createPayload.workspaceId, {
      origin: "live",
      mode: "full",
      provider: "openai",
      createdAt: new Date().toISOString(),
      model: "gpt-5.4",
      responseId: "resp_live_graph",
      runId: liveRun.id,
      graph: {
        question: "Should cities ban cars downtown?",
        graphSummary: "Live graph summary.",
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
            id: "claim_file_1",
            kind: "claim",
            title: "Transit can absorb displaced trips",
            summary: "The uploaded transit audit suggests capacity exists.",
            topic: "Transit",
            stance: "pro",
            confidence: 0.8,
            sourceIds: ["source_file_1"],
            snippetIds: ["snippet_file_1"]
          }
        ],
        edges: [
          {
            id: "edge_1",
            from: "claim_file_1",
            to: "question_root",
            relation: "supports",
            strength: 0.8
          }
        ],
        disagreementClusters: []
      },
      sources: [
        {
          id: "source_file_1",
          type: "file",
          title: uploadedFile.originalName,
          fileName: uploadedFile.originalName
        }
      ],
      snippets: [
        {
          id: "snippet_file_1",
          sourceId: "source_file_1",
          text: "Transit capacity audit snippet.",
          rationale: "Retrieved from file search.",
          relevance: 0.91
        }
      ]
    });
    storeModule.updateRunStatus(
      liveRun.id,
      "completed",
      "Live graph persisted before file deletion."
    );

    expect(
      existsSync(
        runtimeDataModule.getWorkspaceUploadFilePath(
          createPayload.workspaceId,
          storedFile.storedName
        )
      )
    ).toBe(true);

    const deleteResponse = await deleteWorkspaceFileRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/files`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          fileId: uploadedFile.id
        })
      }),
      workspaceRouteContext(createPayload.workspaceId)
    );

    expect(deleteResponse.status).toBe(200);
    const deletePayload = (await deleteResponse.json()) as {
      localFileDeleted: boolean;
      invalidatedLiveArtifacts: boolean;
      cleanup: {
        deletedCount: number;
        failedCount: number;
      };
    };

    expect(deletePayload.localFileDeleted).toBe(true);
    expect(deletePayload.invalidatedLiveArtifacts).toBe(true);
    expect(deletePayload.cleanup.deletedCount).toBe(3);
    expect(deletePayload.cleanup.failedCount).toBe(0);
    expect(clientMock.vectorStores.files.delete).toHaveBeenCalledWith("vs_file_live", {
      vector_store_id: "vs_live"
    });
    expect(clientMock.files.delete).toHaveBeenCalledWith("file_openai_live");
    expect(clientMock.vectorStores.delete).toHaveBeenCalledWith("vs_live");

    const graphResponse = await getGraphRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/graph`),
      workspaceRouteContext(createPayload.workspaceId)
    );
    const graphPayload = (await graphResponse.json()) as WorkspaceGraphPayload;
    const retrievalState = storeModule.getWorkspaceRetrievalState(createPayload.workspaceId);

    expect(graphPayload.files).toEqual([]);
    expect(graphPayload.starterMode).toBe(true);
    expect(graphPayload.evidence).toBeNull();
    expect(graphPayload.claimInventory).toBeNull();
    expect(graphPayload.run?.status).toBe("completed");
    expect(graphPayload.run?.statusMessage).toContain("was deleted");
    expect(graphPayload.run?.observability?.fallbackReason).toBe("workspace_inputs_changed");
    expect(graphPayload.run?.observability?.retrievalCleanupEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "vector_store_file",
          status: "deleted"
        }),
        expect.objectContaining({
          kind: "openai_file",
          status: "deleted"
        }),
        expect.objectContaining({
          kind: "vector_store",
          status: "deleted"
        })
      ])
    );
    expect(retrievalState?.fileBindings).toEqual([]);
    expect(retrievalState?.vectorStoreId).toBeUndefined();
    expect(
      existsSync(
        runtimeDataModule.getWorkspaceUploadFilePath(
          createPayload.workspaceId,
          storedFile.storedName
        )
      )
    ).toBe(false);
  });

  it("deletes a workspace and returns an honest cleanup summary", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const clientMock = {
      files: {
        delete: vi.fn(async () => ({ deleted: true }))
      },
      vectorStores: {
        delete: vi.fn(async () => ({ deleted: true })),
        files: {
          delete: vi.fn(async () => ({ deleted: true }))
        }
      }
    };

    vi.doMock("@/lib/openai/client", () => ({
      getOpenAIClient: () => clientMock
    }));

    const {
      runtimeDataModule,
      storeModule,
      createWorkspaceRoute,
      uploadWorkspaceFilesRoute,
      deleteWorkspaceRoute,
      getGraphRoute
    } = await importRoutes();
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
    const createPayload = (await createResponse.json()) as {
      workspaceId: string;
    };

    const uploadForm = new FormData();
    uploadForm.append(
      "files",
      new File(["Transit capacity audit"], "capacity.txt", { type: "text/plain" })
    );
    const uploadResponse = await uploadWorkspaceFilesRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/files`, {
        method: "POST",
        body: uploadForm
      }),
      workspaceRouteContext(createPayload.workspaceId)
    );
    const uploadPayload = (await uploadResponse.json()) as {
      files: Array<{
        id: string;
        storedName: string;
      }>;
    };
    const uploadedFile = uploadPayload.files[0]!;
    const storedFile = storeModule.getWorkspaceFile(
      createPayload.workspaceId,
      uploadedFile.id
    )!;

    storeModule.saveWorkspaceRetrievalState({
      workspaceId: createPayload.workspaceId,
      vectorStoreId: "vs_workspace",
      fileBindings: [
        {
          workspaceFileId: uploadedFile.id,
          openAIFileId: "file_workspace",
          vectorStoreFileId: "vs_file_workspace",
          syncedAt: new Date().toISOString()
        }
      ],
      transientArtifacts: [],
      pendingCleanup: [],
      cleanupHistory: []
    });

    const uploadPath = runtimeDataModule.getWorkspaceUploadFilePath(
      createPayload.workspaceId,
      storedFile.storedName
    );
    expect(existsSync(uploadPath)).toBe(true);

    const deleteResponse = await deleteWorkspaceRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}`, {
        method: "DELETE"
      }),
      workspaceRouteContext(createPayload.workspaceId)
    );

    expect(deleteResponse.status).toBe(200);
    const deletePayload = (await deleteResponse.json()) as {
      deleted: boolean;
      deletedLocalFilesCount: number;
      totalFiles: number;
      cleanup: {
        deletedCount: number;
      };
    };

    expect(deletePayload.deleted).toBe(true);
    expect(deletePayload.deletedLocalFilesCount).toBe(1);
    expect(deletePayload.totalFiles).toBe(1);
    expect(deletePayload.cleanup.deletedCount).toBe(3);
    expect(storeModule.getWorkspace(createPayload.workspaceId)).toBeNull();
    expect(clientMock.vectorStores.files.delete).toHaveBeenCalled();
    expect(clientMock.files.delete).toHaveBeenCalled();
    expect(clientMock.vectorStores.delete).toHaveBeenCalled();

    const graphResponse = await getGraphRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/graph`),
      workspaceRouteContext(createPayload.workspaceId)
    );

    expect(graphResponse.status).toBe(404);
    expect(existsSync(uploadPath)).toBe(false);
  });
});
