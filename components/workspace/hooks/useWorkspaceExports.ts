"use client";

import { useCallback, useRef, useState, type RefObject } from "react";
import { exportElementToPng } from "@/lib/export/client-png";
import type { NodeKind, ReviewBranchFilter } from "@/types/claimgraph";

export interface WorkspaceExportNotice {
  tone: "info" | "error";
  text: string;
}

export function useWorkspaceExports(input: {
  workspaceId: string;
  canvasRef: RefObject<HTMLDivElement | null>;
  strongestOnly: boolean;
  unresolvedOnly: boolean;
  focusClusterId?: string | null;
  hiddenKinds: NodeKind[];
  selectedNodeId?: string | null;
  savedReviewStateId?: string | null;
  savedReviewStateLabel?: string | null;
  reviewBranchFilter: ReviewBranchFilter;
  reviewSourceFilterId?: string | null;
  reviewSourceFilterLabel?: string | null;
}) {
  const markdownIdempotencyRef = useRef<{
    key: string;
    fingerprint: string;
  } | null>(null);
  const pngIdempotencyRef = useRef<{
    key: string;
    fingerprint: string;
  } | null>(null);
  const [notice, setNotice] = useState<WorkspaceExportNotice | null>(null);
  const [isExportingMarkdown, setIsExportingMarkdown] = useState(false);
  const [isExportingPng, setIsExportingPng] = useState(false);
  const {
    workspaceId,
    canvasRef,
    strongestOnly,
    unresolvedOnly,
    focusClusterId,
    hiddenKinds,
    selectedNodeId,
    savedReviewStateId,
    savedReviewStateLabel,
    reviewBranchFilter,
    reviewSourceFilterId,
    reviewSourceFilterLabel
  } = input;

  const buildExportObservabilityPayload = useCallback((extra?: {
    success?: boolean;
    errorMessage?: string;
    pngDataUrl?: string;
  }) => {
    const viewport = canvasRef.current?.getBoundingClientRect();

    return {
      strongestOnly,
      unresolvedOnly,
      focusClusterId: focusClusterId ?? null,
      hiddenKinds,
      selectedNodeId: selectedNodeId ?? null,
      savedReviewStateId: savedReviewStateId ?? null,
      savedReviewStateLabel: savedReviewStateLabel ?? null,
      reviewBranchFilter,
      reviewSourceFilterId: reviewSourceFilterId ?? null,
      reviewSourceFilterLabel: reviewSourceFilterLabel ?? null,
      ...(viewport
        ? {
            viewport: {
              width: Math.round(viewport.width),
              height: Math.round(viewport.height)
            }
          }
        : {}),
      ...(typeof extra?.success === "boolean" ? { success: extra.success } : {}),
      ...(extra?.errorMessage ? { errorMessage: extra.errorMessage } : {}),
      ...(extra?.pngDataUrl ? { pngDataUrl: extra.pngDataUrl } : {})
    };
  }, [
    canvasRef,
    focusClusterId,
    hiddenKinds,
    reviewBranchFilter,
    reviewSourceFilterId,
    reviewSourceFilterLabel,
    savedReviewStateId,
    savedReviewStateLabel,
    selectedNodeId,
    strongestOnly,
    unresolvedOnly
  ]);

  const logPngExport = useCallback(async (extra: {
    success: boolean;
    errorMessage?: string;
    pngDataUrl?: string;
  }) => {
    const payload = buildExportObservabilityPayload(extra);
    const body = JSON.stringify(payload);
    const fingerprintBytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(body)
    );
    const fingerprint = Array.from(new Uint8Array(fingerprintBytes), (value) =>
      value.toString(16).padStart(2, "0")
    ).join("");
    const pending = pngIdempotencyRef.current;
    const idempotencyKey =
      pending?.fingerprint === fingerprint ? pending.key : crypto.randomUUID();
    pngIdempotencyRef.current = { key: idempotencyKey, fingerprint };

    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/export/png`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey
        },
        body
      });

      const idempotencyStatus = response.headers.get("idempotency-status");

      if (
        response.ok ||
        idempotencyStatus === "conflict" ||
        (response.status < 500 && idempotencyStatus !== "in-flight")
      ) {
        pngIdempotencyRef.current = null;
      }
    } catch {
      // Export logging is best-effort and should not block downloads.
    }
  }, [
    buildExportObservabilityPayload,
    workspaceId
  ]);

  const exportMarkdown = useCallback(async () => {
    setIsExportingMarkdown(true);
    setNotice(null);

    try {
      const observabilityPayload = buildExportObservabilityPayload();
      const fingerprint = JSON.stringify(observabilityPayload);
      const pending = markdownIdempotencyRef.current;
      const idempotencyKey =
        pending?.fingerprint === fingerprint
          ? pending.key
          : crypto.randomUUID();
      markdownIdempotencyRef.current = { key: idempotencyKey, fingerprint };
      const response = await fetch(`/api/workspaces/${workspaceId}/export/markdown`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey
        },
        body: fingerprint
      });

      if (!response.ok) {
        const idempotencyStatus = response.headers.get("idempotency-status");
        if (
          idempotencyStatus === "conflict" ||
          (response.status < 500 && idempotencyStatus !== "in-flight")
        ) {
          markdownIdempotencyRef.current = null;
        }
        throw new Error("Failed to export markdown.");
      }

      const markdown = await response.text();
      markdownIdempotencyRef.current = null;
      const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `claimgraph-${workspaceId}.md`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (exportError) {
      setNotice({
        tone: "error",
        text: exportError instanceof Error ? exportError.message : "Export failed."
      });
    } finally {
      setIsExportingMarkdown(false);
    }
  }, [buildExportObservabilityPayload, workspaceId]);

  const exportPng = useCallback(async () => {
    setIsExportingPng(true);
    setNotice(null);

    try {
      if (!canvasRef.current) {
        throw new Error("The graph canvas is not ready for PNG export.");
      }

      const pngDataUrl = await exportElementToPng({
        element: canvasRef.current,
        filename: `claimgraph-${workspaceId}.png`
      });
      await logPngExport({ success: true, pngDataUrl });
    } catch (exportError) {
      const message =
        exportError instanceof Error ? exportError.message : "Failed to export PNG.";
      await logPngExport({
        success: false,
        errorMessage: message
      });
      setNotice({
        tone: "error",
        text: message
      });
    } finally {
      setIsExportingPng(false);
    }
  }, [canvasRef, logPngExport, workspaceId]);

  return {
    notice,
    isExportingMarkdown,
    isExportingPng,
    exportMarkdown,
    exportPng
  };
}
