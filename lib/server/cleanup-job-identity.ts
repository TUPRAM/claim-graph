export function getWorkspaceDeletionCleanupJobId(workspaceId: string) {
  return `workspace-delete:${workspaceId}`;
}
