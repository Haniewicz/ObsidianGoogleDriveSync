export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

export type GoogleDriveSyncSettings = {
  clientId: string;
  clientSecret: string;
  deviceName: string;
  conflictPolicy: ConflictPolicy;
  remoteFolderName: string;
  autoSyncEnabled: boolean;
  fullSyncFallbackEnabled: boolean;
  syncOnStartup: boolean;
  syncIntervalMinutes: number;
  cloudWatchEnabled: boolean;
  cloudWatchIntervalSeconds: number;
  syncDebounceSeconds: number;
  requestConcurrency: number;
  maxDeletionPercent: number;
  ignoredPaths: string;
  debugMode: boolean;
  backupEnabled: boolean;
  maxBackups: number;
};

export type StoredAuth = {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope?: string;
  token_type?: string;
};

export type ConflictPolicy = "keep-both" | "prefer-local" | "prefer-remote";
export type InitialSyncDirection = "cloud-to-local" | "local-to-cloud";

export type SyncStatusState = "disconnected" | "idle" | "syncing" | "error";

export type SyncSummary = {
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  uploads: number;
  downloads: number;
  localDeletes: number;
  remoteDeletes: number;
  conflicts: number;
  errors: number;
  command?: string;
};

export type SyncStatus = {
  state: SyncStatusState;
  lastStartedAt?: number;
  lastFinishedAt?: number;
  lastDurationMs?: number;
  lastError?: string;
  lastSummary?: SyncSummary;
};

export type SyncIndexEntry = {
  path: string;
  lastSyncedHash: string;
  lastSyncedRemoteId?: string;
  lastSyncedRemoteRevision?: string;
  lastSyncedAt: number;
  baseSnapshot?: string;
  baseSnapshotHash?: string;
  deleted?: boolean;
};

export type RemoteManifest = {
  version: 1;
  vaultId: string;
  updatedAt: number;
  files: Record<string, RemoteFileMeta>;
  command?: RemoteSyncCommand;
  snapshots?: RemoteSnapshotMeta[];
  backups?: BackupMeta[];
};

export type RemoteSyncCommand = {
  id: string;
  type: "replace-local-from-cloud";
  createdAt: number;
  createdByDeviceId: string;
  createdByDeviceName: string;
};

export type RemoteSnapshotMeta = {
  id: string;
  name: string;
  fileId: string;
  createdAt: number;
  createdByDeviceId: string;
  createdByDeviceName: string;
};

export type BackupFileEntry = {
  driveFileId: string;
  hash: string;
  size: number;
  mtime?: number;
};

export type BackupFileSource = BackupFileEntry & {
  content: string | ArrayBuffer;
  mimeType: string;
};

export type BackupMeta = {
  id: string;
  fileId: string;
  folderId?: string;
  name: string;
  createdAt: number;
  deviceName: string;
  changedCount: number;
  deletedCount: number;
};

export type BackupData = {
  v: 1;
  id: string;
  createdAt: number;
  deviceName: string;
  /** Only files whose hash changed compared to the previous backup / last known state */
  changedFiles: Record<string, BackupFileEntry>;
  /** Paths that were deleted in this sync */
  deletedPaths: string[];
};

export type RemoteFileMeta = {
  path: string;
  driveFileId: string;
  hash: string;
  size: number;
  mtime?: number;
  revision?: string;
  deleted: boolean;
  updatedAt: number;
  deletedAt?: number;
};

export type PluginData = {
  auth?: StoredAuth;
  index?: Record<string, SyncIndexEntry>;
  vaultId?: string;
  deviceId?: string;
  appliedCommandIds?: string[];
  initialSyncCompleted?: boolean;
  syncStatus?: SyncStatus;
  lastRemoteUpdatedAt?: number;
  lastRemoteCommandId?: string;
};

export type StoredPluginData = PluginData & {
  settings?: Partial<GoogleDriveSyncSettings>;
};

export type LocalFileMeta = {
  path: string;
  hash: string;
  size: number;
  extension: string;
  mtime?: number;
  isText: boolean;
};

export type RemoteState = {
  rootFolderId: string;
  filesFolderId: string;
  manifestFileId?: string;
  manifest: RemoteManifest;
};

export type PlannedDeletion = {
  path: string;
  direction: "local" | "remote";
};

export function defaultIgnoredPaths(configDir: string): string {
  const normalizedConfigDir = configDir.replace(/\/+$/, "");
  return [
    `${normalizedConfigDir}/plugins/google-drive-vault-sync/`,
    `${normalizedConfigDir}/workspace.json`,
    `${normalizedConfigDir}/workspace-mobile.json`,
    `${normalizedConfigDir}/cache/`,
    ".trash/"
  ].join("\n");
}

export const DEFAULT_SETTINGS: GoogleDriveSyncSettings = {
  clientId: "",
  clientSecret: "",
  deviceName: "",
  conflictPolicy: "keep-both",
  remoteFolderName: "ObsidianGoogleDriveSync",
  autoSyncEnabled: true,
  fullSyncFallbackEnabled: true,
  syncOnStartup: true,
  syncIntervalMinutes: 30,
  cloudWatchEnabled: true,
  cloudWatchIntervalSeconds: 30,
  syncDebounceSeconds: 2,
  requestConcurrency: 2,
  maxDeletionPercent: 20,
  ignoredPaths: "",
  debugMode: false,
  backupEnabled: true,
  maxBackups: 10
};
