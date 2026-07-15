"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  RetrievalCleanupSummary,
  WorkspaceGraphPayload
} from "@/types/claimgraph";

export interface DeletedWorkspaceState {
  workspaceId: string;
  question: string;
  deletedLocalFilesCount: number;
  totalFiles: number;
  cleanup: RetrievalCleanupSummary;
}

export function formatCleanupSummary(cleanup: RetrievalCleanupSummary) {
  if (cleanup.attemptedCount === 0) {
    return "No known remote retrieval artifacts needed cleanup.";
  }

  const parts = [
    `${cleanup.attemptedCount} checked`,
    `${cleanup.deletedCount} deleted`,
    `${cleanup.skippedCount} already missing`
  ];

  if (cleanup.failedCount > 0) {
    parts.push(`${cleanup.failedCount} failed`);
  }

  if (cleanup.pendingCount > 0) {
    parts.push(`${cleanup.pendingCount} pending`);
  }

  return parts.join(" - ");
}

export function useWorkspaceGraphPayload(
  workspaceId: string,
  options?: {
    lane?: "public" | "dev";
  }
) {
  const [payload, setPayload] = useState<WorkspaceGraphPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deletedWorkspace, setDeletedWorkspace] = useState<DeletedWorkspaceState | null>(null);

  const loadGraph = useCallback(async () => {
    if (deletedWorkspace) {
      return;
    }

    setError(null);

    try {
      const endpoint = options?.lane === "dev"
        ? `/api/dev/workspaces/${workspaceId}/graph`
        : `/api/workspaces/${workspaceId}/graph`;
      const response = await fetch(endpoint, {
        cache: "no-store"
      });

      if (!response.ok) {
        throw new Error("Failed to load workspace graph.");
      }

      const nextPayload = (await response.json()) as WorkspaceGraphPayload;
      setPayload(nextPayload);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Unable to load workspace."
      );
    }
  }, [deletedWorkspace, options?.lane, workspaceId]);

  useEffect(() => {
    if (deletedWorkspace) {
      return;
    }

    void loadGraph();
  }, [deletedWorkspace, loadGraph]);

  return {
    payload,
    error,
    setError,
    deletedWorkspace,
    setDeletedWorkspace,
    loadGraph
  };
}
