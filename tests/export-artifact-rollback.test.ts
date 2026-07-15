import { afterEach, describe, expect, it, vi } from "vitest";

const artifact = {
  storageProvider: "vercel_blob" as const,
  key: "workspaces/ws/exports/export.png",
  sizeBytes: 8,
  contentType: "image/png"
};

function routeContext() {
  return {
    params: Promise.resolve({ workspaceId: "ws" })
  };
}

async function installRouteMocks(input?: {
  markdown?: string;
  maxPayloadBytes?: number;
  recordEventFails?: boolean;
}) {
  const deletePersistedWorkspaceObject = vi.fn(async () => true);
  const persistWorkspaceExportArtifact = vi.fn(async () => artifact);
  const getWorkspaceAlphaAssessment = vi.fn(async () => ({
    blockerNotes: "SECRET_ALPHA_ASSESSMENT_CANARY"
  }));
  const recordWorkspaceExportEvent = vi.fn(async () => {
    if (input?.recordEventFails !== false) {
      throw new Error("database event write failed");
    }
  });

  vi.doMock("@/lib/server/object-storage", () => ({
    deletePersistedWorkspaceObject,
    persistWorkspaceExportArtifact
  }));
  vi.doMock("@/lib/server/storage/store-factory", () => ({
    getClaimGraphStore: vi.fn(async () => ({
      getWorkspaceGraphPayload: vi.fn(async () => ({ starterMode: true })),
      getWorkspaceAlphaAssessment,
      recordWorkspaceExportEvent
    }))
  }));
  vi.doMock("@/lib/server/workspace-capability", () => ({
    requireWorkspaceMutation: vi.fn(async () => null)
  }));
  vi.doMock("@/lib/server/retention-cleanup", () => ({
    enqueueOrphanObjectCleanup: vi.fn(),
    scheduleExportRetention: vi.fn()
  }));
  vi.doMock("@/lib/server/public-beta-control-store", () => ({
    getEffectivePublicBetaControls: vi.fn(async () => ({ exportLimit: 20 })),
    consumePublicBetaRateLimit: vi.fn(async () => ({
      allowed: true,
      retryAfterSeconds: 0,
      limit: 20,
      remaining: 19,
      resetAt: new Date(Date.now() + 60_000).toISOString()
    }))
  }));
  vi.doMock("@/lib/server/public-beta-policy", () => ({
    getPublicBetaPolicy: vi.fn(() => ({
      export: {
        windowMs: 60_000,
        maxPayloadBytes: input?.maxPayloadBytes ?? 8 * 1024 * 1024
      }
    }))
  }));
  vi.doMock("@/lib/server/export-markdown", () => ({
    buildPublicGraphMarkdown: vi.fn(() => input?.markdown ?? "# export")
  }));

  return {
    deletePersistedWorkspaceObject,
    persistWorkspaceExportArtifact,
    getWorkspaceAlphaAssessment,
    recordWorkspaceExportEvent
  };
}

describe("export artifact rollback", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("deletes a persisted PNG when the later export-event write fails", async () => {
    const mocks = await installRouteMocks();
    const { POST } = await import(
      "@/app/api/workspaces/[workspaceId]/export/png/route"
    );
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const request = new Request("http://localhost/api/workspaces/ws/export/png", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        success: true,
        pngDataUrl: `data:image/png;base64,${png.toString("base64")}`
      })
    });

    await expect(POST(request, routeContext())).rejects.toThrow(
      "database event write failed"
    );
    expect(mocks.deletePersistedWorkspaceObject).toHaveBeenCalledWith({
      workspaceId: "ws",
      storageProvider: "vercel_blob",
      key: artifact.key,
      kind: "export"
    });
  });

  it("deletes a persisted Markdown export when event persistence fails", async () => {
    const mocks = await installRouteMocks();
    const { POST } = await import(
      "@/app/api/workspaces/[workspaceId]/export/markdown/route"
    );
    const request = new Request("http://localhost/api/workspaces/ws/export/markdown", {
      method: "POST"
    });

    await expect(POST(request, routeContext())).rejects.toThrow(
      "database event write failed"
    );
    expect(mocks.deletePersistedWorkspaceObject).toHaveBeenCalledWith({
      workspaceId: "ws",
      storageProvider: "vercel_blob",
      key: artifact.key,
      kind: "export"
    });
  });

  it("rejects generated Markdown above the configured export payload ceiling", async () => {
    const mocks = await installRouteMocks({
      markdown: "x".repeat(1_025),
      maxPayloadBytes: 1_024
    });
    const { POST } = await import(
      "@/app/api/workspaces/[workspaceId]/export/markdown/route"
    );
    const response = await POST(
      new Request("http://localhost/api/workspaces/ws/export/markdown", {
        method: "POST"
      }),
      routeContext()
    );

    expect(response.status).toBe(413);
    expect(mocks.persistWorkspaceExportArtifact).not.toHaveBeenCalled();
    expect(mocks.recordWorkspaceExportEvent).not.toHaveBeenCalled();
  });

  it("does not read protected alpha assessment notes for owner-facing exports", async () => {
    const mocks = await installRouteMocks({
      markdown: "# public export",
      recordEventFails: false
    });
    const { POST } = await import(
      "@/app/api/workspaces/[workspaceId]/export/markdown/route"
    );
    const response = await POST(
      new Request("http://localhost/api/workspaces/ws/export/markdown", {
        method: "POST"
      }),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("# public export");
    expect(mocks.getWorkspaceAlphaAssessment).not.toHaveBeenCalled();
  });
});
