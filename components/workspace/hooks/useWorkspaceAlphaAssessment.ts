"use client";

import { useCallback, useEffect, useState } from "react";
import type { WorkspaceAlphaAssessment } from "@/types/claimgraph";

interface AssessmentResponse {
  assessment: WorkspaceAlphaAssessment | null;
}

export function useWorkspaceAlphaAssessment(workspaceId: string, enabled = true) {
  const [assessment, setAssessment] = useState<WorkspaceAlphaAssessment | null>(null);
  const [isLoading, setIsLoading] = useState(enabled);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadAssessment = useCallback(async () => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }

    setError(null);
    setIsLoading(true);

    try {
      const response = await fetch(`/api/dev/workspaces/${workspaceId}/assessment`, {
        cache: "no-store"
      });

      if (!response.ok) {
        throw new Error("Failed to load alpha assessment.");
      }

      const payload = (await response.json()) as AssessmentResponse;
      setAssessment(payload.assessment);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load alpha assessment."
      );
    } finally {
      setIsLoading(false);
    }
  }, [enabled, workspaceId]);

  useEffect(() => {
    void loadAssessment();
  }, [loadAssessment]);

  const saveAssessment = useCallback(
    async (
      input: Omit<WorkspaceAlphaAssessment, "workspaceId" | "createdAt" | "updatedAt">
    ) => {
      if (!enabled) {
        return null;
      }

      setError(null);
      setNotice(null);
      setIsSaving(true);

      try {
        const response = await fetch(`/api/dev/workspaces/${workspaceId}/assessment`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(input)
        });

        if (!response.ok) {
          throw new Error("Failed to save alpha assessment.");
        }

        const payload = (await response.json()) as AssessmentResponse;
        setAssessment(payload.assessment);
        setNotice("Alpha assessment saved.");
        return payload.assessment;
      } catch (saveError) {
        setError(
          saveError instanceof Error
            ? saveError.message
            : "Failed to save alpha assessment."
        );
        return null;
      } finally {
        setIsSaving(false);
      }
    },
    [enabled, workspaceId]
  );

  return {
    assessment,
    isLoading,
    isSaving,
    error,
    notice,
    reload: loadAssessment,
    saveAssessment
  };
}
