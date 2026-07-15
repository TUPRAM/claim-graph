import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RetrievalArtifactRecord, WorkspaceFile } from "@/types/claimgraph";

const originalDataDir = process.env.CLAIMGRAPH_DATA_DIR;
const originalApiKey = process.env.OPENAI_API_KEY;
const testDataDir = path.join(process.cwd(), "runtime_data", "test_state", "vector-store-cleanup");

function buildWorkspaceFile(workspaceId: string, name = "notes.txt"): WorkspaceFile {
  const id = crypto.randomUUID();

  return {
    id,
    workspaceId,
    originalName: name,
    storedName: `${id}.txt`,
    mimeType: "text/plain",
    extension: "txt",
    sizeBytes: 14,
    uploadedAt: new Date().toISOString()
  };
}

async function importModules() {
  const storeModule = await import("@/lib/server/store");
  const runtimeDataModule = await import("@/lib/server/runtime-data");
  const vectorStoreModule = await import("@/lib/openai/vector-store");

  return {
    storeModule,
    runtimeDataModule,
    vectorStoreModule
  };
}

describe("vector store cleanup bookkeeping", () => {
  beforeEach(() => {
    process.env.CLAIMGRAPH_DATA_DIR = path.join(testDataDir, crypto.randomUUID());
    process.env.OPENAI_API_KEY = "test-key";
    vi.resetModules();
  });

  afterAll(() => {
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

  it("captures best-effort cleanup for orphaned artifacts when sync is canceled", async () => {
    const controller = new AbortController();
    const clientMock = {
      files: {
        create: vi.fn(async (input: { file?: { destroy?: () => void } }) => {
          input.file?.destroy?.();

          return {
            id: "file_new"
          };
        }),
        retrieve: vi.fn(async () => ({
          id: "file_new",
          filename: "notes.txt",
          status: "processed"
        })),
        delete: vi.fn(async () => ({
          id: "file_new",
          deleted: true
        }))
      },
      vectorStores: {
        create: vi.fn(async () => ({
          id: "vs_new"
        })),
        delete: vi.fn(async () => ({
          id: "vs_new",
          deleted: true
        })),
        files: {
          create: vi.fn(async () => {
            setTimeout(() => controller.abort(), 0);

            return {
              id: "vsf_new"
            };
          }),
          poll: vi.fn(async (_vectorStoreId: string, _fileId: string, options?: {
            signal?: AbortSignal;
          }) => {
            if (options?.signal?.aborted) {
              throw new DOMException("The operation was aborted.", "AbortError");
            }

            await new Promise<void>((_resolve, reject) => {
              function handleAbort() {
                options?.signal?.removeEventListener("abort", handleAbort);
                reject(new DOMException("The operation was aborted.", "AbortError"));
              }

              options?.signal?.addEventListener("abort", handleAbort, { once: true });
            });

            return {
              id: "vsf_new",
              status: "completed"
            };
          }),
          delete: vi.fn(async () => ({
            id: "vsf_new",
            deleted: true
          }))
        }
      }
    };

    vi.doMock("@/lib/openai/client", () => ({
      getOpenAIClient: () => clientMock
    }));

    const { storeModule, runtimeDataModule, vectorStoreModule } = await importModules();
    storeModule.resetStoreForTests();

    const workspace = storeModule.createWorkspace("Should cities ban cars downtown?");
    const run = storeModule.createRun(workspace.id);
    const file = buildWorkspaceFile(workspace.id);
    storeModule.addWorkspaceFiles(workspace.id, [file]);
    writeFileSync(
      runtimeDataModule.getWorkspaceUploadFilePath(workspace.id, file.storedName),
      "Transit notes"
    );

    await expect(
      vectorStoreModule.ensureWorkspaceVectorStore({
        workspaceId: workspace.id,
        runId: run.id,
        files: [file],
        signal: controller.signal
      })
    ).rejects.toMatchObject({
      name: "AbortError"
    });

    const retrievalState = storeModule.getWorkspaceRetrievalState(workspace.id);
    const persistedRun = storeModule.getRun(run.id);

    expect(retrievalState?.vectorStoreId).toBeUndefined();
    expect(retrievalState?.fileBindings).toEqual([]);
    expect(retrievalState?.transientArtifacts).toEqual([]);
    expect(retrievalState?.pendingCleanup).toEqual([]);
    expect(retrievalState?.cleanupHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "openai_file",
          remoteId: "file_new",
          reason: "run_canceled",
          status: "deleted"
        }),
        expect.objectContaining({
          kind: "vector_store_file",
          remoteId: "vsf_new",
          reason: "run_canceled",
          status: "deleted"
        }),
        expect.objectContaining({
          kind: "vector_store",
          remoteId: "vs_new",
          reason: "run_canceled",
          status: "deleted"
        })
      ])
    );
    expect(persistedRun?.observability?.retrievalCleanupEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "openai_file",
          reason: "run_canceled"
        }),
        expect.objectContaining({
          kind: "vector_store_file",
          reason: "run_canceled"
        }),
        expect.objectContaining({
          kind: "vector_store",
          reason: "run_canceled"
        })
      ])
    );
  });

  it("promotes stale transient artifacts into cleanup history on the next sync", async () => {
    const clientMock = {
      files: {
        create: vi.fn(async (input: { file?: { destroy?: () => void } }) => {
          input.file?.destroy?.();

          return {
            id: "file_new"
          };
        }),
        retrieve: vi.fn(async () => ({
          id: "file_new",
          filename: "notes.txt",
          status: "processed"
        })),
        delete: vi.fn(async () => ({
          deleted: true
        }))
      },
      vectorStores: {
        create: vi.fn(async () => ({
          id: "vs_should_not_be_created"
        })),
        delete: vi.fn(async () => ({
          deleted: true
        })),
        files: {
          create: vi.fn(async () => ({
            id: "vsf_new"
          })),
          poll: vi.fn(async () => ({
            id: "vsf_new",
            status: "completed"
          })),
          delete: vi.fn(async () => ({
            deleted: true
          }))
        }
      }
    };

    vi.doMock("@/lib/openai/client", () => ({
      getOpenAIClient: () => clientMock
    }));

    const { storeModule, runtimeDataModule, vectorStoreModule } = await importModules();
    storeModule.resetStoreForTests();

    const workspace = storeModule.createWorkspace("Should cities ban cars downtown?");
    const staleRun = storeModule.createRun(workspace.id);
    storeModule.markRunFailed(staleRun.id, "Runner went stale.", {
      fallbackReason: "analysis_stale"
    });

    const transientArtifacts: RetrievalArtifactRecord[] = [
      {
        id: crypto.randomUUID(),
        kind: "openai_file",
        remoteId: "file_old",
        workspaceFileId: "workspace_file_old",
        runId: staleRun.id,
        createdAt: new Date().toISOString()
      },
      {
        id: crypto.randomUUID(),
        kind: "vector_store_file",
        remoteId: "vsf_old",
        vectorStoreId: "vs_existing",
        workspaceFileId: "workspace_file_old",
        runId: staleRun.id,
        createdAt: new Date().toISOString()
      }
    ];
    storeModule.saveWorkspaceRetrievalState({
      workspaceId: workspace.id,
      vectorStoreId: "vs_existing",
      fileBindings: [],
      transientArtifacts,
      pendingCleanup: [],
      cleanupHistory: []
    });

    const file = buildWorkspaceFile(workspace.id);
    const nextRun = storeModule.createRun(workspace.id);
    storeModule.addWorkspaceFiles(workspace.id, [file]);
    writeFileSync(
      runtimeDataModule.getWorkspaceUploadFilePath(workspace.id, file.storedName),
      "Transit notes"
    );

    const retrievalState = await vectorStoreModule.ensureWorkspaceVectorStore({
      workspaceId: workspace.id,
      runId: nextRun.id,
      files: [file]
    });
    const persistedRun = storeModule.getRun(nextRun.id);

    expect(clientMock.vectorStores.create).not.toHaveBeenCalled();
    expect(retrievalState?.vectorStoreId).toBe("vs_existing");
    expect(retrievalState?.transientArtifacts).toEqual([]);
    expect(retrievalState?.pendingCleanup).toEqual([]);
    expect(retrievalState?.cleanupHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "openai_file",
          remoteId: "file_old",
          reason: "analysis_stale",
          status: "deleted"
        }),
        expect.objectContaining({
          kind: "vector_store_file",
          remoteId: "vsf_old",
          reason: "analysis_stale",
          status: "deleted"
        })
      ])
    );
    expect(retrievalState?.fileBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceFileId: file.id,
          openAIFileId: "file_new",
          vectorStoreFileId: "vsf_new"
        })
      ])
    );
    expect(persistedRun?.observability?.retrievalCleanupEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          remoteId: "file_old",
          reason: "analysis_stale"
        }),
        expect.objectContaining({
          remoteId: "vsf_old",
          reason: "analysis_stale",
          status: "deleted"
        })
      ])
    );
  });
});
