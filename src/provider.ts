import { GoogleDriveClient } from "./drive";
import { LocalFile, RemoteChange, RemoteFile, RemoteMetadata, RemoteState } from "./types";

export interface SyncProvider {
  listChanges(): Promise<RemoteChange[]>;
  upload(file: LocalFile): Promise<void>;
  download(path: string): Promise<RemoteFile>;
  delete(path: string): Promise<void>;
  getMetadata(path: string): Promise<RemoteMetadata | null>;
}

export class GoogleDriveProvider implements SyncProvider {
  private state?: RemoteState;

  constructor(
    private drive: GoogleDriveClient,
    private getRemoteFolderName: () => string,
    private getVaultId: () => string,
    private getDeviceId: () => string,
    private getDeviceName: () => string
  ) {}

  async prepare(): Promise<RemoteState> {
    this.state = await this.drive.loadRemoteState(this.getRemoteFolderName(), this.getVaultId());
    return this.state;
  }

  getState(): RemoteState {
    if (!this.state) throw new Error("Sync provider has not been prepared.");
    return this.state;
  }

  async save(): Promise<void> {
    await this.drive.saveManifest(this.getState());
  }

  async listChanges(): Promise<RemoteChange[]> {
    const state = this.getState();
    return Object.values(state.manifest.files).map((file) => ({
      path: file.path,
      fileId: file.driveFileId,
      hash: file.deleted ? null : file.hash,
      size: file.size,
      modifiedTime: file.mtime ?? file.updatedAt ?? null,
      revision: file.revision,
      deleted: file.deleted,
      deviceId: file.deviceId
    }));
  }

  async upload(file: LocalFile): Promise<void> {
    const state = this.getState();
    const existing = state.manifest.files[file.path];
    const uploaded = await this.drive.uploadVaultFile(
      file.path,
      file.content,
      mimeType(file.path, file.isText),
      state.filesFolderId,
      existing?.driveFileId
    );
    state.manifest.files[file.path] = {
      path: file.path,
      driveFileId: uploaded.id,
      hash: file.hash,
      size: file.size,
      mtime: file.mtime,
      revision: uploaded.headRevisionId,
      deleted: false,
      updatedAt: Date.now(),
      deviceId: this.getDeviceId(),
      deviceName: this.getDeviceName()
    };
  }

  async download(path: string): Promise<RemoteFile> {
    const metadata = await this.getMetadata(path);
    if (!metadata || !metadata.fileId || metadata.deleted) throw new Error(`Remote file not found: ${path}`);
    const data = await this.drive.downloadFile(metadata.fileId);
    const isText = isTextPath(path);
    return {
      ...metadata,
      content: isText ? new TextDecoder().decode(data) : data,
      isText
    };
  }

  async delete(path: string): Promise<void> {
    const state = this.getState();
    const remote = state.manifest.files[path];
    if (!remote) return;
    state.manifest.files[path] = {
      ...remote,
      deleted: true,
      deletedAt: Date.now(),
      updatedAt: Date.now(),
      deviceId: this.getDeviceId(),
      deviceName: this.getDeviceName()
    };
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const state = this.getState();
    const remote = state.manifest.files[oldPath];
    if (!remote || remote.deleted) throw new Error(`Remote file not found: ${oldPath}`);
    const renamed = await this.drive.renameVaultFile(remote.driveFileId, newPath, state.filesFolderId);
    state.manifest.files[newPath] = {
      ...remote,
      path: newPath,
      driveFileId: renamed.id,
      revision: renamed.headRevisionId ?? remote.revision,
      updatedAt: Date.now(),
      deviceId: this.getDeviceId(),
      deviceName: this.getDeviceName(),
      deleted: false
    };
    state.manifest.files[oldPath] = {
      ...remote,
      deleted: true,
      deletedAt: Date.now(),
      updatedAt: Date.now(),
      deviceId: this.getDeviceId(),
      deviceName: this.getDeviceName()
    };
  }

  async getMetadata(path: string): Promise<RemoteMetadata | null> {
    const file = this.getState().manifest.files[path];
    if (!file) return null;
    return {
      path: file.path,
      fileId: file.driveFileId,
      hash: file.deleted ? null : file.hash,
      size: file.size,
      modifiedTime: file.mtime ?? file.updatedAt ?? null,
      revision: file.revision,
      deleted: file.deleted,
      deviceId: file.deviceId
    };
  }
}

function mimeType(path: string, isText: boolean): string {
  if (!isText) return "application/octet-stream";
  if (path.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function isTextPath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return ["md", "txt", "json", "yaml", "yml", "csv", "css", "js", "ts", "html", "xml", "svg", "canvas"].includes(ext);
}
