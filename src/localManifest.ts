import { LocalFileMeta, LocalSyncManifest, RemoteFileMeta, SyncIndexEntry, SyncRecord } from "./types";

export function createLocalManifest(deviceId: string): LocalSyncManifest {
  return {
    version: 1,
    deviceId,
    updatedAt: Date.now(),
    records: {}
  };
}

export function manifestFromIndex(index: Record<string, SyncIndexEntry>, deviceId: string): LocalSyncManifest {
  const manifest = createLocalManifest(deviceId);
  for (const entry of Object.values(index)) {
    manifest.records[entry.path] = {
      path: entry.path,
      fileId: entry.lastSyncedRemoteId,
      lastKnownRemoteHash: entry.deleted ? null : entry.lastSyncedHash,
      lastKnownLocalHash: entry.deleted ? null : entry.lastSyncedHash,
      lastSyncTime: entry.lastSyncedAt,
      lastRemoteModified: null,
      lastLocalModified: null,
      deleted: entry.deleted === true,
      deviceId
    };
  }
  return manifest;
}

export function updateRecordFromSync(
  records: Record<string, SyncRecord>,
  path: string,
  local: LocalFileMeta | undefined,
  remote: RemoteFileMeta | undefined,
  deviceId: string,
  deleted = false
): void {
  records[path] = {
    path,
    fileId: remote?.driveFileId ?? records[path]?.fileId,
    lastKnownRemoteHash: deleted ? null : remote?.hash ?? local?.hash ?? records[path]?.lastKnownRemoteHash ?? null,
    lastKnownLocalHash: deleted ? null : local?.hash ?? remote?.hash ?? records[path]?.lastKnownLocalHash ?? null,
    lastSyncTime: Date.now(),
    lastRemoteModified: remote?.mtime ?? remote?.updatedAt ?? records[path]?.lastRemoteModified ?? null,
    lastLocalModified: local?.mtime ?? records[path]?.lastLocalModified ?? null,
    deleted,
    deviceId
  };
}
