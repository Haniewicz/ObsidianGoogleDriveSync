import { App, Notice, TFile } from "obsidian";
import { GoogleDriveClient } from "./drive";
import { createLocalManifest, manifestFromIndex, updateRecordFromSync } from "./localManifest";
import { MergeEngine } from "./merge";
import { OfflineSyncQueue } from "./offlineQueue";
import { GoogleDriveProvider } from "./provider";
import { LocalVaultScanner } from "./scanner";
import { BackupFileSource, BackupMode, ConflictPolicy, LocalFile, LocalFileMeta, LocalSyncManifest, PlannedDeletion, RemoteFileMeta, RemoteManifest, RemoteSyncCommand, SyncIndexEntry, SyncQueueItem, SyncSummary } from "./types";
import { byteSize, conflictPath, deletedCopyPath, isLikelyText, sha256Hex, unique, writeVaultFile } from "./utils";
import { LargeDeletionModal, showConflictNotice, showManualConflictModal } from "./modals";

const MAX_SNAPSHOT_BYTES = 1024 * 1024;

export type SyncEngineOptions = {
  app: App;
  scanner: LocalVaultScanner;
  drive: GoogleDriveClient;
  provider: GoogleDriveProvider;
  offlineQueue: OfflineSyncQueue;
  getRemoteFolderName: () => string;
  getVaultId: () => string;
  getIndex: () => Record<string, SyncIndexEntry>;
  setIndex: (index: Record<string, SyncIndexEntry>) => Promise<void>;
  getLocalManifest: () => LocalSyncManifest | undefined;
  setLocalManifest: (manifest: LocalSyncManifest) => Promise<void>;
  getOfflineQueueItems: () => SyncQueueItem[];
  getMaxDeletionPercent: () => number;
  getConflictPolicy: () => ConflictPolicy;
  getDeviceId: () => string;
  getDeviceName: () => string;
  getAppliedCommandIds: () => string[];
  setAppliedCommandIds: (ids: string[]) => Promise<void>;
  getBackupEnabled: () => boolean;
  getBackupMode: () => BackupMode;
  getBackupIntervalMinutes: () => number;
  getMaxBackups: () => number;
};

type SyncCounters = {
  uploads: number;
  downloads: number;
  localDeletes: number;
  remoteDeletes: number;
  conflicts: number;
  errors: number;
};

export class SyncEngine {
  private running = false;
  private mergeEngine = new MergeEngine();

  constructor(private options: SyncEngineOptions) {}

  isRunning(): boolean {
    return this.running;
  }

  async syncNow(manual = false): Promise<SyncSummary | undefined> {
    if (this.running) {
      if (manual) new Notice("Google Drive sync is already running.");
      return;
    }
    this.running = true;
    const startedAt = Date.now();
    const counters: SyncCounters = { uploads: 0, downloads: 0, localDeletes: 0, remoteDeletes: 0, conflicts: 0, errors: 0 };
    const changedPaths: string[] = [];
    const deletedPaths: string[] = [];
    const safetyBackupFiles: Record<string, BackupFileSource> = {};
    const routineBackupFiles: Record<string, BackupFileSource> = {};
    try {
      await this.options.provider.prepare();
      await this.drainOfflineQueue();
      const local = await this.options.scanner.scan();
      const state = this.options.provider.getState();
      const remoteChanges = await this.options.provider.listChanges();
      const commandSummary = await this.applyRemoteCommandIfNeeded(state, local, counters);
      if (commandSummary) return commandSummary;
      const captureRoutineBackups = this.shouldCaptureRoutineBackups(state.manifest);
      const index = { ...this.options.getIndex() };
      const localManifest = this.currentLocalManifest(index);
      const paths = unique([...Object.keys(local), ...remoteChanges.map((change) => change.path), ...Object.keys(index), ...Object.keys(localManifest.records)]);
      const deletionPlan = this.planDeletions(paths, local, state.manifest, index);
      const allowedDeletions = await this.reviewLargeDeletionPlan(deletionPlan, Object.keys(index).length);
      if (allowedDeletions === null) {
        new Notice("Google Drive sync cancelled.");
        return;
      }
      const allowedDeletionKeys = new Set(allowedDeletions.map((item) => `${item.direction}:${item.path}`));

      for (const path of paths) {
        const localMeta = local[path];
        const remoteMeta = state.manifest.files[path];
        const entry = index[path];
        const record = localManifest.records[path];
        const lastLocalHash = record?.lastKnownLocalHash ?? entry?.lastSyncedHash ?? null;
        const lastRemoteHash = record?.lastKnownRemoteHash ?? entry?.lastSyncedHash ?? null;
        const baseHash = lastLocalHash ?? lastRemoteHash ?? null;

        if (localMeta && remoteMeta && !remoteMeta.deleted && localMeta.hash === baseHash && remoteMeta.hash === baseHash) continue;

        if (localMeta && remoteMeta && !remoteMeta.deleted && localMeta.hash !== baseHash && remoteMeta.hash === baseHash) {
          changedPaths.push(path);
          if (captureRoutineBackups) await this.captureRemoteBackup(routineBackupFiles, path, remoteMeta);
          await this.uploadLocal(path, localMeta, state.filesFolderId, state.manifest, index, counters, localManifest);
          continue;
        }

        if (localMeta && remoteMeta && !remoteMeta.deleted && localMeta.hash === baseHash && remoteMeta.hash !== baseHash) {
          changedPaths.push(path);
          await this.captureLocalBackup(safetyBackupFiles, path, localMeta);
          await this.downloadRemote(path, remoteMeta, index, counters, localManifest);
          continue;
        }

        if (localMeta && remoteMeta?.deleted && localMeta.hash === baseHash) {
          if (allowedDeletionKeys.has(`local:${path}`)) {
            deletedPaths.push(path);
            await this.captureLocalBackup(safetyBackupFiles, path, localMeta);
            await this.safeLocalDelete(path, index, counters, localManifest);
          }
          continue;
        }

        if (!localMeta && remoteMeta && !remoteMeta.deleted && remoteMeta.hash === baseHash) {
          if (allowedDeletionKeys.has(`remote:${path}`)) {
            deletedPaths.push(path);
            await this.captureRemoteBackup(safetyBackupFiles, path, remoteMeta);
            await this.tombstoneRemote(path, state.manifest, index, counters, localManifest);
          }
          continue;
        }

        if (!localMeta && remoteMeta?.deleted) {
          index[path] = { ...(entry ?? this.emptyEntry(path)), deleted: true };
          updateRecordFromSync(localManifest.records, path, undefined, remoteMeta, this.options.getDeviceId(), true);
          continue;
        }

        if (!localMeta && remoteMeta && !remoteMeta.deleted) {
          changedPaths.push(path);
          await this.downloadRemote(path, remoteMeta, index, counters, localManifest);
          continue;
        }

        if (localMeta && (!remoteMeta || remoteMeta.deleted) && !entry?.deleted) {
          changedPaths.push(path);
          await this.uploadLocal(path, localMeta, state.filesFolderId, state.manifest, index, counters, localManifest);
          continue;
        }

        if (localMeta && remoteMeta && !remoteMeta.deleted && localMeta.hash !== baseHash && remoteMeta.hash !== baseHash) {
          changedPaths.push(path);
          const resolved = await this.resolveConflict(path, localMeta, remoteMeta, state.filesFolderId, state.manifest, index, counters, safetyBackupFiles, localManifest);
          if (!resolved) counters.conflicts += 1;
        }
      }

      const backupFiles = this.backupFilesForSync(safetyBackupFiles, routineBackupFiles);
      if (this.options.getBackupEnabled() && (Object.keys(backupFiles).length > 0 || deletedPaths.length > 0)) {
        try {
          await this.options.drive.createBackup(state, backupFiles, deletedPaths, this.options.getDeviceId(), this.options.getDeviceName(), this.options.getMaxBackups());
        } catch { /* backup failure must not abort sync */ }
      }
      await this.options.provider.save();
      await this.options.setIndex(index);
      localManifest.updatedAt = Date.now();
      await this.options.setLocalManifest(localManifest);
      showConflictNotice(counters.conflicts);
      if (manual) new Notice("Google Drive sync complete.");
      return this.summary(startedAt, counters);
    } finally {
      this.running = false;
    }
  }

  async resetCloudFromLocal(): Promise<SyncSummary> {
    if (this.running) throw new Error("Google Drive sync is already running.");
    this.running = true;
    const startedAt = Date.now();
    const counters: SyncCounters = { uploads: 0, downloads: 0, localDeletes: 0, remoteDeletes: 0, conflicts: 0, errors: 0 };
    try {
      const local = await this.options.scanner.scan();
      const state = await this.options.drive.loadRemoteState(this.options.getRemoteFolderName(), this.options.getVaultId());
      await this.options.drive.createManifestSnapshot(state, this.options.getDeviceId(), this.options.getDeviceName());
      if (this.options.getBackupEnabled()) {
        try {
          const backupFiles: Record<string, BackupFileSource> = {};
          for (const remote of Object.values(state.manifest.files)) {
            if (!remote.deleted) await this.captureRemoteBackup(backupFiles, remote.path, remote);
          }
          await this.options.drive.createBackup(state, backupFiles, [], this.options.getDeviceId(), this.options.getDeviceName(), this.options.getMaxBackups());
        } catch { /* ignore */ }
      }
      for (const remote of Object.values(state.manifest.files)) {
        if (!remote.deleted) {
          await this.options.drive.trashFile(remote.driveFileId);
          counters.remoteDeletes += 1;
        }
      }
      if (state.manifestFileId) {
        await this.options.drive.trashFile(state.manifestFileId);
        state.manifestFileId = undefined;
      }
      const command = this.createCommand();
      state.manifest = {
        version: 1,
        vaultId: this.options.getVaultId(),
        updatedAt: Date.now(),
        files: {},
        command,
        snapshots: state.manifest.snapshots ?? []
      };
      const index: Record<string, SyncIndexEntry> = {};
      for (const path of Object.keys(local)) {
        await this.uploadLocal(path, local[path], state.filesFolderId, state.manifest, index, counters);
      }
      await this.options.drive.saveManifest(state);
      await this.options.setIndex(index);
      await this.markCommandApplied(command.id);
      new Notice("Google Drive was reset from this vault.");
      return this.summary(startedAt, counters, "reset-cloud-from-local");
    } finally {
      this.running = false;
    }
  }

  async resetLocalFromCloud(keepLocalPaths: string[]): Promise<SyncSummary> {
    if (this.running) throw new Error("Google Drive sync is already running.");
    this.running = true;
    const startedAt = Date.now();
    const counters: SyncCounters = { uploads: 0, downloads: 0, localDeletes: 0, remoteDeletes: 0, conflicts: 0, errors: 0 };
    try {
      const local = await this.options.scanner.scan();
      const state = await this.options.drive.loadRemoteState(this.options.getRemoteFolderName(), this.options.getVaultId());
      if (this.options.getBackupEnabled()) {
        try {
          const backupFiles: Record<string, BackupFileSource> = {};
          for (const [path, meta] of Object.entries(local)) {
            await this.captureLocalBackup(backupFiles, path, meta);
          }
          await this.options.drive.createBackup(state, backupFiles, [], this.options.getDeviceId(), this.options.getDeviceName(), this.options.getMaxBackups());
          await this.options.drive.saveManifest(state); // persist backup metadata before local reset
        } catch { /* ignore */ }
      }
      const keep = new Set(keepLocalPaths);
      const index: Record<string, SyncIndexEntry> = {};
      for (const path of Object.keys(local)) {
        const remote = state.manifest.files[path];
        if (!remote || remote.deleted) {
          if (!keep.has(path)) await this.safeLocalDelete(path, index, counters);
        }
      }
      for (const remote of Object.values(state.manifest.files)) {
        if (!remote.deleted) await this.downloadRemote(remote.path, remote, index, counters);
      }
      const afterDownload = await this.options.scanner.scan();
      for (const path of keep) {
        const meta = afterDownload[path];
        if (meta) await this.uploadLocal(path, meta, state.filesFolderId, state.manifest, index, counters);
      }
      await this.options.drive.saveManifest(state);
      await this.options.setIndex(index);
      new Notice("This vault was reset from Google Drive.");
      return this.summary(startedAt, counters, "reset-local-from-cloud");
    } finally {
      this.running = false;
    }
  }

  async listLocalOnlyPaths(): Promise<string[]> {
    const local = await this.options.scanner.scan();
    const state = await this.options.drive.loadRemoteState(this.options.getRemoteFolderName(), this.options.getVaultId());
    return Object.keys(local).filter((path) => {
      const remote = state.manifest.files[path];
      return !remote || remote.deleted;
    }).sort();
  }

  async createManualBackup(label: string): Promise<void> {
    if (this.running) throw new Error("Google Drive sync is already running.");
    this.running = true;
    try {
      const local = await this.options.scanner.scan();
      const state = await this.options.drive.loadRemoteState(this.options.getRemoteFolderName(), this.options.getVaultId());
      const backupFiles: Record<string, BackupFileSource> = {};
      for (const [path, meta] of Object.entries(local)) {
        await this.captureLocalBackup(backupFiles, path, meta);
      }
      await this.options.drive.createManualBackup(
        state,
        backupFiles,
        label,
        this.options.getDeviceId(),
        this.options.getDeviceName()
      );
      await this.options.drive.saveManifest(state);
    } finally {
      this.running = false;
    }
  }

  async restoreFromBackup(backupFileId: string): Promise<void> {
    if (this.running) throw new Error("Google Drive sync is already running.");
    this.running = true;
    try {
      const data = await this.options.drive.loadBackupData(backupFileId);
      for (const [path, entry] of Object.entries(data.changedFiles)) {
        const content = await this.options.drive.downloadFile(entry.driveFileId);
        await writeVaultFile(this.options.app.vault, path, isLikelyText(path) ? new TextDecoder().decode(content) : content);
      }
      await this.options.setIndex({});
    } finally {
      this.running = false;
    }
  }

  async restoreFileFromBackup(backupFileId: string, path: string): Promise<void> {
    if (this.running) throw new Error("Google Drive sync is already running.");
    this.running = true;
    try {
      const data = await this.options.drive.loadBackupData(backupFileId);
      const entry = data.changedFiles[path];
      if (!entry) throw new Error("This file is not available in the selected backup.");

      const content = await this.options.drive.downloadFile(entry.driveFileId);
      await writeVaultFile(this.options.app.vault, path, isLikelyText(path) ? new TextDecoder().decode(content) : content);
      await this.options.setIndex({});
    } finally {
      this.running = false;
    }
  }

  private backupFilesForSync(
    safetyFiles: Record<string, BackupFileSource>,
    routineFiles: Record<string, BackupFileSource>
  ): Record<string, BackupFileSource> {
    const safetyCount = Object.keys(safetyFiles).length;
    const routineCount = Object.keys(routineFiles).length;
    if (routineCount === 0) return safetyFiles;

    const mode = this.options.getBackupMode();
    if (mode === "safety-only" && safetyCount === 0) return {};
    if (mode === "safety-only") return safetyFiles;
    if (mode === "timed" && safetyCount > 0) return { ...routineFiles, ...safetyFiles };
    return { ...routineFiles, ...safetyFiles };
  }

  private currentLocalManifest(index: Record<string, SyncIndexEntry>): LocalSyncManifest {
    const existing = this.options.getLocalManifest();
    if (existing?.version === 1) {
      return {
        ...existing,
        records: { ...existing.records }
      };
    }
    const migrated = Object.keys(index).length > 0
      ? manifestFromIndex(index, this.options.getDeviceId())
      : createLocalManifest(this.options.getDeviceId());
    return migrated;
  }

  private async drainOfflineQueue(): Promise<void> {
    const items = this.options.offlineQueue.items();
    if (items.length === 0) return;
    for (const item of items) {
      if (item.type === "upload") {
        const localMeta = (await this.options.scanner.scan())[item.path];
        if (!localMeta) {
          await this.options.offlineQueue.remove(item.id);
          continue;
        }
        const content = await this.options.scanner.read(item.path, !localMeta.isText);
        await this.options.provider.upload({ ...localMeta, content });
        await this.options.offlineQueue.remove(item.id);
      } else if (item.type === "delete") {
        await this.options.provider.delete(item.path);
        await this.options.offlineQueue.remove(item.id);
      } else {
        await this.options.offlineQueue.remove(item.id);
      }
    }
  }

  private shouldCaptureRoutineBackups(manifest: RemoteManifest): boolean {
    const mode = this.options.getBackupMode();
    if (mode === "every-sync") return true;
    if (mode === "safety-only") return false;
    const intervalMs = Math.max(1, this.options.getBackupIntervalMinutes()) * 60 * 1000;
    const latestBackupAt = Math.max(0, ...(manifest.backups ?? []).map((backup) => backup.createdAt));
    return latestBackupAt === 0 || Date.now() - latestBackupAt >= intervalMs;
  }

  private async captureLocalBackup(files: Record<string, BackupFileSource>, path: string, meta: LocalFileMeta): Promise<void> {
    if (files[path]) return;
    const file = this.options.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    const isText = meta.isText && isLikelyText(path);
    const content = isText ? await this.options.app.vault.read(file) : await this.options.app.vault.readBinary(file);
    files[path] = {
      driveFileId: "",
      hash: meta.hash,
      size: meta.size,
      mtime: meta.mtime,
      content,
      mimeType: this.mimeTypeFor(path, isText)
    };
  }

  private async captureRemoteBackup(files: Record<string, BackupFileSource>, path: string, meta: RemoteFileMeta): Promise<void> {
    if (files[path]) return;
    const content = await this.options.drive.downloadFile(meta.driveFileId);
    this.captureRemoteBackupContent(files, path, meta, content);
  }

  private captureRemoteBackupContent(files: Record<string, BackupFileSource>, path: string, meta: RemoteFileMeta, content: ArrayBuffer): void {
    if (files[path]) return;
    files[path] = {
      driveFileId: "",
      hash: meta.hash,
      size: meta.size,
      mtime: meta.mtime,
      content,
      mimeType: this.mimeTypeFor(path, isLikelyText(path))
    };
  }

  private async captureConflictBackup(path: string, localMeta: LocalFileMeta, remoteMeta: RemoteFileMeta, remoteData: ArrayBuffer): Promise<void> {
    const stamp = timestampPath(new Date());
    const backupRoot = `.sync/backups/${stamp}/${path}`;
    const entry = this.options.getIndex()[path];
    if (entry?.baseSnapshot !== undefined) {
      await writeVaultFile(this.options.app.vault, `${backupRoot}/base.md`, entry.baseSnapshot);
    }
    const localFile = this.options.app.vault.getAbstractFileByPath(path);
    if (localFile instanceof TFile) {
      const localContent = localMeta.isText ? await this.options.app.vault.read(localFile) : await this.options.app.vault.readBinary(localFile);
      await writeVaultFile(this.options.app.vault, `${backupRoot}/local${localMeta.isText ? ".md" : ".bin"}`, localContent);
    }
    await writeVaultFile(this.options.app.vault, `${backupRoot}/remote${isLikelyText(path) ? ".md" : ".bin"}`, isLikelyText(path) ? new TextDecoder().decode(remoteData) : remoteData);
    await writeVaultFile(
      this.options.app.vault,
      `${backupRoot}/metadata.json`,
      JSON.stringify({
        path,
        remoteDevice: remoteMeta.deviceName ?? remoteMeta.deviceId ?? null,
        remoteModified: remoteMeta.mtime ?? remoteMeta.updatedAt ?? null,
        createdAt: Date.now()
      }, null, 2)
    );
  }

  private mimeTypeFor(path: string, isText: boolean): string {
    if (!isText) return "application/octet-stream";
    if (path.toLowerCase().endsWith(".md")) return "text/markdown; charset=utf-8";
    return "text/plain; charset=utf-8";
  }

  private planDeletions(
    paths: string[],
    local: Record<string, LocalFileMeta>,
    manifest: RemoteManifest,
    index: Record<string, SyncIndexEntry>
  ): PlannedDeletion[] {
    const plan: PlannedDeletion[] = [];
    for (const path of paths) {
      const localMeta = local[path];
      const remoteMeta = manifest.files[path];
      const lastHash = index[path]?.lastSyncedHash;
      if (!localMeta && remoteMeta && !remoteMeta.deleted && remoteMeta.hash === lastHash) {
        plan.push({ path, direction: "remote" });
      }
      if (localMeta && remoteMeta?.deleted && localMeta.hash === lastHash) {
        plan.push({ path, direction: "local" });
      }
    }
    return plan;
  }

  private async reviewLargeDeletionPlan(plan: PlannedDeletion[], knownSyncedCount: number): Promise<PlannedDeletion[] | null> {
    if (plan.length === 0) return [];
    const percent = knownSyncedCount === 0 ? 0 : (plan.length / knownSyncedCount) * 100;
    if (percent <= this.options.getMaxDeletionPercent()) return plan;
    return new Promise((resolve) => {
      new LargeDeletionModal(this.options.app, plan, percent, resolve).open();
    });
  }

  private async uploadLocal(
    path: string,
    localMeta: LocalFileMeta,
    filesFolderId: string,
    manifest: RemoteManifest,
    index: Record<string, SyncIndexEntry>,
    counters?: SyncCounters,
    localManifest?: LocalSyncManifest
  ): Promise<void> {
    const content = await this.options.scanner.read(path, !localMeta.isText);
    const localFile: LocalFile = { ...localMeta, content };
    try {
      await this.options.provider.upload(localFile);
    } catch (error) {
      if (isOfflineError(error)) {
        await this.options.offlineQueue.enqueue("upload", path);
      }
      throw error;
    }
    const uploadedMeta = manifest.files[path];
    index[path] = await this.indexEntry(path, localMeta.hash, uploadedMeta?.driveFileId, uploadedMeta?.revision, content, localMeta.isText);
    if (localManifest) updateRecordFromSync(localManifest.records, path, localMeta, uploadedMeta, this.options.getDeviceId(), false);
    if (counters) counters.uploads += 1;
  }

  private async downloadRemote(path: string, remoteMeta: RemoteFileMeta, index: Record<string, SyncIndexEntry>, counters?: SyncCounters, localManifest?: LocalSyncManifest): Promise<void> {
    const remote = await this.options.provider.download(path);
    await writeVaultFile(this.options.app.vault, path, remote.content);
    index[path] = await this.indexEntry(path, remoteMeta.hash, remoteMeta.driveFileId, remoteMeta.revision, remote.content, remote.isText);
    if (localManifest) updateRecordFromSync(localManifest.records, path, {
      path,
      hash: remoteMeta.hash,
      size: remoteMeta.size,
      extension: path.split(".").pop()?.toLowerCase() ?? "",
      mtime: Date.now(),
      isText: remote.isText
    }, remoteMeta, this.options.getDeviceId(), false);
    if (counters) counters.downloads += 1;
  }

  private async resolveConflict(
    path: string,
    localMeta: LocalFileMeta,
    remoteMeta: RemoteFileMeta,
    filesFolderId: string,
    manifest: RemoteManifest,
    index: Record<string, SyncIndexEntry>,
    counters: SyncCounters,
    backupFiles?: Record<string, BackupFileSource>,
    localManifest?: LocalSyncManifest
  ): Promise<boolean> {
    const remoteFile = await this.options.provider.download(path);
    const remoteData = typeof remoteFile.content === "string" ? new TextEncoder().encode(remoteFile.content).buffer : remoteFile.content;
    await this.captureConflictBackup(path, localMeta, remoteMeta, remoteData);
    const policy = this.options.getConflictPolicy();
    if (policy === "prefer-local") {
      if (backupFiles) this.captureRemoteBackupContent(backupFiles, path, remoteMeta, remoteData);
      await this.uploadLocal(path, localMeta, filesFolderId, manifest, index, counters, localManifest);
      return true;
    }
    if (policy === "prefer-remote") {
      if (backupFiles) await this.captureLocalBackup(backupFiles, path, localMeta);
      await this.downloadRemote(path, remoteMeta, index, counters, localManifest);
      return true;
    }
    const isText = localMeta.isText && isLikelyText(path) && localMeta.size <= MAX_SNAPSHOT_BYTES && remoteData.byteLength <= MAX_SNAPSHOT_BYTES;
    if (isText && index[path]?.baseSnapshot !== undefined) {
      const localText = await this.options.scanner.readText(path);
      const remoteText = typeof remoteFile.content === "string" ? remoteFile.content : new TextDecoder().decode(remoteData);
      const merged = this.mergeEngine.merge(path, index[path].baseSnapshot, localText, remoteText);
      if (merged.status !== "conflict") {
        const mergedText = merged.status === "no-changes" ? localText : merged.content;
        if (backupFiles) await this.captureLocalBackup(backupFiles, path, localMeta);
        await writeVaultFile(this.options.app.vault, path, mergedText);
        const hash = await sha256Hex(mergedText);
        const localMerged: LocalFileMeta = {
          path,
          hash,
          size: byteSize(mergedText),
          extension: "md",
          mtime: Date.now(),
          isText: true
        };
        await this.uploadLocal(path, localMerged, filesFolderId, manifest, index, counters, localManifest);
        return true;
      }

      const choice = await showManualConflictModal(this.options.app, {
        path,
        localText,
        remoteText,
        deviceName: remoteMeta.deviceName ?? remoteMeta.deviceId ?? "Unknown device",
        modifiedAt: remoteMeta.mtime ?? remoteMeta.updatedAt ?? null,
        changeCount: countChangedLines(index[path].baseSnapshot, localText) + countChangedLines(index[path].baseSnapshot, remoteText)
      });
      if (choice === "keep-local") {
        await this.uploadLocal(path, localMeta, filesFolderId, manifest, index, counters, localManifest);
        return true;
      }
      if (choice === "keep-remote") {
        await this.downloadRemote(path, remoteMeta, index, counters, localManifest);
        return true;
      }
    }
    const copyPath = conflictPath(path, "Google Drive");
    await writeVaultFile(this.options.app.vault, copyPath, isLikelyText(path) ? new TextDecoder().decode(remoteData) : remoteData);
    return false;
  }

  private async tombstoneRemote(path: string, manifest: RemoteManifest, index: Record<string, SyncIndexEntry>, counters?: SyncCounters, localManifest?: LocalSyncManifest) {
    const remote = manifest.files[path];
    if (!remote) return;
    await this.options.provider.delete(path);
    index[path] = { ...(index[path] ?? this.emptyEntry(path)), deleted: true, lastSyncedAt: Date.now() };
    if (localManifest) updateRecordFromSync(localManifest.records, path, undefined, manifest.files[path], this.options.getDeviceId(), true);
    if (counters) counters.remoteDeletes += 1;
  }

  private async safeLocalDelete(path: string, index: Record<string, SyncIndexEntry>, counters?: SyncCounters, localManifest?: LocalSyncManifest): Promise<void> {
    const file = this.options.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      try {
        await this.options.app.fileManager.trashFile(file);
      } catch {
        const content = isLikelyText(path) ? await this.options.app.vault.read(file) : await this.options.app.vault.readBinary(file);
        await writeVaultFile(this.options.app.vault, deletedCopyPath(path), content);
        await this.options.app.fileManager.trashFile(file);
      }
    }
    index[path] = { ...(index[path] ?? this.emptyEntry(path)), deleted: true, lastSyncedAt: Date.now() };
    if (localManifest) updateRecordFromSync(localManifest.records, path, undefined, undefined, this.options.getDeviceId(), true);
    if (counters) counters.localDeletes += 1;
  }

  private async indexEntry(
    path: string,
    hash: string,
    remoteId: string | undefined,
    remoteRevision: string | undefined,
    content: string | ArrayBuffer,
    isText: boolean
  ): Promise<SyncIndexEntry> {
    const entry: SyncIndexEntry = {
      path,
      lastSyncedHash: hash,
      lastSyncedRemoteId: remoteId,
      lastSyncedRemoteRevision: remoteRevision,
      lastSyncedAt: Date.now(),
      deleted: false
    };
    if (isText && typeof content === "string" && byteSize(content) <= MAX_SNAPSHOT_BYTES) {
      entry.baseSnapshot = content;
      entry.baseSnapshotHash = await sha256Hex(content);
    }
    return entry;
  }

  private emptyEntry(path: string): SyncIndexEntry {
    return {
      path,
      lastSyncedHash: "",
      lastSyncedAt: Date.now()
    };
  }

  private async applyRemoteCommandIfNeeded(
    state: { manifest: RemoteManifest },
    local: Record<string, LocalFileMeta>,
    counters: SyncCounters
  ): Promise<SyncSummary | undefined> {
    const command = state.manifest.command;
    if (!command || command.type !== "replace-local-from-cloud") return undefined;
    if (command.createdByDeviceId === this.options.getDeviceId()) return undefined;
    if (this.options.getAppliedCommandIds().includes(command.id)) return undefined;
    const startedAt = Date.now();
    const index: Record<string, SyncIndexEntry> = {};
    for (const path of Object.keys(local)) {
      const remote = state.manifest.files[path];
      if (!remote || remote.deleted) await this.safeLocalDelete(path, index, counters);
    }
    for (const remote of Object.values(state.manifest.files)) {
      if (!remote.deleted) await this.downloadRemote(remote.path, remote, index, counters);
    }
    await this.options.setIndex(index);
    await this.markCommandApplied(command.id);
    new Notice(`Applied Google Drive reset from ${command.createdByDeviceName}.`);
    return this.summary(startedAt, counters, command.type);
  }

  private createCommand(): RemoteSyncCommand {
    const createdAt = Date.now();
    return {
      id: `${createdAt}-${this.options.getDeviceId().slice(0, 8)}`,
      type: "replace-local-from-cloud",
      createdAt,
      createdByDeviceId: this.options.getDeviceId(),
      createdByDeviceName: this.options.getDeviceName()
    };
  }

  private async markCommandApplied(id: string): Promise<void> {
    await this.options.setAppliedCommandIds(unique([...this.options.getAppliedCommandIds(), id]).slice(-50));
  }

  private summary(startedAt: number, counters: SyncCounters, command?: string): SyncSummary {
    const finishedAt = Date.now();
    return {
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      uploads: counters.uploads,
      downloads: counters.downloads,
      localDeletes: counters.localDeletes,
      remoteDeletes: counters.remoteDeletes,
      conflicts: counters.conflicts,
      errors: counters.errors,
      command
    };
  }
}

function mimeType(path: string, isText: boolean): string {
  if (!isText) return "application/octet-stream";
  if (path.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function timestampPath(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-") + "-" + [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0")
  ].join("-");
}

function isOfflineError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /offline|network|timeout|unable to resolve|unknownhost|err_name_not_resolved|failed to fetch/i.test(message);
}

function countChangedLines(base: string, changed: string): number {
  const baseLines = base.split("\n");
  const changedLines = changed.split("\n");
  const length = Math.max(baseLines.length, changedLines.length);
  let count = 0;
  for (let index = 0; index < length; index += 1) {
    if (baseLines[index] !== changedLines[index]) count += 1;
  }
  return count;
}
