import * as sqliteStore from "@/lib/server/store";
import type { ClaimGraphStore } from "@/lib/server/storage/claimgraph-store";

export const localClaimGraphStore: ClaimGraphStore = {
  async createWorkspace(question, settings, sourceUrls = [], options) {
    return sqliteStore.createWorkspace(question, settings, sourceUrls, options);
  },
  async getWorkspace(workspaceId) {
    return sqliteStore.getWorkspace(workspaceId);
  },
  async listWorkspaces(limit) {
    return sqliteStore.listWorkspaces(limit);
  },
  async deleteWorkspace(workspaceId) {
    return sqliteStore.deleteWorkspace(workspaceId);
  },
  async deleteWorkspaceIfNoActiveRun(workspaceId) {
    return sqliteStore.deleteWorkspaceIfNoActiveRun(workspaceId);
  },
  async matchesWorkspaceWriteCapability(workspaceId, writeCapabilityHash) {
    return sqliteStore.matchesWorkspaceWriteCapability(
      workspaceId,
      writeCapabilityHash
    );
  },
  async createRun(workspaceId, options) {
    return sqliteStore.createRun(workspaceId, options);
  },
  async acquireActiveRun(workspaceId, options) {
    return sqliteStore.acquireActiveRun(workspaceId, options);
  },
  async getRun(runId) {
    return sqliteStore.getRun(runId);
  },
  async getLatestRunForWorkspace(workspaceId) {
    return sqliteStore.getLatestRunForWorkspace(workspaceId);
  },
  async getActiveRunForWorkspace(workspaceId) {
    return sqliteStore.getActiveRunForWorkspace(workspaceId);
  },
  async listRunsByStatuses(statuses) {
    return sqliteStore.listRunsByStatuses(statuses);
  },
  async updateRunStatus(runId, status, statusMessage) {
    return sqliteStore.updateRunStatus(runId, status, statusMessage);
  },
  async transitionRunStatus(runId, input) {
    return sqliteStore.transitionRunStatus(runId, input);
  },
  async recordRunHeartbeat(runId, input) {
    return sqliteStore.heartbeatRunExecution(runId, input);
  },
  async recordRunWorkflowDispatch(runId, input) {
    return sqliteStore.recordRunWorkflowDispatch(runId, input);
  },
  async recordRunStageModel(runId, stage, model) {
    return sqliteStore.recordRunStageModel(runId, stage, model);
  },
  async setRunFallbackReason(runId, fallbackReason) {
    return sqliteStore.setRunFallbackReason(runId, fallbackReason);
  },
  async addWorkspaceFiles(workspaceId, files) {
    return sqliteStore.addWorkspaceFiles(workspaceId, files);
  },
  async addWorkspaceFilesIfNoActiveRun(workspaceId, files) {
    return sqliteStore.addWorkspaceFilesIfNoActiveRun(workspaceId, files);
  },
  async removeWorkspaceFile(workspaceId, fileId) {
    return sqliteStore.removeWorkspaceFile(workspaceId, fileId);
  },
  async removeWorkspaceFileIfNoActiveRun(workspaceId, fileId, options) {
    return sqliteStore.removeWorkspaceFileIfNoActiveRun(
      workspaceId,
      fileId,
      options
    );
  },
  async getWorkspaceFiles(workspaceId) {
    return sqliteStore.getWorkspaceFiles(workspaceId);
  },
  async saveWorkspaceGraph(workspaceId, record) {
    return sqliteStore.saveWorkspaceGraph(workspaceId, record);
  },
  async completeRunWithGraph(runId, workspaceId, record, options) {
    return sqliteStore.completeRunWithGraph(runId, workspaceId, record, options);
  },
  async getWorkspaceGraphForRun(runId) {
    return sqliteStore.getWorkspaceGraphForRun(runId);
  },
  async getWorkspaceGraphPayload(workspaceId) {
    return sqliteStore.getWorkspaceGraphPayload(workspaceId);
  },
  async materializeStarterGraphForWorkspace(workspaceId) {
    return sqliteStore.materializeStarterGraphForWorkspace(workspaceId);
  },
  async saveEvidencePack(record) {
    return sqliteStore.saveEvidencePack(record);
  },
  async saveClaimInventory(record) {
    return sqliteStore.saveClaimInventory(record);
  },
  async getEvidencePackForRun(runId) {
    return sqliteStore.getEvidencePackForRun(runId);
  },
  async getClaimInventoryForRun(runId) {
    return sqliteStore.getClaimInventoryForRun(runId);
  },
  async getLatestEvidencePack(workspaceId) {
    return sqliteStore.getLatestEvidencePack(workspaceId);
  },
  async getLatestClaimInventory(workspaceId) {
    return sqliteStore.getLatestClaimInventory(workspaceId);
  },
  async getWorkspaceAlphaAssessment(workspaceId) {
    return sqliteStore.getWorkspaceAlphaAssessment(workspaceId);
  },
  async saveWorkspaceAlphaAssessment(workspaceId, assessment) {
    return sqliteStore.saveWorkspaceAlphaAssessment(workspaceId, assessment);
  },
  async recordWorkspaceExportEvent(input) {
    return sqliteStore.recordWorkspaceExportEvent(input);
  },
  async recordWorkspaceArtifactsInvalidated(workspaceId, input) {
    return sqliteStore.recordWorkspaceArtifactsInvalidated(workspaceId, input);
  }
};
