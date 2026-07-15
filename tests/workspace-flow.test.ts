import { rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as getRunRoute } from "@/app/api/runs/[runId]/route";
import { POST as createWorkspaceRoute } from "@/app/api/workspaces/route";
import { POST as uploadWorkspaceFilesRoute } from "@/app/api/workspaces/[workspaceId]/files/route";
import { POST as analyzeWorkspaceRoute } from "@/app/api/workspaces/[workspaceId]/analyze/route";
import { POST as exportMarkdownRoute } from "@/app/api/workspaces/[workspaceId]/export/markdown/route";
import { GET as getGraphRoute } from "@/app/api/workspaces/[workspaceId]/graph/route";
import { resetAnalysisRunnerForTests } from "@/lib/server/analyze-runner";
import { resetStoreForTests } from "@/lib/server/store";
import type { WorkspaceGraphPayload } from "@/types/claimgraph";
import { getWorkspaceOwnerMutationHeaders } from "./helpers/workspace-capability";

const originalDataDir = process.env.CLAIMGRAPH_DATA_DIR;
const testDataDir = path.join(process.cwd(), "runtime_data", "test_state", "workspace-flow");

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

describe("starter workspace flow", () => {
  beforeEach(() => {
    process.env.CLAIMGRAPH_DATA_DIR = testDataDir;
    rmSync(testDataDir, { recursive: true, force: true });
    resetAnalysisRunnerForTests();
    resetStoreForTests();
  });

  afterAll(() => {
    rmSync(testDataDir, { recursive: true, force: true });
    resetAnalysisRunnerForTests();
    resetStoreForTests();

    if (originalDataDir === undefined) {
      delete process.env.CLAIMGRAPH_DATA_DIR;
    } else {
      process.env.CLAIMGRAPH_DATA_DIR = originalDataDir;
    }
  });

  it("rejects invalid JSON workspace requests", async () => {
    const response = await createWorkspaceRoute(
      new Request("http://localhost/api/workspaces", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: "{"
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON."
    });
  });

  it("creates, persists, analyzes, polls, loads, and exports a starter workspace", async () => {
    const question = "Should cities ban cars downtown?";
    const createResponse = await createWorkspaceRoute(
      new Request("http://localhost/api/workspaces", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          question,
          settings: {
            maxWebSources: 6,
            includeOpposingEvidence: true
          }
        })
      })
    );

    expect(createResponse.status).toBe(200);

    const createPayload = (await createResponse.json()) as {
      workspaceId: string;
      starterMode: boolean;
    };
    const ownerHeaders = getWorkspaceOwnerMutationHeaders(createResponse);

    expect(createPayload.workspaceId).toBeTruthy();
    expect(createPayload.starterMode).toBe(true);

    const analyzeResponse = await analyzeWorkspaceRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/analyze`, {
        method: "POST",
        headers: ownerHeaders
      }),
      workspaceRouteContext(createPayload.workspaceId)
    );

    expect(analyzeResponse.status).toBe(200);

    const analyzePayload = (await analyzeResponse.json()) as {
      runId: string;
      status: string;
      starterMode: boolean;
      accepted: boolean;
      created: boolean;
    };

    expect(analyzePayload.status).toBe("completed");
    expect(analyzePayload.starterMode).toBe(true);
    expect(analyzePayload.accepted).toBe(false);
    expect(analyzePayload.created).toBe(false);
    expect(analyzePayload.runId).toBe("run_demo");

    const starterRunResponse = await getRunRoute(
      new Request(`http://localhost/api/runs/${analyzePayload.runId}`),
      runRouteContext(analyzePayload.runId)
    );
    const starterRun = await starterRunResponse.json();

    expect(starterRunResponse.status).toBe(200);
    expect(starterRun).toMatchObject({
      id: "run_demo",
      status: "completed",
      statusMessage: "The map is ready to inspect."
    });

    const graphResponse = await getGraphRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/graph`),
      workspaceRouteContext(createPayload.workspaceId)
    );
    const graphPayload = (await graphResponse.json()) as WorkspaceGraphPayload;

    expect(graphResponse.status).toBe(200);
    expect(graphPayload.starterMode).toBe(true);
    expect(graphPayload.workspace.question).toBe(question);
    expect(graphPayload.graph.nodes.some((node) => node.kind === "question")).toBe(true);
    expect(graphPayload.sources.length).toBeGreaterThan(0);
    expect(graphPayload.snippets.length).toBeGreaterThan(0);
    expect(graphPayload.files).toEqual([]);
    expect(graphPayload.evidence).toBeNull();
    expect(graphPayload.runtime.mode).toBe("demo");
    expect(graphPayload.graphBuild.provider).toBe("starter");
    expect(graphPayload.run).toBeNull();

    const exportResponse = await exportMarkdownRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/export/markdown`, {
        method: "POST",
        headers: ownerHeaders
      }),
      workspaceRouteContext(createPayload.workspaceId)
    );
    const markdown = await exportResponse.text();

    expect(exportResponse.status).toBe(200);
    expect(exportResponse.headers.get("Content-Type")).toContain("text/markdown");
    expect(markdown).toContain(question);
    expect(markdown).toContain("## Strongest disagreement");
    expect(markdown).toContain("## Sources");
  });

  it("creates a workspace with files from multipart form data and persists them", async () => {
    const formData = new FormData();
    formData.set("question", "Should cities ban cars downtown?");
    formData.set(
      "settings",
      JSON.stringify({
        maxWebSources: 4,
        includeOpposingEvidence: true
      })
    );
    formData.append(
      "files",
      new File(["Merchant interviews"], "notes.md", { type: "text/markdown" })
    );

    const createResponse = await createWorkspaceRoute(
      new Request("http://localhost/api/workspaces", {
        method: "POST",
        body: formData
      })
    );

    expect(createResponse.status).toBe(200);

    const createPayload = (await createResponse.json()) as {
      workspaceId: string;
    };
    let graphResponse = await getGraphRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/graph`),
      workspaceRouteContext(createPayload.workspaceId)
    );
    let graphPayload = (await graphResponse.json()) as WorkspaceGraphPayload;

    expect(graphResponse.status).toBe(200);
    expect(graphPayload.files).toHaveLength(1);
    expect(graphPayload.files[0]?.originalName).toBe("notes.md");

    resetStoreForTests();

    graphResponse = await getGraphRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/graph`),
      workspaceRouteContext(createPayload.workspaceId)
    );
    graphPayload = (await graphResponse.json()) as WorkspaceGraphPayload;

    expect(graphPayload.files).toHaveLength(1);
    expect(graphPayload.files[0]?.originalName).toBe("notes.md");
  });

  it("uploads files to an existing workspace and rejects invalid uploads", async () => {
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
    const ownerHeaders = getWorkspaceOwnerMutationHeaders(createResponse);

    const validUpload = new FormData();
    validUpload.append(
      "files",
      new File(["Transit capacity audit"], "capacity.txt", { type: "text/plain" })
    );

    const uploadResponse = await uploadWorkspaceFilesRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/files`, {
        method: "POST",
        headers: ownerHeaders,
        body: validUpload
      }),
      workspaceRouteContext(createPayload.workspaceId)
    );

    expect(uploadResponse.status).toBe(200);
    await expect(uploadResponse.json()).resolves.toMatchObject({
      starterMode: true
    });

    const invalidUpload = new FormData();
    invalidUpload.append(
      "files",
      new File(["not allowed"], "script.exe", { type: "application/octet-stream" })
    );

    const invalidResponse = await uploadWorkspaceFilesRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/files`, {
        method: "POST",
        headers: ownerHeaders,
        body: invalidUpload
      }),
      workspaceRouteContext(createPayload.workspaceId)
    );

    expect(invalidResponse.status).toBe(400);
    await expect(invalidResponse.json()).resolves.toMatchObject({
      error: expect.stringContaining("Unsupported file type")
    });

    resetStoreForTests();

    const graphResponse = await getGraphRoute(
      new Request(`http://localhost/api/workspaces/${createPayload.workspaceId}/graph`),
      workspaceRouteContext(createPayload.workspaceId)
    );
    const graphPayload = (await graphResponse.json()) as WorkspaceGraphPayload;

    expect(graphPayload.files).toHaveLength(1);
    expect(graphPayload.files[0]?.originalName).toBe("capacity.txt");
  });
});
