"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ReviewBranchFilter,
  WorkspaceReviewStateSnapshot,
  WorkspaceSavedReviewState
} from "@/types/claimgraph";

const STORAGE_VERSION = 1;
const STORAGE_KEY_PREFIX = "claimgraph:workspace-review-state";
const MAX_SAVED_REVIEW_STATES = 6;

interface WorkspaceReviewStateStorage {
  version: number;
  current: WorkspaceReviewStateSnapshot | null;
  saved: WorkspaceSavedReviewState[];
}

function normalizeHiddenKinds(hiddenKinds: WorkspaceReviewStateSnapshot["hiddenKinds"]) {
  return [...new Set(hiddenKinds)].sort();
}

function normalizeReviewStateSnapshot(
  snapshot: WorkspaceReviewStateSnapshot
): WorkspaceReviewStateSnapshot {
  return {
    strongestOnly: snapshot.strongestOnly,
    unresolvedOnly: snapshot.unresolvedOnly,
    hiddenKinds: normalizeHiddenKinds(snapshot.hiddenKinds),
    focusClusterId: snapshot.focusClusterId ?? null,
    selectedNodeId: snapshot.selectedNodeId ?? null,
    branchFilter: snapshot.branchFilter,
    sourceFilterId: snapshot.sourceFilterId || "all"
  };
}

export function reviewStatesEqual(
  left: WorkspaceReviewStateSnapshot,
  right: WorkspaceReviewStateSnapshot
) {
  const normalizedLeft = normalizeReviewStateSnapshot(left);
  const normalizedRight = normalizeReviewStateSnapshot(right);

  return normalizedLeft.strongestOnly === normalizedRight.strongestOnly &&
    normalizedLeft.unresolvedOnly === normalizedRight.unresolvedOnly &&
    normalizedLeft.focusClusterId === normalizedRight.focusClusterId &&
    normalizedLeft.selectedNodeId === normalizedRight.selectedNodeId &&
    normalizedLeft.branchFilter === normalizedRight.branchFilter &&
    normalizedLeft.sourceFilterId === normalizedRight.sourceFilterId &&
    normalizedLeft.hiddenKinds.length === normalizedRight.hiddenKinds.length &&
    normalizedLeft.hiddenKinds.every((kind, index) => kind === normalizedRight.hiddenKinds[index]);
}

function buildStorageKey(workspaceId: string) {
  return `${STORAGE_KEY_PREFIX}:${workspaceId}`;
}

function parseSavedReviewState(value: unknown): WorkspaceSavedReviewState | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<WorkspaceSavedReviewState>;

  if (
    typeof candidate.id !== "string" ||
    typeof candidate.label !== "string" ||
    typeof candidate.savedAt !== "string" ||
    typeof candidate.strongestOnly !== "boolean" ||
    typeof candidate.unresolvedOnly !== "boolean" ||
    !Array.isArray(candidate.hiddenKinds) ||
    typeof candidate.sourceFilterId !== "string"
  ) {
    return null;
  }

  return {
    id: candidate.id,
    label: candidate.label,
    savedAt: candidate.savedAt,
    strongestOnly: candidate.strongestOnly,
    unresolvedOnly: candidate.unresolvedOnly,
    hiddenKinds: candidate.hiddenKinds,
    focusClusterId:
      typeof candidate.focusClusterId === "string" || candidate.focusClusterId === null
        ? candidate.focusClusterId
        : null,
    selectedNodeId:
      typeof candidate.selectedNodeId === "string" || candidate.selectedNodeId === null
        ? candidate.selectedNodeId
        : null,
    branchFilter: isReviewBranchFilter(candidate.branchFilter)
      ? candidate.branchFilter
      : "all",
    sourceFilterId: candidate.sourceFilterId || "all"
  };
}

function parseCurrentReviewState(value: unknown): WorkspaceReviewStateSnapshot | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = parseSavedReviewState({
    id: "current",
    label: "current",
    savedAt: new Date(0).toISOString(),
    ...value
  });

  if (!candidate) {
    return null;
  }

  return {
    strongestOnly: candidate.strongestOnly,
    unresolvedOnly: candidate.unresolvedOnly,
    hiddenKinds: candidate.hiddenKinds,
    focusClusterId: candidate.focusClusterId,
    selectedNodeId: candidate.selectedNodeId,
    branchFilter: candidate.branchFilter,
    sourceFilterId: candidate.sourceFilterId
  };
}

function readStoredReviewState(workspaceId: string): WorkspaceReviewStateStorage {
  if (typeof window === "undefined") {
    return {
      version: STORAGE_VERSION,
      current: null,
      saved: []
    };
  }

  try {
    const raw = window.localStorage.getItem(buildStorageKey(workspaceId));

    if (!raw) {
      return {
        version: STORAGE_VERSION,
        current: null,
        saved: []
      };
    }

    const parsed = JSON.parse(raw) as Partial<WorkspaceReviewStateStorage>;
    const saved = Array.isArray(parsed.saved)
      ? parsed.saved
          .map((value) => parseSavedReviewState(value))
          .filter((value): value is WorkspaceSavedReviewState => Boolean(value))
      : [];

    return {
      version: STORAGE_VERSION,
      current: parseCurrentReviewState(parsed.current),
      saved
    };
  } catch {
    return {
      version: STORAGE_VERSION,
      current: null,
      saved: []
    };
  }
}

function writeStoredReviewState(
  workspaceId: string,
  state: WorkspaceReviewStateStorage
) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(buildStorageKey(workspaceId), JSON.stringify(state));
}

function isReviewBranchFilter(value: unknown): value is ReviewBranchFilter {
  return value === "all" || value === "left" || value === "right" || value === "unresolved";
}

function buildBranchLabel(branchFilter: ReviewBranchFilter) {
  switch (branchFilter) {
    case "left":
      return "Claim A";
    case "right":
      return "Claim B";
    case "unresolved":
      return "Unresolved";
    default:
      return null;
  }
}

function buildReviewStateLabel(input: {
  snapshot: WorkspaceReviewStateSnapshot;
  selectedNodeTitle?: string | null;
  focusedClusterTitle?: string | null;
  sourceFilterLabel?: string | null;
  savedCount: number;
}) {
  const base =
    input.selectedNodeTitle?.trim() ||
    input.focusedClusterTitle?.trim() ||
    (input.snapshot.unresolvedOnly
      ? "Unresolved review"
      : input.snapshot.strongestOnly
        ? "Focused disagreement"
        : `Saved review ${input.savedCount + 1}`);
  const qualifiers = [
    buildBranchLabel(input.snapshot.branchFilter),
    input.snapshot.sourceFilterId !== "all" ? input.sourceFilterLabel?.trim() : null
  ].filter(Boolean);
  const label = qualifiers.length ? `${base} / ${qualifiers.join(" / ")}` : base;

  return label.length > 72 ? `${label.slice(0, 69)}...` : label;
}

export function useWorkspaceReviewState(input: {
  workspaceId: string;
  currentState: WorkspaceReviewStateSnapshot;
}) {
  const normalizedCurrentState = useMemo(() => {
    return normalizeReviewStateSnapshot(input.currentState);
  }, [input.currentState]);
  const [savedReviewStates, setSavedReviewStates] = useState<WorkspaceSavedReviewState[]>([]);
  const [pendingRestoredReviewState, setPendingRestoredReviewState] =
    useState<WorkspaceReviewStateSnapshot | null>(null);
  const [isHydrated, setIsHydrated] = useState(false);
  const [canPersistCurrentState, setCanPersistCurrentState] = useState(false);

  useEffect(() => {
    const storedState = readStoredReviewState(input.workspaceId);
    setSavedReviewStates(storedState.saved);
    setPendingRestoredReviewState(storedState.current);
    setCanPersistCurrentState(!storedState.current);
    setIsHydrated(true);
  }, [input.workspaceId]);

  useEffect(() => {
    if (!isHydrated || !canPersistCurrentState) {
      return;
    }

    writeStoredReviewState(input.workspaceId, {
      version: STORAGE_VERSION,
      current: normalizedCurrentState,
      saved: savedReviewStates
    });
  }, [
    canPersistCurrentState,
    input.workspaceId,
    isHydrated,
    normalizedCurrentState,
    savedReviewStates
  ]);

  const matchedSavedReviewState = useMemo(() => {
    return (
      savedReviewStates.find((savedState) => reviewStatesEqual(savedState, normalizedCurrentState)) ??
      null
    );
  }, [normalizedCurrentState, savedReviewStates]);

  const acknowledgeRestoredReviewState = useCallback(() => {
    setPendingRestoredReviewState(null);
    setCanPersistCurrentState(true);
  }, []);

  const saveCurrentReviewState = useCallback((input: {
    selectedNodeTitle?: string | null;
    focusedClusterTitle?: string | null;
    sourceFilterLabel?: string | null;
  }) => {
    let savedStateId: string | null = null;

    setSavedReviewStates((current) => {
      const existing = current.find((savedState) =>
        reviewStatesEqual(savedState, normalizedCurrentState)
      );

      if (existing) {
        savedStateId = existing.id;
        return current;
      }

      const nextState: WorkspaceSavedReviewState = {
        id: crypto.randomUUID(),
        label: buildReviewStateLabel({
          snapshot: normalizedCurrentState,
          selectedNodeTitle: input.selectedNodeTitle,
          focusedClusterTitle: input.focusedClusterTitle,
          sourceFilterLabel: input.sourceFilterLabel,
          savedCount: current.length
        }),
        savedAt: new Date().toISOString(),
        ...normalizedCurrentState
      };

      savedStateId = nextState.id;
      return [nextState, ...current].slice(0, MAX_SAVED_REVIEW_STATES);
    });

    return savedStateId;
  }, [normalizedCurrentState]);

  const deleteSavedReviewState = useCallback((savedStateId: string) => {
    setSavedReviewStates((current) =>
      current.filter((savedState) => savedState.id !== savedStateId)
    );
  }, []);

  return {
    pendingRestoredReviewState,
    acknowledgeRestoredReviewState,
    savedReviewStates,
    matchedSavedReviewState,
    saveCurrentReviewState,
    deleteSavedReviewState
  };
}
