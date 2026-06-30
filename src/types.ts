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
};

export type StoredAuth = {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope?: string;
  token_type?: string;
};

export type ConflictPolicy = "keep-both" | "prefer-local" | "prefer-remote";

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
  ignoredPaths: [
    ".obsidian/plugins/obsidian-google-sync/",
    ".obsidian/workspace.json",
    ".obsidian/workspace-mobile.json",
    ".obsidian/cache/",
    ".trash/"
  ].join("\n"),
  debugMode: false
};
