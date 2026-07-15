import { rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { withClaimGraphDatabase } from "@/lib/server/database";
import { resetStoreForTests } from "@/lib/server/store";
import {
  createRun,
  createWorkspace,
  getLatestClaimInventory,
  getLatestEvidencePack,
  getWorkspaceGraphPayload
} from "@/lib/server/store";
import {
  CURRENT_CLAIM_INVENTORY_RECORD_VERSION,
  CURRENT_WORKSPACE_GRAPH_RECORD_VERSION,
  normalizeClaimInventoryRecord
} from "@/lib/validation/persisted-artifacts";

const originalDataDir = process.env.CLAIMGRAPH_DATA_DIR;
const testDataDir = path.join(process.cwd(), "runtime_data", "test_state", "persisted-artifacts");

describe("persisted artifact guards", () => {
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

  it("normalizes legacy evidence and claim inventory records on read", () => {
    const workspace = createWorkspace("Should cities ban cars downtown?");
    const run = createRun(workspace.id);

    withClaimGraphDatabase((db) => {
      db.prepare(`
        INSERT INTO evidence_packs (run_id, workspace_id, created_at, data)
        VALUES (?, ?, ?, ?)
      `).run(
        run.id,
        workspace.id,
        run.createdAt,
        JSON.stringify({
          runId: run.id,
          createdAt: run.createdAt,
          model: "gpt-5.4",
          responseId: "resp_legacy_evidence",
          evidencePack: {
            question: workspace.question,
            summary: "Legacy evidence summary.",
            subquestions: ["What happened to air quality?"],
            evidenceAxes: [],
            sources: [
              {
                id: "source_web_1",
                type: "web",
                title: "Legacy web source",
                url: "https://example.com/legacy",
                domain: "example.com"
              }
            ],
            snippets: [
              {
                id: "snippet_web_1",
                sourceId: "source_web_1",
                text: "Legacy cited span.",
                rationale: "Legacy rationale.",
                relevance: 0.82,
                offsetStart: 4,
                offsetEnd: 22
              }
            ],
            openQuestions: [],
            warnings: []
          }
        })
      );

      db.prepare(`
        INSERT INTO claim_inventories (run_id, workspace_id, created_at, data)
        VALUES (?, ?, ?, ?)
      `).run(
        run.id,
        workspace.id,
        run.createdAt,
        JSON.stringify({
          runId: run.id,
          createdAt: run.createdAt,
          model: "gpt-5.4-pro",
          responseId: "resp_legacy_claims",
          claimInventory: {
            question: workspace.question,
            claims: [
              {
                id: "claim_1",
                kind: "claim",
                title: "Legacy claim",
                summary: "Legacy summary.",
                topic: "Transport",
                stance: "pro",
                confidence: 0.81,
                evidenceQuality: "high",
                sourceIds: ["source_web_1"],
                snippetIds: ["snippet_web_1"],
                qualifiers: [],
                dependsOnGapIds: []
              }
            ],
            contradictionPairs: [],
            unresolvedGaps: []
          }
        })
      );
    });

    const evidence = getLatestEvidencePack(workspace.id);
    const claimInventory = getLatestClaimInventory(workspace.id);

    expect(evidence?.recordVersion).toBe(2);
    expect(evidence?.evidencePack.groundingStatus).toBe("grounded");
    expect(evidence?.evidencePack.snippets[0]?.origin).toBe("web_citation_summary_span");
    expect(claimInventory?.recordVersion).toBe(2);
    expect(claimInventory?.claimInventory.claims[0]?.title).toBe("Legacy claim");
  });

  it("returns null for malformed or unsupported persisted evidence and claim records", () => {
    const workspace = createWorkspace("Should cities ban cars downtown?");
    const run = createRun(workspace.id);

    withClaimGraphDatabase((db) => {
      db.prepare(`
        INSERT INTO evidence_packs (run_id, workspace_id, created_at, data)
        VALUES (?, ?, ?, ?)
      `).run(run.id, workspace.id, run.createdAt, "{");

      db.prepare(`
        INSERT INTO claim_inventories (run_id, workspace_id, created_at, data)
        VALUES (?, ?, ?, ?)
      `).run(
        run.id,
        workspace.id,
        run.createdAt,
        JSON.stringify({
          recordVersion: 999,
          runId: run.id,
          createdAt: run.createdAt,
          model: "gpt-5.4-pro",
          responseId: "resp_future_claims",
          claimInventory: {
            question: workspace.question,
            claims: [],
            contradictionPairs: [],
            unresolvedGaps: []
          }
        })
      );
    });

    expect(getLatestEvidencePack(workspace.id)).toBeNull();
    expect(getLatestClaimInventory(workspace.id)).toBeNull();
  });

  it("falls back to the starter graph when a persisted live graph is incompatible on read", () => {
    const workspace = createWorkspace("Should cities ban cars downtown?");
    const run = createRun(workspace.id);

    withClaimGraphDatabase((db) => {
      db.prepare(`
        INSERT INTO graphs (workspace_id, created_at, origin, run_id, data)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        workspace.id,
        run.createdAt,
        "live",
        run.id,
        JSON.stringify({
          recordVersion: CURRENT_WORKSPACE_GRAPH_RECORD_VERSION,
          origin: "live",
          createdAt: run.createdAt,
          model: "gpt-5.4",
          responseId: "resp_bad_graph",
          runId: run.id,
          graph: {
            question: workspace.question,
            graphSummary: "Bad live graph should not render.",
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
                id: "claim_bad",
                kind: "claim",
                title: "Broken claim",
                summary: "This graph references the wrong source id.",
                sourceIds: ["source_missing"],
                snippetIds: ["snippet_1"]
              }
            ],
            edges: [],
            disagreementClusters: []
          },
          sources: [
            {
              id: "source_real",
              type: "web",
              title: "Actual source",
              url: "https://example.com/source"
            }
          ],
          snippets: [
            {
              id: "snippet_1",
              sourceId: "source_real",
              text: "Snippet text.",
              rationale: "Grounding text.",
              relevance: 0.8,
              origin: "web_search_result_excerpt"
            }
          ]
        })
      );
    });

    const payload = getWorkspaceGraphPayload(workspace.id);

    expect(payload).not.toBeNull();
    expect(payload?.starterMode).toBe(true);
    expect(payload?.graph.graphSummary).not.toContain("Bad live graph");
    expect(payload?.graph.nodes.some((node) => node.kind === "question")).toBe(true);
  });

  it("falls back to the starter graph when persisted graph JSON is malformed", () => {
    const workspace = createWorkspace("Should cities ban cars downtown?");
    const run = createRun(workspace.id);

    withClaimGraphDatabase((db) => {
      db.prepare(`
        INSERT INTO graphs (workspace_id, created_at, origin, run_id, data)
        VALUES (?, ?, ?, ?, ?)
      `).run(workspace.id, run.createdAt, "live", run.id, "{");
    });

    const payload = getWorkspaceGraphPayload(workspace.id);

    expect(payload).not.toBeNull();
    expect(payload?.starterMode).toBe(true);
  });

  it("repairs sparse tradeoff disagreement clusters from persisted claim inventory on read", () => {
    const workspace = createWorkspace(
      "Should companies prioritize open models or closed models?"
    );
    const run = createRun(workspace.id);

    withClaimGraphDatabase((db) => {
      db.prepare(`
        INSERT INTO claim_inventories (run_id, workspace_id, created_at, data)
        VALUES (?, ?, ?, ?)
      `).run(
        run.id,
        workspace.id,
        run.createdAt,
        JSON.stringify({
          runId: run.id,
          createdAt: run.createdAt,
          model: "gpt-5.4",
          responseId: "resp_tradeoff_claims",
          claimInventory: {
            question: workspace.question,
            claims: [
              {
                id: "claim_closed",
                kind: "claim",
                title: "Closed vendors emphasize enterprise trust and security",
                summary:
                  "Closed vendors make a narrower case for enterprise trust and security controls.",
                topic: "Product strategy",
                stance: "pro",
                confidence: 0.66,
                evidenceQuality: "low",
                sourceIds: ["source_closed"],
                snippetIds: ["snippet_closed"],
                qualifiers: [],
                dependsOnGapIds: ["gap_regulated"]
              },
              {
                id: "counter_context",
                kind: "counterclaim",
                title: "No universal priority is established",
                summary:
                  "The evidence keeps the answer context-dependent because regulatory needs vary across deployments.",
                topic: "Product strategy",
                stance: "mixed",
                confidence: 0.74,
                evidenceQuality: "medium",
                sourceIds: ["source_regulation"],
                snippetIds: ["snippet_regulation"],
                qualifiers: [],
                dependsOnGapIds: ["gap_regulated"]
              }
            ],
            contradictionPairs: [],
            unresolvedGaps: [
              {
                id: "gap_regulated",
                title: "Regulated deployment coverage is unresolved",
                summary:
                  "The evidence does not settle how often open-model deployments satisfy regulated controls end to end.",
                gapType: "insufficient_evidence",
                sourceIds: ["source_regulation"],
                snippetIds: ["snippet_regulation"],
                importance: 0.71
              }
            ]
          }
        })
      );

      db.prepare(`
        INSERT INTO graphs (workspace_id, created_at, origin, run_id, data)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        workspace.id,
        run.createdAt,
        "live",
        run.id,
        JSON.stringify({
          recordVersion: CURRENT_WORKSPACE_GRAPH_RECORD_VERSION,
          origin: "live",
          mode: "open-model",
          provider: "open-model",
          backend: "vllm",
          createdAt: run.createdAt,
          model: "Qwen/Qwen3-8B",
          responseId: "resp_tradeoff_graph",
          runId: run.id,
          graph: {
            question: workspace.question,
            graphSummary:
              "The evidence stays context-dependent, but one closed-model branch conflicts with the no-universal-priority counterclaim.",
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
                id: "claim_closed",
                kind: "claim",
                title: "Closed vendors emphasize enterprise trust and security",
                summary:
                  "Closed vendors make a narrower case for enterprise trust and security controls.",
                topic: "Product strategy",
                stance: "pro",
                confidence: 0.66,
                sourceIds: ["source_closed"],
                snippetIds: ["snippet_closed"]
              },
              {
                id: "counter_context",
                kind: "counterclaim",
                title: "No universal priority is established",
                summary:
                  "The evidence keeps the answer context-dependent because regulatory needs vary across deployments.",
                topic: "Product strategy",
                stance: "mixed",
                confidence: 0.74,
                sourceIds: ["source_regulation"],
                snippetIds: ["snippet_regulation"]
              },
              {
                id: "gap_regulated",
                kind: "gap",
                title: "Regulated deployment coverage is unresolved",
                summary:
                  "The evidence does not settle how often open-model deployments satisfy regulated controls end to end.",
                sourceIds: ["source_regulation"],
                snippetIds: ["snippet_regulation"]
              }
            ],
            edges: [
              {
                id: "edge_question_claim_closed",
                from: "claim_closed",
                to: "question_root",
                relation: "supports",
                strength: 0.66
              },
              {
                id: "edge_question_counter_context",
                from: "counter_context",
                to: "question_root",
                relation: "refutes",
                strength: 0.74
              },
              {
                id: "edge_counter_context_claim_closed_refutes",
                from: "counter_context",
                to: "claim_closed",
                relation: "refutes",
                strength: 0.68
              },
              {
                id: "edge_gap_regulated_claim_closed_depends_on",
                from: "gap_regulated",
                to: "claim_closed",
                relation: "depends_on",
                strength: 0.71
              }
            ],
            disagreementClusters: []
          },
          sources: [
            {
              id: "source_closed",
              type: "web",
              title: "Closed-model enterprise brief",
              url: "https://example.com/closed",
              domain: "example.com"
            },
            {
              id: "source_regulation",
              type: "web",
              title: "Regulatory overview",
              url: "https://example.com/regulation",
              domain: "example.com"
            }
          ],
          snippets: [
            {
              id: "snippet_closed",
              sourceId: "source_closed",
              text: "Closed vendors emphasize enterprise trust and security commitments.",
              rationale: "Grounded closed-model support signal.",
              relevance: 0.81,
              origin: "web_search_result_excerpt"
            },
            {
              id: "snippet_regulation",
              sourceId: "source_regulation",
              text: "Regulatory obligations vary enough that no universal model priority is established.",
              rationale: "Grounded context-dependent counter-signal.",
              relevance: 0.84,
              origin: "web_search_result_excerpt"
            }
          ]
        })
      );
    });

    const payload = getWorkspaceGraphPayload(workspace.id);

    expect(payload).not.toBeNull();
    expect(payload?.starterMode).toBe(false);
    expect(payload?.claimInventory?.claimInventory.contradictionPairs).toHaveLength(1);
    expect(payload?.claimInventory?.claimInventory.contradictionPairs[0]).toMatchObject({
      id: "pair_inferred_claim_closed_counter_context",
      leftClaimId: "claim_closed",
      rightClaimId: "counter_context"
    });
    expect(payload?.graph.disagreementClusters).toHaveLength(1);
    expect(payload?.graph.primaryClusterId).toBe(
      "cluster_pair_inferred_claim_closed_counter_context"
    );
    expect(payload?.graph.disagreementClusters[0]?.claimIds).toEqual([
      "claim_closed",
      "counter_context"
    ]);
  });

  it("bounds generated claim inventory prose before persisted validation", () => {
    const longQualifier =
      "This qualifier came back from live extraction as a long explanatory sentence that names implementation conditions, institutional scope, edge cases, and examples in one field even though qualifiers need to stay compact for persistence and review.";
    const record = normalizeClaimInventoryRecord({
      recordVersion: CURRENT_CLAIM_INVENTORY_RECORD_VERSION,
      runId: "run_live_long_qualifier",
      createdAt: new Date("2026-06-19T00:00:00.000Z").toISOString(),
      model: "gpt-5.4",
      responseId: "resp_live_long_qualifier",
      claimInventory: {
        question: "Should universities require AI-use disclosures?",
        claims: [
          {
            id: "claim_disclosure",
            kind: "claim",
            title:
              "Universities can require AI-use acknowledgement while keeping the core academic policy question specific to course-level implementation and review.",
            summary:
              "Disclosure policies can help instructors understand AI involvement, but the live source material can produce a very long explanation that should still persist after safe normalization.",
            topic: "Higher education AI policy and course operations",
            stance: "pro",
            confidence: 0.72,
            evidenceQuality: "medium",
            sourceIds: ["source_1"],
            snippetIds: ["snippet_1"],
            qualifiers: [longQualifier, longQualifier],
            dependsOnGapIds: []
          }
        ],
        contradictionPairs: [
          {
            id: "pair_disclosure",
            leftClaimId: "claim_disclosure",
            rightClaimId: "counter_disclosure",
            contradictionStrength: 0.62,
            explanation:
              "This generated contradiction explanation is intentionally long enough to exercise persistence normalization without pretending that model-generated prose always obeys the requested schema length."
          }
        ],
        unresolvedGaps: []
      }
    });

    expect(record.claimInventory.claims[0]?.qualifiers).toHaveLength(1);
    expect(record.claimInventory.claims[0]?.qualifiers[0]?.length).toBeLessThanOrEqual(160);
    expect(record.claimInventory.claims[0]?.topic.length).toBeLessThanOrEqual(120);
    expect(record.claimInventory.contradictionPairs[0]?.explanation.length).toBeLessThanOrEqual(
      320
    );
  });
});
