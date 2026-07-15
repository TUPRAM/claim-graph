"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  collectFocusNodeIds,
  collectSelectionNodeIds,
  collectVisibleNodeIds,
  collectViewportNodeIds,
  pickSelectedNodeId,
  sortDisagreementClusters
} from "@/lib/graph/transforms";
import type { NodeKind, WorkspaceGraphPayload } from "@/types/claimgraph";

export function useGraphFocusMode(payload: WorkspaceGraphPayload | null) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [strongestOnly, setStrongestOnly] = useState(true);
  const [unresolvedOnly, setUnresolvedOnly] = useState(false);
  const [focusedClusterId, setFocusedClusterId] = useState<string | null>(null);
  const [hiddenKinds, setHiddenKinds] = useState<NodeKind[]>([]);
  const [resetToken, setResetToken] = useState(0);

  const sortedClusters = useMemo(() => {
    return payload ? sortDisagreementClusters(payload.graph) : [];
  }, [payload]);

  useEffect(() => {
    if (!payload) {
      return;
    }

    setSelectedNodeId((current) => {
      if (current && payload.graph.nodes.some((node) => node.id === current)) {
        return current;
      }

      return null;
    });

    setFocusedClusterId((current) => {
      if (current && sortedClusters.some((cluster) => cluster.id === current)) {
        return current;
      }

      return sortedClusters[0]?.id ?? null;
    });
  }, [payload, sortedClusters]);

  const selectedNode = useMemo(() => {
    return payload?.graph.nodes.find((node) => node.id === selectedNodeId) ?? null;
  }, [payload, selectedNodeId]);

  const focusedCluster = useMemo(() => {
    if (!payload) {
      return null;
    }

    return (
      sortedClusters.find((cluster) => cluster.id === focusedClusterId) ??
      sortedClusters[0] ??
      null
    );
  }, [focusedClusterId, payload, sortedClusters]);

  const focusNodeIds = useMemo(() => {
    if (!payload || !strongestOnly) {
      return null;
    }

    return collectFocusNodeIds(payload.graph, focusedCluster?.id ?? null);
  }, [focusedCluster?.id, payload, strongestOnly]);

  const visibleNodeIds = useMemo(() => {
    if (!payload) {
      return null;
    }

    return collectVisibleNodeIds({
      graph: payload.graph,
      hiddenKinds,
      strongestOnly,
      focusClusterId: focusedCluster?.id ?? null,
      unresolvedOnly
    });
  }, [focusedCluster?.id, hiddenKinds, payload, strongestOnly, unresolvedOnly]);

  const selectionNodeIds = useMemo(() => {
    if (!payload || !visibleNodeIds) {
      return null;
    }

    return collectSelectionNodeIds({
      graph: payload.graph,
      visibleNodeIds,
      strongestOnly,
      focusClusterId: focusedCluster?.id ?? null
    });
  }, [focusedCluster?.id, payload, strongestOnly, visibleNodeIds]);

  const viewportNodeIds = useMemo(() => {
    if (!payload || !visibleNodeIds) {
      return null;
    }

    return collectViewportNodeIds({
      graph: payload.graph,
      visibleNodeIds,
      strongestOnly,
      focusClusterId: focusedCluster?.id ?? null,
      unresolvedOnly
    });
  }, [focusedCluster?.id, payload, strongestOnly, unresolvedOnly, visibleNodeIds]);

  const viewportKey = useMemo(() => {
    if (viewportNodeIds?.size) {
      return [...viewportNodeIds].sort().join("|");
    }

    return strongestOnly ? focusedCluster?.id ?? "strongest" : "all";
  }, [focusedCluster?.id, strongestOnly, viewportNodeIds]);

  const hasGapNodes = payload?.graph.nodes.some((node) => node.kind === "gap") ?? false;

  useEffect(() => {
    if (!payload || !selectionNodeIds || !selectedNodeId) {
      return;
    }

    const nextSelectedNodeId = pickSelectedNodeId({
      graph: payload.graph,
      currentSelectedNodeId: selectedNodeId,
      selectionNodeIds,
      strongestOnly,
      focusClusterId: focusedCluster?.id ?? null,
      unresolvedOnly
    });

    if (nextSelectedNodeId !== selectedNodeId) {
      setSelectedNodeId(nextSelectedNodeId);
    }
  }, [
    focusedCluster?.id,
    payload,
    selectedNodeId,
    selectionNodeIds,
    strongestOnly,
    unresolvedOnly
  ]);

  useEffect(() => {
    if (!hasGapNodes && unresolvedOnly) {
      setUnresolvedOnly(false);
    }
  }, [hasGapNodes, unresolvedOnly]);

  const toggleKind = useCallback((kind: NodeKind) => {
    setHiddenKinds((current) =>
      current.includes(kind)
        ? current.filter((item) => item !== kind)
        : [...current, kind]
    );
  }, []);

  const cycleCluster = useCallback((direction: "previous" | "next") => {
    if (!sortedClusters.length) {
      return;
    }

    const currentIndex = focusedCluster
      ? sortedClusters.findIndex((cluster) => cluster.id === focusedCluster.id)
      : 0;
    const nextIndex =
      direction === "next"
        ? (Math.max(0, currentIndex) + 1) % sortedClusters.length
        : (Math.max(0, currentIndex) - 1 + sortedClusters.length) % sortedClusters.length;

    setFocusedClusterId(sortedClusters[nextIndex]?.id ?? null);
  }, [focusedCluster, sortedClusters]);

  const resetView = useCallback(() => {
    setResetToken((value) => value + 1);
  }, []);

  return {
    selectedNodeId,
    setSelectedNodeId,
    selectedNode,
    strongestOnly,
    setStrongestOnly,
    unresolvedOnly,
    setUnresolvedOnly,
    hiddenKinds,
    setHiddenKinds,
    toggleKind,
    focusedCluster,
    focusedClusterId,
    setFocusedClusterId,
    sortedClusters,
    focusNodeIds,
    visibleNodeIds,
    viewportNodeIds,
    viewportKey,
    resetToken,
    resetView,
    cycleCluster,
    hasGapNodes
  };
}
