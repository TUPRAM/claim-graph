import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "@/lib/server/database";
import {
  getLegacyStoreFilePath,
  getStoreDatabasePath
} from "@/lib/server/runtime-data";
import {
  getRun,
  getWorkspaceGraphPayload,
  getWorkspaceRetrievalState,
  resetStoreForTests
} from "@/lib/server/store";
import type {
  ClaimInventoryRecord,
  EvidencePackRecord,
  Run,
  Workspace,
  WorkspaceFile
} from "@/types/claimgraph";

const originalDataDir = process.env.CLAIMGRAPH_DATA_DIR;
const testDataDir = path.join(process.cwd(), "runtime_data", "test_state", "store-migration");

describe("legacy JSON store migration", () => {
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

  it("migrates the legacy JSON snapshot into SQLite and keeps working without the JSON file", () => {
    const workspace: Workspace = {
      id: "legacy_workspace",
      question: "Should cities ban cars downtown?",
      createdAt: "2026-04-08T10:00:00.000Z",
      updatedAt: "2026-04-08T10:00:00.000Z",
      settings: {
        maxWebSources: 8,
        maxFiles: 5,
        freshnessBias: "high",
        preferPrimarySources: true,
        includeOpposingEvidence: true
      },
      sourceUrls: []
    };
    const run: Run = {
      id: "run_legacy",
      workspaceId: workspace.id,
      status: "completed",
      createdAt: "2026-04-08T10:01:00.000Z",
      completedAt: "2026-04-08T10:02:00.000Z",
      statusMessage: "Legacy live graph loaded.",
      metrics: {
        sourceCount: 1,
        snippetCount: 1,
        claimCount: 1,
        counterclaimCount: 0,
        evidenceCount: 1,
        gapCount: 0,
        totalNodeCount: 3,
        strongestDisagreementScore: 0.76,
        durationMs: 60000
      },
      observability: {
        stages: [
          {
            stage: "queued",
            startedAt: "2026-04-08T10:01:00.000Z",
            completedAt: "2026-04-08T10:01:02.000Z",
            durationMs: 2000
          }
        ],
        exportEvents: []
      }
    };
    const file: WorkspaceFile = {
      id: "file_legacy",
      workspaceId: workspace.id,
      originalName: "memo.md",
      storedName: "memo-legacy.md",
      mimeType: "text/markdown",
      extension: "md",
      sizeBytes: 120,
      uploadedAt: "2026-04-08T10:00:30.000Z"
    };
    const evidence: EvidencePackRecord = {
      runId: run.id,
      createdAt: "2026-04-08T10:01:20.000Z",
      model: "gpt-5.4",
      responseId: "resp_legacy_evidence",
      evidencePack: {
        question: workspace.question,
        summary: "Legacy evidence summary.",
        subquestions: ["What happens to retail?"],
        evidenceAxes: [],
        sources: [
          {
            id: "source_legacy",
            type: "web",
            title: "Legacy Source",
            url: "https://example.com/legacy",
            domain: "example.com"
          }
        ],
        snippets: [
          {
            id: "snippet_legacy",
            sourceId: "source_legacy",
            text: "Legacy snippet text.",
            rationale: "Legacy rationale.",
            relevance: 0.88
          }
        ],
        openQuestions: [],
        warnings: []
      }
    };
    const claimInventory: ClaimInventoryRecord = {
      runId: run.id,
      createdAt: "2026-04-08T10:01:30.000Z",
      model: "gpt-5.4-pro",
      responseId: "resp_legacy_claims",
      claimInventory: {
        question: workspace.question,
        claims: [
          {
            id: "claim_legacy",
            kind: "claim",
            title: "Legacy claim",
            summary: "Legacy claim summary.",
            topic: "Transport",
            stance: "pro",
            confidence: 0.82,
            evidenceQuality: "high",
            sourceIds: ["source_legacy"],
            snippetIds: ["snippet_legacy"],
            qualifiers: [],
            dependsOnGapIds: []
          }
        ],
        contradictionPairs: [],
        unresolvedGaps: []
      }
    };

    const legacySnapshot = {
      version: 5,
      workspaces: [workspace],
      runs: [run],
      workspaceRunOrder: [[workspace.id, [run.id]]],
      files: [file],
      evidencePacks: [evidence],
      claimInventories: [claimInventory],
      retrievalStates: [
        {
          workspaceId: workspace.id,
          vectorStoreId: "vs_legacy",
          fileBindings: [
            {
              workspaceFileId: file.id,
              openAIFileId: "file_openai_legacy",
              vectorStoreFileId: "vs_file_legacy",
              syncedAt: "2026-04-08T10:00:45.000Z"
            }
          ]
        }
      ],
      graphs: [
        [
          workspace.id,
          {
            origin: "live",
            mode: "full",
            provider: "openai",
            createdAt: "2026-04-08T10:01:40.000Z",
            model: "gpt-5.4",
            responseId: "resp_legacy_graph",
            runId: run.id,
            graph: {
              question: workspace.question,
              graphSummary: "Legacy graph summary.",
              primaryClusterId: undefined,
              nodes: [
                {
                  id: "question_root",
                  kind: "question",
                  title: workspace.question,
                  summary: "question",
                  sourceIds: [],
                  snippetIds: []
                },
                {
                  id: "claim_legacy",
                  kind: "claim",
                  title: "Legacy claim",
                  summary: "Legacy claim summary.",
                  topic: "Transport",
                  stance: "pro",
                  confidence: 0.82,
                  sourceIds: ["source_legacy"],
                  snippetIds: ["snippet_legacy"]
                },
                {
                  id: "evidence_legacy",
                  kind: "evidence",
                  title: "Legacy evidence",
                  summary: "Legacy evidence summary.",
                  sourceIds: ["source_legacy"],
                  snippetIds: ["snippet_legacy"]
                }
              ],
              edges: [
                {
                  id: "edge_legacy",
                  from: "claim_legacy",
                  to: "question_root",
                  relation: "supports",
                  strength: 0.82
                }
              ],
              disagreementClusters: []
            },
            sources: evidence.evidencePack.sources,
            snippets: evidence.evidencePack.snippets
          }
        ]
      ]
    };

    mkdirSync(testDataDir, { recursive: true });
    writeFileSync(
      getLegacyStoreFilePath(),
      JSON.stringify(legacySnapshot, null, 2)
    );

    const migratedPayload = getWorkspaceGraphPayload(workspace.id);

    expect(migratedPayload?.starterMode).toBe(false);
    expect(migratedPayload?.workspace.question).toBe(workspace.question);
    expect(migratedPayload?.files[0]?.originalName).toBe("memo.md");
    expect(migratedPayload?.evidence?.responseId).toBe("resp_legacy_evidence");
    expect(migratedPayload?.claimInventory?.responseId).toBe("resp_legacy_claims");
    expect(getWorkspaceRetrievalState(workspace.id)?.vectorStoreId).toBe("vs_legacy");
    expect(getRun(run.id)?.statusMessage).toBe("Legacy live graph loaded.");
    expect(existsSync(getStoreDatabasePath())).toBe(true);
    const versionedDb = new Database(getStoreDatabasePath(), { readonly: true });
    const versionRow = versionedDb.prepare(`
      SELECT MAX(version) AS version
      FROM schema_version
    `).get() as { version: number };
    versionedDb.close();

    expect(versionRow.version).toBe(CURRENT_DATABASE_SCHEMA_VERSION);

    unlinkSync(getLegacyStoreFilePath());
    resetStoreForTests();

    const payloadAfterRemovingJson = getWorkspaceGraphPayload(workspace.id);

    expect(payloadAfterRemovingJson?.graph.graphSummary).toBe("Legacy graph summary.");
    expect(payloadAfterRemovingJson?.files[0]?.originalName).toBe("memo.md");
  });

  it("retires duplicate active legacy runs before creating the single-flight index", () => {
    const workspace: Workspace = {
      id: "legacy_duplicate_active_workspace",
      question: "Which legacy active run should survive migration?",
      createdAt: "2026-04-08T10:00:00.000Z",
      updatedAt: "2026-04-08T10:03:00.000Z",
      settings: {
        maxWebSources: 8,
        maxFiles: 5,
        freshnessBias: "high",
        preferPrimarySources: true,
        includeOpposingEvidence: true
      },
      sourceUrls: []
    };
    const olderRun: Run = {
      id: "run_legacy_active_older",
      workspaceId: workspace.id,
      status: "gathering",
      createdAt: "2026-04-08T10:01:00.000Z",
      observability: { stages: [], exportEvents: [] }
    };
    const newerRun: Run = {
      id: "run_legacy_active_newer",
      workspaceId: workspace.id,
      status: "extracting",
      createdAt: "2026-04-08T10:02:00.000Z",
      observability: { stages: [], exportEvents: [] }
    };

    mkdirSync(testDataDir, { recursive: true });
    writeFileSync(
      getLegacyStoreFilePath(),
      JSON.stringify(
        {
          version: 5,
          workspaces: [workspace],
          runs: [olderRun, newerRun],
          workspaceRunOrder: [
            [workspace.id, [olderRun.id, newerRun.id]]
          ]
        },
        null,
        2
      )
    );

    const payload = getWorkspaceGraphPayload(workspace.id);

    expect(payload?.latestRun).toMatchObject({
      id: newerRun.id,
      status: "extracting"
    });
    expect(getRun(olderRun.id)).toMatchObject({
      status: "failed",
      errorMessage:
        "This duplicate active legacy run was superseded during SQLite migration."
    });
  });
});
