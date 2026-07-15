import { describe, expect, it } from "vitest";
import { sanitizeWorkspaceGraphPayloadForPublic } from "@/lib/server/public-workspace-payload";
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
  payload: PayloadWithoutRunIdentities
): WorkspaceGraphPayload {
  return {
    ...payload,
    latestRun: payload.run,
    activeRun: null,
    graphRun: payload.run,
    latestRunArtifacts: null,
    inProgressArtifacts: null
  };
}

function buildPayload(): WorkspaceGraphPayload {
  const createdAt = "2026-06-19T00:00:00.000Z";

  return withRunIdentities({
    workspace: {
      id: "workspace_public_payload",
      question: "Should universities require AI-use disclosures?",
      createdAt,
      updatedAt: createdAt,
      sourceUrls: [],
      settings: {
        maxWebSources: 8,
        maxFiles: 0,
        freshnessBias: "medium",
        preferPrimarySources: true,
        includeOpposingEvidence: true
      }
    },
    run: {
      id: "run_public_payload",
      workspaceId: "workspace_public_payload",
      status: "completed",
      createdAt,
      completedAt: createdAt,
      statusMessage: "Web-sourced graph assembly completed."
    },
    graph: {
      question: "Should universities require AI-use disclosures?",
      graphSummary:
        "\ue200cite\ue202turn1search5\ue201 [wordlim: 200] Published: last year; The map compares disclosure transparency with assessment-specific exceptions.",
      nodes: [
        {
          id: "question_root",
          kind: "question",
          title: "Should universities require AI-use disclosures?",
          summary: "Root question.",
          sourceIds: [],
          snippetIds: []
        },
        {
          id: "claim_transparency",
          kind: "claim",
          title: "Disclosure can improve academic transparency",
          summary:
            "\ue200cite\ue202turn1view6\ue201 Content type: text/html; Source: open({\"ref_id\":\"turn0search6\",\"lineno\":null}); Total lines: 699 L282: Disclosure can help reviewers distinguish AI assistance from original work.",
          sourceIds: ["source_web_1"],
          snippetIds: ["snippet_web_1"]
        }
      ],
      edges: [],
      disagreementClusters: [
        {
          id: "cluster_one",
          claimIds: ["claim_transparency", "claim_transparency"],
          score: 0.7,
          title: "Transparency versus policy burden",
          explanation:
            "\ue200cite\ue202turn0news12\ue201 [wordlim: 200] Crawled: last week; Redirected to URL: https://example.edu/ai-policy; The conflict turns on transparency benefits versus process burden.",
          sourceIds: ["source_web_1"],
          snippetIds: ["snippet_web_1"]
        }
      ],
      primaryClusterId: "cluster_one"
    },
    sources: [
      {
        id: "source_web_1",
        type: "web",
        title: "University AI Policy Review",
        url: "https://example.edu/ai-policy",
        domain: "example.edu",
        sourceKind: "research"
      }
    ],
    snippets: [
      {
        id: "snippet_web_1",
        sourceId: "source_web_1",
        text:
          "\ue200cite\ue202turn1view0\ue201 Content type: application/pdf; Number of pages: 16; Source: open({\"ref_id\":\"turn0search18\",\"lineno\":null}); Total lines: 670 L25@P1: Several policies frame disclosure as a transparency mechanism.",
        rationale:
          "Preserved directly from the web-search result text returned by the Responses API evidence pass.",
        relevance: 0.82,
        origin: "web_search_result_excerpt"
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
      runId: "run_public_payload"
    }
  });
}

describe("sanitizeWorkspaceGraphPayloadForPublic", () => {
  it("removes raw web-search citation and operator wording from public payload text", () => {
    const payload = sanitizeWorkspaceGraphPayloadForPublic(buildPayload());
    const publicText = JSON.stringify(payload);

    expect(publicText).toContain("Several policies frame disclosure as a transparency mechanism.");
    expect(publicText).toContain("Saved evidence excerpt from the linked source.");
    expect(publicText).not.toContain("wordlim");
    expect(publicText).not.toContain("turn1search5");
    expect(publicText).not.toContain("turn1view6");
    expect(publicText).not.toContain("turn0news12");
    expect(publicText).not.toContain("Content type:");
    expect(publicText).not.toContain("Source: open");
    expect(publicText).not.toContain("Total lines:");
    expect(publicText).not.toContain("Responses API");
    expect(publicText).not.toContain("evidence pass");
    expect(publicText).not.toContain("Published: last year");
    expect(payload.evidence).toBeNull();
    expect(payload.claimInventory).toBeNull();
    expect(payload.graphBuild.model).toBe("public-map");
  });

  it("repairs legacy persisted graph copy before public read", () => {
    const rawPayload = buildPayload();
    rawPayload.graph.graphSummary =
      "The visible graph is assembled from the saved evidence pack and persisted claim inventory.";
    rawPayload.graph.nodes[0].summary =
      "The root question anchors the live claim graph assembled from the persisted claim inventory.";
    rawPayload.graph.nodes[1].summary =
      "This branch was assembled from the saved evidence pack and saved claim inventory.";
    rawPayload.graph.disagreementClusters[0].explanation =
      "The conflict was assembled from the saved evidence pack and claim inventory.";

    const payload = sanitizeWorkspaceGraphPayloadForPublic(rawPayload);
    const publicText = JSON.stringify(payload);

    expect(payload.graph.nodes[0].summary).toBe(
      "The root question anchors the source-backed argument map and keeps every branch tied to the question."
    );
    expect(publicText).toContain("source-backed argument map");
    expect(publicText).toContain("saved sources");
    expect(publicText).toContain("saved source trails");
    expect(publicText).not.toContain("claim inventory");
    expect(publicText).not.toContain("evidence pack");
  });

  it("strips latest-run and in-progress diagnostic artifact bundles", () => {
    const rawPayload = buildPayload();
    rawPayload.latestRunArtifacts = {
      runId: "run_failed_diagnostic",
      evidence: null,
      claimInventory: null
    };
    rawPayload.inProgressArtifacts = {
      runId: "run_active_diagnostic",
      evidence: null,
      claimInventory: null
    };

    const payload = sanitizeWorkspaceGraphPayloadForPublic(rawPayload);

    expect(payload.latestRunArtifacts).toBeNull();
    expect(payload.inProgressArtifacts).toBeNull();
    expect(JSON.stringify(payload)).not.toContain("run_failed_diagnostic");
    expect(JSON.stringify(payload)).not.toContain("run_active_diagnostic");
  });

  it("allowlists every nested public field so future internal secrets fail closed", () => {
    const rawPayload = buildPayload();
    const canary = "SECRET_CANARY_MUST_NOT_LEAK";

    Object.assign(rawPayload, { futureInternalSecret: canary });
    Object.assign(rawPayload.workspace, { futureWorkspaceSecret: canary });
    Object.assign(rawPayload.workspace.settings, { futureSettingsSecret: canary });
    Object.assign(rawPayload.run!, {
      errorMessage: canary,
      observability: {
        stages: [],
        exportEvents: [],
        futureRunSecret: canary
      }
    });
    rawPayload.run!.metrics = {
      sourceCount: 1,
      snippetCount: 1,
      claimCount: 1,
      counterclaimCount: 0,
      evidenceCount: 0,
      gapCount: 0,
      totalNodeCount: 2
    };
    Object.assign(rawPayload.run!.metrics, { futureMetricsSecret: canary });
    rawPayload.latestRun = rawPayload.run;
    rawPayload.graphRun = rawPayload.run;
    rawPayload.graph.nodes[1]!.metadata = {
      qualifiers: ["Bounded qualifier"],
      futureMetadataSecret: canary
    };
    Object.assign(rawPayload.graph.nodes[1]!, { futureNodeSecret: canary });
    Object.assign(rawPayload.sources[0]!, { futureSourceSecret: canary });
    Object.assign(rawPayload.snippets[0]!, {
      futureSnippetSecret: canary,
      offsetStart: 42,
      offsetEnd: 84
    });
    rawPayload.files.push({
      id: "file_public_canary",
      workspaceId: rawPayload.workspace.id,
      originalName: "source-note.md",
      storedName: "private/blob/key.md",
      mimeType: "text/markdown; charset=utf-8",
      extension: "md",
      sizeBytes: 42,
      uploadedAt: "2026-06-19T00:00:00.000Z",
      storageProvider: "vercel_blob",
      blobKey: canary
    });
    Object.assign(rawPayload.files[0]!, { futureFileSecret: canary });

    const payload = sanitizeWorkspaceGraphPayloadForPublic(rawPayload, {
      canWrite: false
    });
    const serialized = JSON.stringify(payload);

    expect(serialized).not.toContain(canary);
    expect(payload.graph.nodes[1]?.metadata).toEqual({
      qualifiers: ["Bounded qualifier"]
    });
    expect(payload.snippets[0]).not.toHaveProperty("offsetStart");
    expect(payload.run).not.toHaveProperty("errorMessage");
    expect(payload.run).not.toHaveProperty("observability");
    expect(payload.files[0]).toEqual({
      id: "file_public_canary",
      workspaceId: rawPayload.workspace.id,
      originalName: "source-note.md",
      storedName: "source-note.md",
      mimeType: "text/markdown; charset=utf-8",
      extension: "md",
      sizeBytes: 42,
      uploadedAt: "2026-06-19T00:00:00.000Z"
    });
    expect(payload.canWrite).toBe(false);
  });

  it("omits unsafe source URLs before they can reach a public renderer", () => {
    const rawPayload = buildPayload();
    rawPayload.sources[0]!.url = "javascript:alert('claimgraph')";

    const payload = sanitizeWorkspaceGraphPayloadForPublic(rawPayload);

    expect(payload.sources[0]?.url).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("javascript:");
  });

  it("omits private targets and signed or token-bearing source links", () => {
    for (const unsafeUrl of [
      "http://169.254.169.254/latest/meta-data/",
      "http://localhost/admin",
      "https://files.example.com/report.pdf?token=SECRET_CANARY",
      "https://bucket.example.com/report.pdf?X-Amz-Signature=SECRET_CANARY"
    ]) {
      const rawPayload = buildPayload();
      rawPayload.sources[0]!.url = unsafeUrl;
      rawPayload.sources[0]!.title = unsafeUrl;
      rawPayload.sources[0]!.domain = "169.254.169.254";

      const payload = sanitizeWorkspaceGraphPayloadForPublic(rawPayload);

      expect(payload.sources[0]?.url, unsafeUrl).toBeUndefined();
      expect(JSON.stringify(payload), unsafeUrl).not.toContain("SECRET_CANARY");
      expect(JSON.stringify(payload), unsafeUrl).not.toContain("169.254.169.254");
      expect(payload.sources[0]?.title).toBe("Source link withheld");
      expect(payload.sources[0]?.domain).toBeUndefined();
    }
  });

  it("redacts a withheld source globally even when provenance bindings are missing", () => {
    const rawPayload = buildPayload();
    const canary = "SECRET_TRANSITIVE_SOURCE_CANARY";
    const fileNameCanary = "WITHHELD_FILENAME_CANARY.pdf";
    const queryNameCanary = "private_query_name_canary";
    const rawQueryNameCanary = "private%5Fquery%5Fname%5Fcanary";
    const pathSegmentCanary = "WITHHELD_PATH_SEGMENT_CANARY.pdf";
    const publishedAtCanary = "WITHHELD_PUBLICATION_CANARY";
    const unsafeUrl =
      `https://files.example.com/${pathSegmentCanary}?access_token=${canary}&${rawQueryNameCanary}=ordinary-value`;
    const unsafeTitle = `Private review source ${canary}`;

    rawPayload.sources[0]!.url = unsafeUrl;
    rawPayload.sources[0]!.title = unsafeTitle;
    rawPayload.sources[0]!.domain = "files.example.com";
    rawPayload.sources[0]!.fileName = fileNameCanary;
    rawPayload.sources[0]!.publishedAt = publishedAtCanary;
    rawPayload.workspace.question =
      `Should the useful policy comparison cite ${unsafeTitle} at ${unsafeUrl}?`;
    rawPayload.graph.question =
      `Should the useful policy comparison cite ${canary}?`;
    rawPayload.graph.graphSummary =
      `The useful overview remains visible while ${unsafeTitle}, ${unsafeUrl}, ${fileNameCanary}, ${queryNameCanary}, ${rawQueryNameCanary}, ${pathSegmentCanary}, ${publishedAtCanary}, and ${canary} stay private.`;
    rawPayload.graph.nodes.push({
      id: "evidence_private_source",
      kind: "evidence",
      title: `Evidence summarized from ${unsafeTitle}`,
      summary:
        `The useful policy comparison remains visible, but its link ${unsafeUrl} and token ${canary} must not be shared.`,
      topic: `Policy evidence from ${canary}`,
      sourceIds: ["missing_source_binding"],
      snippetIds: [],
      metadata: {
        sourceTitle: unsafeTitle,
        rationale:
          `This still supports the comparison, subject to the private source ${canary}.`,
        qualifiers: [
          `Useful context remains, while ${unsafeUrl} stays private.`
        ]
      }
    });
    rawPayload.graph.nodes.push({
      id: "unbound_private_reference",
      kind: "gap",
      title: `Unbound but useful context from ${unsafeTitle}`,
      summary:
        `The useful unbound explanation remains, but ${unsafeUrl} and ${canary} must not leak.`,
      topic: `Unbound context ${canary}`,
      sourceIds: [],
      snippetIds: [],
      metadata: {
        sourceTitle: unsafeTitle,
        rationale:
          `Useful unbound rationale with filename ${fileNameCanary} and ${canary}.`,
        qualifiers: [
          `Useful unbound qualifier from query name ${queryNameCanary} and ${unsafeUrl}.`
        ]
      }
    });
    rawPayload.snippets[0]!.text =
      `Useful evidence excerpt with a private reference ${canary}.`;
    rawPayload.snippets[0]!.rationale =
      `Supports the public comparison without exposing ${canary}.`;
    rawPayload.snippets[0]!.locationLabel =
      `Private appendix ${canary}`;
    rawPayload.graph.disagreementClusters[0]!.title =
      `Useful policy tension from ${canary}`;
    rawPayload.graph.disagreementClusters[0]!.explanation =
      `The substantive comparison remains useful even though ${unsafeUrl} is withheld.`;

    const payload = sanitizeWorkspaceGraphPayloadForPublic(rawPayload);
    const serialized = JSON.stringify(payload);
    const evidence = payload.graph.nodes.find(
      (node) => node.id === "evidence_private_source"
    );
    const unboundNode = payload.graph.nodes.find(
      (node) => node.id === "unbound_private_reference"
    );

    expect(payload.sources[0]).toMatchObject({
      title: "Source link withheld",
      url: undefined,
      domain: undefined,
      fileName: undefined,
      publishedAt: undefined
    });
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain(unsafeUrl);
    expect(serialized).not.toContain(unsafeTitle);
    expect(serialized).not.toContain("files.example.com");
    expect(serialized).not.toContain(fileNameCanary);
    expect(serialized).not.toContain(queryNameCanary);
    expect(serialized).not.toContain(rawQueryNameCanary);
    expect(serialized).not.toContain(pathSegmentCanary);
    expect(serialized).not.toContain(publishedAtCanary);
    expect(evidence?.title).toContain("Evidence summarized from");
    expect(evidence?.summary).toContain("useful policy comparison remains visible");
    expect(evidence?.metadata?.sourceTitle).toBe("Source link withheld");
    expect(evidence?.metadata?.rationale).toContain(
      "This still supports the comparison"
    );
    expect(payload.workspace.question).toContain("useful policy comparison");
    expect(payload.graph.question).toContain("useful policy comparison");
    expect(payload.graph.graphSummary).toContain(
      "useful overview remains visible"
    );
    expect(unboundNode?.title).toContain("Unbound but useful context");
    expect(unboundNode?.summary).toContain(
      "useful unbound explanation remains"
    );
    expect(unboundNode?.metadata?.rationale).toContain(
      "Useful unbound rationale"
    );
    expect(payload.snippets[0]?.rationale).toContain(
      "Supports the public comparison"
    );
    expect(payload.graph.disagreementClusters[0]?.explanation).toContain(
      "substantive comparison remains useful"
    );
  });

  it("keeps ordinary public query links but removes fragments", () => {
    const rawPayload = buildPayload();
    rawPayload.sources[0]!.url =
      "https://example.com/research?id=123#private-navigation-state";

    const payload = sanitizeWorkspaceGraphPayloadForPublic(rawPayload);

    expect(payload.sources[0]?.url).toBe(
      "https://example.com/research?id=123"
    );
  });
});
