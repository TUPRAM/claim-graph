import { rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as getDevGraphRoute } from "@/app/api/dev/workspaces/[workspaceId]/graph/route";
import { POST as exportPngRoute } from "@/app/api/workspaces/[workspaceId]/export/png/route";
import { POST as exportMarkdownRoute } from "@/app/api/workspaces/[workspaceId]/export/markdown/route";
import { resetStoreForTests } from "@/lib/server/store";
import { getOperationalEventSummary } from "@/lib/server/operational-events";
import type { WorkspaceGraphPayload } from "@/types/claimgraph";
import { withDevSession } from "./helpers/dev-auth";

const originalDataDir = process.env.CLAIMGRAPH_DATA_DIR;
const testDataDir = path.join(process.cwd(), "runtime_data", "test_state", "export-png-route");

function workspaceRouteContext(workspaceId: string) {
  return {
    params: Promise.resolve({ workspaceId })
  };
}

describe("workspace PNG export route", () => {
  beforeEach(() => {
    process.env.CLAIMGRAPH_DATA_DIR = testDataDir;
    rmSync(testDataDir, { recursive: true, force: true });
    resetStoreForTests();
  });

  afterAll(() => {
    rmSync(testDataDir, { recursive: true, force: true });
    resetStoreForTests();

    if (originalDataDir === undefined) {
      delete process.env.CLAIMGRAPH_DATA_DIR;
    } else {
      process.env.CLAIMGRAPH_DATA_DIR = originalDataDir;
    }
  });

  it("returns the browser-capture PNG export contract for a workspace", async () => {
    const response = await exportPngRoute(
      new Request("http://localhost/api/workspaces/demo/export/png", {
        method: "POST"
      }),
      workspaceRouteContext("demo")
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      mode: "client_capture",
      workspaceId: "demo",
      starterMode: true
    });
  });

  it("logs PNG export usage against the latest workspace run", async () => {
    const exportRequest = () =>
      withDevSession(new Request("http://localhost/api/workspaces/demo/export/png", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
          "Idempotency-Key": "png-export-idempotency-1"
        },
        body: JSON.stringify({
          strongestOnly: true,
          unresolvedOnly: true,
          focusClusterId: "dc_business",
          hiddenKinds: ["gap"],
          selectedNodeId: "q_root",
          viewport: {
            width: 1120,
            height: 640
          },
          success: true
        })
      }));
    const response = await exportPngRoute(
      exportRequest(),
      workspaceRouteContext("demo")
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      mode: "client_capture",
      workspaceId: "demo"
    });

    const replay = await exportPngRoute(
      exportRequest(),
      workspaceRouteContext("demo")
    );
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");

    const graphResponse = await getDevGraphRoute(
      withDevSession(new Request("http://localhost/api/dev/workspaces/demo/graph")),
      workspaceRouteContext("demo")
    );
    const graphPayload = (await graphResponse.json()) as WorkspaceGraphPayload;
    const exportEvent = graphPayload.run?.observability?.exportEvents.at(-1);
    expect(graphPayload.run?.observability?.exportEvents).toHaveLength(1);

    expect(exportEvent).toMatchObject({
      format: "png",
      mode: "client_capture",
      success: true,
      strongestOnly: true,
      unresolvedOnly: true,
      focusClusterId: "dc_business",
      hiddenKinds: ["gap"],
      selectedNodeId: "q_root",
      viewportWidth: 1120,
      viewportHeight: 640
    });
  });

  it("counts a failed browser capture separately from completed exports", async () => {
    const response = await exportPngRoute(
      withDevSession(new Request("http://localhost/api/workspaces/demo/export/png", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost"
        },
        body: JSON.stringify({
          success: false,
          errorMessage: "The browser capture failed."
        })
      })),
      workspaceRouteContext("demo")
    );

    expect(response.status).toBe(200);
    await expect(getOperationalEventSummary()).resolves.toEqual([
      expect.objectContaining({
        eventType: "export-failed",
        occurrenceCount: 1
      })
    ]);
  });

  it("replays a Markdown idempotency key without persisting another export", async () => {
    const exportRequest = () => withDevSession(
      new Request("http://localhost/api/workspaces/demo/export/markdown", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
          "Idempotency-Key": "markdown-export-idempotency-1"
        },
        body: JSON.stringify({ strongestOnly: true })
      })
    );
    const first = await exportMarkdownRoute(
      exportRequest(),
      workspaceRouteContext("demo")
    );
    const replay = await exportMarkdownRoute(
      exportRequest(),
      workspaceRouteContext("demo")
    );
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(await replay.text()).toBe(await first.text());

    const graphResponse = await getDevGraphRoute(
      withDevSession(new Request("http://localhost/api/dev/workspaces/demo/graph")),
      workspaceRouteContext("demo")
    );
    const graphPayload = (await graphResponse.json()) as WorkspaceGraphPayload;
    expect(graphPayload.run?.observability?.exportEvents).toHaveLength(1);
  });
});
