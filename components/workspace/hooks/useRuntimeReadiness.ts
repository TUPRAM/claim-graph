"use client";

import { useCallback, useEffect, useState } from "react";
import type { RuntimeReadinessSummary } from "@/types/claimgraph";

export function useRuntimeReadiness() {
  const [summary, setSummary] = useState<RuntimeReadinessSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadReadiness = useCallback(async () => {
    setError(null);

    try {
      const response = await fetch("/api/runtime/readiness", {
        cache: "no-store"
      });

      if (!response.ok) {
        throw new Error("Failed to load runtime readiness.");
      }

      const payload = (await response.json()) as RuntimeReadinessSummary;
      setSummary(payload);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load runtime readiness."
      );
    }
  }, []);

  useEffect(() => {
    void loadReadiness();
  }, [loadReadiness]);

  return {
    summary,
    error,
    reload: loadReadiness
  };
}
