import { existsSync, mkdirSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import path from "node:path";

export function getClaimGraphDataDir() {
  return process.env.CLAIMGRAPH_DATA_DIR?.trim()
    ? process.env.CLAIMGRAPH_DATA_DIR
    : path.join(process.cwd(), "runtime_data");
}

export function ensureClaimGraphDataDir() {
  const directory = getClaimGraphDataDir();
  mkdirSync(directory, { recursive: true });
  return directory;
}

export function getLegacyStoreFilePath() {
  return path.join(ensureClaimGraphDataDir(), "claimgraph-store.json");
}

export function getStoreFilePath() {
  return getLegacyStoreFilePath();
}

export function getStoreDatabasePath() {
  return path.join(ensureClaimGraphDataDir(), "claimgraph-store.sqlite");
}

export function getStoreDatabaseBackupsDir() {
  const directory = path.join(ensureClaimGraphDataDir(), "db_backups");
  mkdirSync(directory, { recursive: true });
  return directory;
}

export function getStoreDatabaseBackupPath(fileName: string) {
  return path.join(getStoreDatabaseBackupsDir(), fileName);
}

export function getWorkspaceUploadsDir(workspaceId: string) {
  const directory = getWorkspaceUploadsRoot(workspaceId);
  mkdirSync(directory, { recursive: true });
  return directory;
}

export function getWorkspaceUploadsRoot(workspaceId: string) {
  return path.join(ensureClaimGraphDataDir(), "uploads", workspaceId);
}

export function getWorkspaceUploadFilePath(workspaceId: string, storedName: string) {
  return path.join(getWorkspaceUploadsDir(workspaceId), storedName);
}

export function getWorkspaceExportsDir(workspaceId: string) {
  const directory = path.join(ensureClaimGraphDataDir(), "exports", workspaceId);
  mkdirSync(directory, { recursive: true });
  return directory;
}

export function getWorkspaceExportFilePath(workspaceId: string, storedName: string) {
  return path.join(getWorkspaceExportsDir(workspaceId), storedName);
}

export function getWorkspaceExportsRoot(workspaceId: string) {
  return path.join(ensureClaimGraphDataDir(), "exports", workspaceId);
}

export function deleteWorkspaceUploadFile(workspaceId: string, storedName: string) {
  const filePath = path.join(getWorkspaceUploadsRoot(workspaceId), storedName);

  if (existsSync(filePath)) {
    unlinkSync(filePath);
    return true;
  }

  return false;
}

export function deleteWorkspaceUploadsDir(workspaceId: string) {
  const directory = getWorkspaceUploadsRoot(workspaceId);

  if (existsSync(directory)) {
    rmSync(directory, { recursive: true, force: true });
    return true;
  }

  return false;
}

export function deleteWorkspaceExportFile(workspaceId: string, storedName: string) {
  const filePath = path.join(getWorkspaceExportsRoot(workspaceId), path.basename(storedName));

  if (existsSync(filePath)) {
    unlinkSync(filePath);
    return true;
  }

  return false;
}

export function deleteWorkspaceExportsDir(workspaceId: string) {
  const directory = getWorkspaceExportsRoot(workspaceId);

  if (existsSync(directory)) {
    rmSync(directory, { recursive: true, force: true });
    return true;
  }

  return false;
}

export function removeWorkspaceUploadsDirIfEmpty(workspaceId: string) {
  const directory = getWorkspaceUploadsRoot(workspaceId);

  if (!existsSync(directory)) {
    return false;
  }

  if (readdirSync(directory).length > 0) {
    return false;
  }

  rmSync(directory, { recursive: true, force: true });
  return true;
}
