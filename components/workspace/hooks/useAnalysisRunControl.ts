"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceGraphPayload } from "@/types/claimgraph";
import type { DeletedWorkspaceState } from "./useWorkspaceGraphPayload";
import type { RunStatus } from "@/types/claimgraph";

const ACTIVE_RUN_STATUSES = [
  "queued",
  "ingesting",
  "gathering",
  "extracting",
  "assembling"
] as const;

function isActiveRunStatus(status: RunStatus): status is
  | "queued"
  | "ingesting"
  | "gathering"
  | "extracting"
  | "assembling" {
  return ACTIVE_RUN_STATUSES.includes(
    status as (typeof ACTIVE_RUN_STATUSES)[number]
  );
}

async function readErrorMessage(response: Response, fallback: string) {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error ?? fallback;
  } catch {
    return fallback;
  }
}

export function useAnalysisRunControl(input: {
  workspaceId: string;
  payload: WorkspaceGraphPayload | null;
  deletedWorkspace: DeletedWorkspaceState | null;
  loadGraph: () => Promise<void>;
  setError: (error: string | null) => void;
}) {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isCanceling, setIsCanceling] = useState(false);
  const analysisStartedRef = useRef(false);
  const analysisIdempotencyKeyRef = useRef<string | null>(null);

  const { workspaceId, payload, deletedWorkspace, loadGraph, setError } = input;

  useEffect(() => {
    analysisStartedRef.current = false;
  }, [workspaceId]);

  const runAnalysis = useCallback(async () => {
    if (
      workspaceId === "demo" ||
      payload?.canWrite === false ||
      isAnalyzing ||
      isCanceling
    ) {
      return;
    }

    setError(null);
    setIsAnalyzing(true);
    let pollHandle: number | undefined;

    try {
      const idempotencyKey =
        analysisIdempotencyKeyRef.current ?? crypto.randomUUID();
      analysisIdempotencyKeyRef.current = idempotencyKey;
      const analyzePromise = fetch(`/api/workspaces/${workspaceId}/analyze`, {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey
        }
      });

      pollHandle = window.setInterval(() => {
        void loadGraph();
      }, 1000);

      const response = await analyzePromise;

      if (!response.ok) {
        throw new Error(
          await readErrorMessage(response, "Failed to run analysis.")
        );
      }

      analysisIdempotencyKeyRef.current = null;
    } catch (analysisError) {
      setError(
        analysisError instanceof Error
          ? analysisError.message
          : "Unable to run analysis."
      );
    } finally {
      if (pollHandle !== undefined) {
        window.clearInterval(pollHandle);
      }

      await loadGraph();
      setIsAnalyzing(false);
    }
  }, [isAnalyzing, isCanceling, loadGraph, payload?.canWrite, setError, workspaceId]);

  const cancelAnalysis = useCallback(async () => {
    const runId = payload?.activeRun?.id;

    if (!runId || isCanceling) {
      return;
    }

    setError(null);
    setIsCanceling(true);

    try {
      const response = await fetch(`/api/runs/${runId}`, {
        method: "DELETE"
      });

      if (!response.ok) {
        throw new Error(
          await readErrorMessage(response, "Failed to cancel analysis.")
        );
      }
    } catch (cancelError) {
      setError(
        cancelError instanceof Error
          ? cancelError.message
          : "Unable to cancel analysis."
      );
    } finally {
      await loadGraph();
      setIsCanceling(false);
      setIsAnalyzing(false);
    }
  }, [isCanceling, loadGraph, payload?.activeRun?.id, setError, workspaceId]);

  useEffect(() => {
    if (
      !payload ||
      payload.canWrite === false ||
      workspaceId === "demo" ||
      deletedWorkspace
    ) {
      return;
    }

    if (!payload.latestRun && !analysisStartedRef.current) {
      analysisStartedRef.current = true;
      void runAnalysis();
      return;
    }

    if (payload.activeRun && isActiveRunStatus(payload.activeRun.status)) {
      const timeoutHandle = window.setTimeout(() => {
        void loadGraph();
      }, 1000);

      return () => window.clearTimeout(timeoutHandle);
    }
  }, [deletedWorkspace, loadGraph, payload, runAnalysis, workspaceId]);

  return {
    isAnalyzing,
    isCanceling,
    runAnalysis,
    cancelAnalysis
  };
}
