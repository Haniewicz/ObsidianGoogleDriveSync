import { App, Notice, TFile } from "obsidian";
import { GoogleDriveClient } from "./drive";
import { LocalVaultScanner } from "./scanner";
import { ConflictPolicy, LocalFileMeta, PlannedDeletion, RemoteFileMeta, RemoteManifest, RemoteSyncCommand, SyncIndexEntry, SyncSummary } from "./types";
import { byteSize, conflictPath, deletedCopyPath, isLikelyText, sha256Hex, unique, writeVaultFile } from "./utils";
import { LargeDeletionModal, showConflictNotice } from "./modals";
import { mergeText } from "./merge";

const MAX_SNAPSHOT_BYTES = 1024 * 1024;

export type SyncEngineOptions = {
  app: App;
  scanner: LocalVaultScanner;
  drive: GoogleDriveClient;
  getRemoteFolderName: () => string;
  getVaultId: () => string;
  getIndex: () => Record<string, SyncIndexEntry>;
  setIndex: (index: Record<string, SyncIndexEntry>) => Promise<void>;
  getMaxDeletionPercent: () => number;
  getConflictPolicy: () => ConflictPolicy;
  getDeviceId: () => string;
  getDeviceName: () => string;
  getAppliedCommandIds: () => string[];
  setAppliedCommandIds: (ids: string[]) => Promise<void>;
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
    try {
      const local = await this.options.scanner.scan();
      const state = await this.options.drive.loadRemoteState(this.options.getRemoteFolderName(), this.options.getVaultId());
      const commandSummary = await this.applyRemoteCommandIfNeeded(state, local, counters);
      if (commandSummary) return commandSummary;
      const index = { ...this.options.getIndex() };
      const paths = unique([...Object.keys(local), ...Object.keys(state.manifest.files), ...Object.keys(index)]);
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
        const lastHash = entry?.lastSyncedHash;

        if (localMeta && remoteMeta && !remoteMeta.deleted && localMeta.hash === lastHash && remoteMeta.hash === lastHash) continue;

        if (localMeta && remoteMeta && !remoteMeta.deleted && localMeta.hash !== lastHash && remoteMeta.hash === lastHash) {
          await this.uploadLocal(path, localMeta, state.filesFolderId, state.manifest, index, counters);
          continue;
        }

        if (localMeta && remoteMeta && !remoteMeta.deleted && localMeta.hash === lastHash && remoteMeta.hash !== lastHash) {
          await this.downloadRemote(path, remoteMeta, index, counters);
          continue;
        }

        if (localMeta && remoteMeta?.deleted && localMeta.hash === lastHash) {
          if (allowedDeletionKeys.has(`local:${path}`)) await this.safeLocalDelete(path, index, counters);
          continue;
        }

        if (!localMeta && remoteMeta && !remoteMeta.deleted && remoteMeta.hash === lastHash) {
          if (allowedDeletionKeys.has(`remote:${path}`)) this.tombstoneRemote(path, state.manifest, index, counters);
          continue;
        }

        if (!localMeta && remoteMeta?.deleted) {
          index[path] = { ...(entry ?? this.emptyEntry(path)), deleted: true };
          continue;
        }

        if (!localMeta && remoteMeta && !remoteMeta.deleted) {
          await this.downloadRemote(path, remoteMeta, index, counters);
          continue;
        }

        if (localMeta && (!remoteMeta || remoteMeta.deleted) && !entry?.deleted) {
          await this.uploadLocal(path, localMeta, state.filesFolderId, state.manifest, index, counters);
          continue;
        }

        if (localMeta && remoteMeta && !remoteMeta.deleted && localMeta.hash !== lastHash && remoteMeta.hash !== lastHash) {
          const resolved = await this.resolveConflict(path, localMeta, remoteMeta, state.filesFolderId, state.manifest, index, counters);
          if (!resolved) counters.conflicts += 1;
        }
      }

      await this.options.drive.saveManifest(state);
      await this.options.setIndex(index);
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
    counters?: SyncCounters
  ): Promise<void> {
    const content = await this.options.scanner.read(path, !localMeta.isText);
    const existing = manifest.files[path];
    const uploaded = await this.options.drive.uploadVaultFile(path, content, mimeType(path, localMeta.isText), filesFolderId, existing?.driveFileId);
    manifest.files[path] = {
      path,
      driveFileId: uploaded.id,
      hash: localMeta.hash,
      size: localMeta.size,
      mtime: localMeta.mtime,
      revision: uploaded.headRevisionId,
      deleted: false,
      updatedAt: Date.now()
    };
    index[path] = await this.indexEntry(path, localMeta.hash, uploaded.id, uploaded.headRevisionId, content, localMeta.isText);
    if (counters) counters.uploads += 1;
  }

  private async downloadRemote(path: string, remoteMeta: RemoteFileMeta, index: Record<string, SyncIndexEntry>, counters?: SyncCounters): Promise<void> {
    const data = await this.options.drive.downloadFile(remoteMeta.driveFileId);
    const content = isLikelyText(path) ? new TextDecoder().decode(data) : data;
    await writeVaultFile(this.options.app.vault, path, content);
    index[path] = await this.indexEntry(path, remoteMeta.hash, remoteMeta.driveFileId, remoteMeta.revision, content, isLikelyText(path));
    if (counters) counters.downloads += 1;
  }

  private async resolveConflict(
    path: string,
    localMeta: LocalFileMeta,
    remoteMeta: RemoteFileMeta,
    filesFolderId: string,
    manifest: RemoteManifest,
    index: Record<string, SyncIndexEntry>,
    counters: SyncCounters
  ): Promise<boolean> {
    const remoteData = await this.options.drive.downloadFile(remoteMeta.driveFileId);
    const policy = this.options.getConflictPolicy();
    if (policy === "prefer-local") {
      await this.uploadLocal(path, localMeta, filesFolderId, manifest, index, counters);
      return true;
    }
    if (policy === "prefer-remote") {
      await this.downloadRemote(path, remoteMeta, index, counters);
      return true;
    }
    const isText = localMeta.isText && isLikelyText(path) && localMeta.size <= MAX_SNAPSHOT_BYTES && remoteData.byteLength <= MAX_SNAPSHOT_BYTES;
    if (isText && index[path]?.baseSnapshot !== undefined) {
      const localText = await this.options.scanner.readText(path);
      const remoteText = new TextDecoder().decode(remoteData);
      const merged = mergeText(index[path].baseSnapshot, localText, remoteText);
      if (merged.clean) {
        await writeVaultFile(this.options.app.vault, path, merged.text);
        const hash = await sha256Hex(merged.text);
        const size = byteSize(merged.text);
        const uploaded = await this.options.drive.uploadVaultFile(path, merged.text, "text/markdown; charset=utf-8", filesFolderId, remoteMeta.driveFileId);
        manifest.files[path] = {
          path,
          driveFileId: uploaded.id,
          hash,
          size,
          mtime: Date.now(),
          revision: uploaded.headRevisionId,
          deleted: false,
          updatedAt: Date.now()
        };
        index[path] = await this.indexEntry(path, hash, uploaded.id, uploaded.headRevisionId, merged.text, true);
        return true;
      }
    }
    const copyPath = conflictPath(path, "Google Drive");
    await writeVaultFile(this.options.app.vault, copyPath, isLikelyText(path) ? new TextDecoder().decode(remoteData) : remoteData);
    return false;
  }

  private tombstoneRemote(path: string, manifest: RemoteManifest, index: Record<string, SyncIndexEntry>, counters?: SyncCounters) {
    const remote = manifest.files[path];
    if (!remote) return;
    manifest.files[path] = {
      ...remote,
      deleted: true,
      deletedAt: Date.now(),
      updatedAt: Date.now()
    };
    index[path] = { ...(index[path] ?? this.emptyEntry(path)), deleted: true, lastSyncedAt: Date.now() };
    if (counters) counters.remoteDeletes += 1;
  }

  private async safeLocalDelete(path: string, index: Record<string, SyncIndexEntry>, counters?: SyncCounters): Promise<void> {
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
