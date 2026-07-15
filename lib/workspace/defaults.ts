import { getDefaultWorkspaceSettingsForMode } from "@/lib/claimgraph/config";
import type { ClaimGraphMode, WorkspaceSettings } from "@/types/claimgraph";

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings =
  getDefaultWorkspaceSettingsForMode("full");

export function getWorkspaceDefaults(mode: ClaimGraphMode) {
  return getDefaultWorkspaceSettingsForMode(mode);
}
