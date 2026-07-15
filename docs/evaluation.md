# Evaluation guide

ClaimGraph quality is judged by whether a reader can inspect the structure and
provenance of a disagreement, not by how polished a summary sounds.

## Core dimensions

| Dimension | Review question |
| --- | --- |
| Evidence relevance | Does the evidence materially address the question? |
| Claim atomicity | Does each claim make one inspectable proposition? |
| Counterclaim quality | Are opposing positions genuinely opposed and explicit? |
| Provenance | Can every substantive node be traced to exact snippets and sources? |
| Gap quality | Do gaps identify consequential missing evidence or assumptions? |
| Readability | Can the graph's main structure be understood quickly? |
| Disagreement focus | Does the highlighted conflict represent a central tradeoff? |

## Hard trust gates

A graph should not be treated as review-ready when any of these conditions
hold:

- a non-question node has no provenance;
- an edge references a missing node;
- the graph exceeds its readability limit without pruning;
- a sample fallback is presented as a completed source-backed run;
- confidence is described as truth;
- source or snippet identity is inconsistent with the displayed graph run;
- a public response contains protected diagnostic fields;
- a canceled or superseded run publishes artifacts.

## Manual review

For a representative question:

1. Read only the graph and identify the main positions.
2. Enable strongest-disagreement focus and confirm the conflict is central.
3. Inspect one claim, one counterclaim, one evidence node, and one gap.
4. Follow every displayed source reference for those nodes.
5. Compare the graph with its Markdown export.
6. Share the URL in a clean browser and confirm the workspace is read-only.
7. Repeat at desktop, tablet, and mobile widths.

## Automated verification

The repository test suite covers graph validation and transforms, provenance,
public schemas, route authorization, lifecycle races, local and hosted storage,
retrieval and upload limits, export rollback, retention cleanup, and workspace
rendering.

Run the full gate with:

```bash
npm run typecheck
npm run test
npm run build
npm run audit:security
```

UI changes should also run `npm run qa:workspace` against the curated demo.
