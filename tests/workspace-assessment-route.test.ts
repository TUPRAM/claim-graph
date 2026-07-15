import path from "node:path";
import { rmSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET, PUT } from "@/app/api/dev/workspaces/[workspaceId]/assessment/route";
import {
  createWorkspace,
  getWorkspaceAlphaAssessment,
  resetStoreForTests
} from "@/lib/server/store";
import { withDevSession } from "./helpers/dev-auth";

const originalDataDir = process.env.CLAIMGRAPH_DATA_DIR;
const testDataDir = path.join(process.cwd(), "runtime_data", "test_state", "workspace-assessment");

describe("workspace alpha assessment route", () => {
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

  it("loads and saves a workspace-tied alpha assessment", async () => {
    const workspace = createWorkspace("Should companies default to remote work?");

    const initialResponse = await GET(
      withDevSession(new Request("http://localhost/api/dev/workspaces/test/assessment")),
      {
        params: Promise.resolve({ workspaceId: workspace.id })
      }
    );
    const initialJson = (await initialResponse.json()) as {
      assessment: unknown;
    };

    expect(initialResponse.status).toBe(200);
    expect(initialJson.assessment).toBeNull();

    const putResponse = await PUT(
      withDevSession(new Request("http://localhost/api/dev/workspaces/test/assessment", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost"
        },
        body: JSON.stringify({
          reviewerRole: "product",
          verdict: "useful_with_notes",
          wouldRevisit: true,
          wouldShareExport: false,
          strongestDisagreementRating: 4,
          provenanceTrustRating: 4,
          confusionPoints: "The export is useful, but the weakest branch still needs clearer evidence volume signals.",
          blockerNotes: "Only one case is review-ready across the live eval manifest.",
          followUpQuestion: "Can the repo recover another real live case before launch?"
        })
      })),
      {
        params: Promise.resolve({ workspaceId: workspace.id })
      }
    );
    const putJson = (await putResponse.json()) as {
      assessment: {
        workspaceId: string;
        reviewerRole: string;
      };
    };

    expect(putResponse.status).toBe(200);
    expect(putJson.assessment.workspaceId).toBe(workspace.id);
    expect(putJson.assessment.reviewerRole).toBe("product");

    const storedAssessment = getWorkspaceAlphaAssessment(workspace.id);
    expect(storedAssessment?.verdict).toBe("useful_with_notes");

    const readbackResponse = await GET(
      withDevSession(new Request("http://localhost/api/dev/workspaces/test/assessment")),
      {
        params: Promise.resolve({ workspaceId: workspace.id })
      }
    );
    const readbackJson = (await readbackResponse.json()) as {
      assessment: {
        blockerNotes: string;
      };
    };

    expect(readbackJson.assessment.blockerNotes).toContain("Only one case is review-ready");
  });
});
