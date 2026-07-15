import { describe, expect, it } from "vitest";
import { computeDisagreementScore } from "@/lib/graph/score";

describe("computeDisagreementScore", () => {
  it("weights contradiction and evidence balance heavily", () => {
    const low = computeDisagreementScore({
      contradictionStrength: 0.3,
      evidenceBalance: 0.3,
      sourceDiversity: 0.9,
      topicRelevance: 0.9,
      claimConfidenceBalance: 0.4,
      gapPressure: 0.2
    });

    const high = computeDisagreementScore({
      contradictionStrength: 0.9,
      evidenceBalance: 0.9,
      sourceDiversity: 0.6,
      topicRelevance: 0.7,
      claimConfidenceBalance: 0.8,
      gapPressure: 0.7
    });

    expect(high).toBeGreaterThan(low);
  });

  it("lets grounded unresolved dependency pressure lift a more decision-relevant conflict", () => {
    const shallowConflict = computeDisagreementScore({
      contradictionStrength: 0.88,
      evidenceBalance: 0.84,
      sourceDiversity: 0.5,
      topicRelevance: 0.76,
      claimConfidenceBalance: 0.74,
      gapPressure: 0.1
    });

    const conditionedConflict = computeDisagreementScore({
      contradictionStrength: 0.84,
      evidenceBalance: 0.86,
      sourceDiversity: 0.5,
      topicRelevance: 0.82,
      claimConfidenceBalance: 0.94,
      gapPressure: 0.86
    });

    expect(conditionedConflict).toBeGreaterThan(shallowConflict);
  });

  it("penalizes contradiction pairs that are weakly opposed on the actual decision axis", () => {
    const explicitConflict = computeDisagreementScore({
      contradictionStrength: 0.9,
      evidenceBalance: 0.82,
      sourceDiversity: 0.5,
      topicRelevance: 0.86,
      claimConfidenceBalance: 0.78,
      gapPressure: 0.74,
      oppositionClarity: 0.96
    });

    const looseParallelPair = computeDisagreementScore({
      contradictionStrength: 0.94,
      evidenceBalance: 0.82,
      sourceDiversity: 0.5,
      topicRelevance: 0.9,
      claimConfidenceBalance: 0.78,
      gapPressure: 0.74,
      oppositionClarity: 0.22
    });

    expect(explicitConflict).toBeGreaterThan(looseParallelPair);
  });

  it("clamps the output", () => {
    const value = computeDisagreementScore({
      contradictionStrength: 2,
      evidenceBalance: 2,
      sourceDiversity: 2,
      topicRelevance: 2,
      claimConfidenceBalance: 2,
      gapPressure: 2
    });

    expect(value).toBe(1);
  });
});
