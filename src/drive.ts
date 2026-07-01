import { GoogleAuth } from "./auth";
import { requestGoogleUrl } from "./googleRequest";
import { RemoteManifest, RemoteSnapshotMeta, RemoteState } from "./types";
import { RequestQueue } from "./queue";
import { encodeQuery } from "./utils";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const MANIFEST_NAME = ".obsidian-sync-manifest.json";
const SNAPSHOTS_FOLDER_NAME = ".obsidian-sync-snapshots";
const MAX_SNAPSHOTS = 10;

type DriveFile = {
  id: string;
  name: string;
  mimeType?: string;
  parents?: string[];
  modifiedTime?: string;
  size?: string;
  headRevisionId?: string;
};

type DriveList = {
  files?: DriveFile[];
};

export class GoogleDriveClient {
  constructor(private auth: GoogleAuth, private queue: RequestQueue) {}

  async test(): Promise<void> {
    await this.requestJson(`${DRIVE_API}/about?fields=user`, "GET");
  }

  async loadRemoteState(folderName: string, vaultId: string): Promise<RemoteState> {
    const rootFolderId = await this.ensureFolder(folderName);
    const filesFolderId = await this.ensureFolder("files", rootFolderId);
    const manifestFile = await this.findChild(rootFolderId, MANIFEST_NAME);
    if (!manifestFile) {
      return {
        rootFolderId,
        filesFolderId,
        manifest: { version: 1, vaultId, updatedAt: Date.now(), files: {} }
      };
    }
    const manifest = await this.downloadJson<RemoteManifest>(manifestFile.id);
    if (manifest.version !== 1 || !manifest.files) {
      throw new Error("Remote sync manifest is not compatible.");
    }
    return { rootFolderId, filesFolderId, manifestFileId: manifestFile.id, manifest };
  }

  async loadRemoteManifest(folderName: string): Promise<RemoteManifest | undefined> {
    const rootFolderId = await this.ensureFolder(folderName);
    const manifestFile = await this.findChild(rootFolderId, MANIFEST_NAME);
    if (!manifestFile) return undefined;
    const manifest = await this.downloadJson<RemoteManifest>(manifestFile.id);
    if (manifest.version !== 1 || !manifest.files) {
      throw new Error("Remote sync manifest is not compatible.");
    }
    return manifest;
  }

  async saveManifest(state: RemoteState): Promise<void> {
    state.manifest.updatedAt = Date.now();
    const body = JSON.stringify(state.manifest, null, 2);
    if (state.manifestFileId) {
      await this.updateContent(state.manifestFileId, body, "application/json");
      return;
    }
    const created = await this.createFile(MANIFEST_NAME, state.rootFolderId, body, "application/json");
    state.manifestFileId = created.id;
  }

  async createManifestSnapshot(state: RemoteState, deviceId: string, deviceName: string): Promise<RemoteSnapshotMeta> {
    const snapshotsFolderId = await this.ensureFolder(SNAPSHOTS_FOLDER_NAME, state.rootFolderId);
    const createdAt = Date.now();
    const id = `${createdAt}-${deviceId.slice(0, 8)}`;
    const safeName = deviceName.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "device";
    const name = `${new Date(createdAt).toISOString().replace(/[:.]/g, "-")}-${safeName}.json`;
    const snapshotManifest: RemoteManifest = {
      ...state.manifest,
      snapshots: state.manifest.snapshots ?? []
    };
    const created = await this.createFile(name, snapshotsFolderId, JSON.stringify(snapshotManifest, null, 2), "application/json");
    const snapshot: RemoteSnapshotMeta = {
      id,
      name,
      fileId: created.id,
      createdAt,
      createdByDeviceId: deviceId,
      createdByDeviceName: deviceName
    };
    const allSnapshots = [snapshot, ...(state.manifest.snapshots ?? [])];
    state.manifest.snapshots = allSnapshots.slice(0, MAX_SNAPSHOTS);
    const oldSnapshots = allSnapshots.slice(MAX_SNAPSHOTS);
    for (const old of oldSnapshots) {
      await this.trashFile(old.fileId);
    }
    return snapshot;
  }

  async downloadFile(fileId: string): Promise<ArrayBuffer> {
    const token = await this.auth.getValidAccessToken();
    return this.queue.run(async () => {
      const response = await requestGoogleUrl({
        url: `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`,
        method: "GET",
        headers: { Authorization: `Bearer ${token}` }
      });
      if (response.status < 200 || response.status >= 300) throw statusError(response.status, "Download failed.");
      return response.arrayBuffer;
    });
  }

  async uploadVaultFile(path: string, content: string | ArrayBuffer, mimeType: string, filesFolderId: string, existingId?: string): Promise<DriveFile> {
    if (existingId) return this.updateContent(existingId, content, mimeType);
    const parentId = await this.ensureFolderPath(path.split("/").slice(0, -1), filesFolderId);
    const name = path.split("/").pop() || path;
    return this.createFile(name, parentId, content, mimeType);
  }

  async trashFile(fileId: string): Promise<void> {
    await this.requestJson(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id,trashed`, "PATCH", { trashed: true });
  }

  private async ensureFolderPath(parts: string[], rootId: string): Promise<string> {
    let parentId = rootId;
    for (const part of parts.filter(Boolean)) {
      parentId = await this.ensureFolder(part, parentId);
    }
    return parentId;
  }

  private async ensureFolder(name: string, parentId?: string): Promise<string> {
    const existing = await this.findChild(parentId, name, FOLDER_MIME);
    if (existing) return existing.id;
    const metadata: Record<string, unknown> = { name, mimeType: FOLDER_MIME };
    if (parentId) metadata.parents = [parentId];
    const created = await this.requestJson<DriveFile>(`${DRIVE_API}/files?fields=id,name,mimeType`, "POST", metadata);
    return created.id;
  }

  private async findChild(parentId: string | undefined, name: string, mimeType?: string): Promise<DriveFile | undefined> {
    const clauses = [`name = '${escapeDriveQuery(name)}'`, "trashed = false"];
    if (parentId) clauses.push(`'${parentId}' in parents`);
    if (mimeType) clauses.push(`mimeType = '${mimeType}'`);
    const query = encodeQuery({
      q: clauses.join(" and "),
      fields: "files(id,name,mimeType,modifiedTime,size,headRevisionId)",
      pageSize: 1
    });
    const result = await this.requestJson<DriveList>(`${DRIVE_API}/files?${query}`, "GET");
    return result.files?.[0];
  }

  private async downloadJson<T>(fileId: string): Promise<T> {
    const data = await this.downloadFile(fileId);
    return JSON.parse(new TextDecoder().decode(data)) as T;
  }

  private async requestJson<T>(url: string, method: string, body?: unknown): Promise<T> {
    const token = await this.auth.getValidAccessToken();
    return this.queue.run(async () => {
      const response = await requestGoogleUrl({
        url,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { "Content-Type": "application/json" } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
      if (response.status < 200 || response.status >= 300) throw statusError(response.status, "Google Drive request failed.");
      return response.json as T;
    });
  }

  private async createFile(name: string, parentId: string, content: string | ArrayBuffer, mimeType: string): Promise<DriveFile> {
    const token = await this.auth.getValidAccessToken();
    return this.queue.run(async () => {
      const response = await requestGoogleUrl({
        url: `${UPLOAD_API}/files?uploadType=multipart&fields=id,name,modifiedTime,size,headRevisionId`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": `multipart/related; boundary=${BOUNDARY}`
        },
        body: multipartBody({ name, parents: [parentId] }, content, mimeType)
      });
      if (response.status < 200 || response.status >= 300) throw statusError(response.status, "Google Drive upload failed.");
      return response.json as DriveFile;
    });
  }

  private async updateContent(fileId: string, content: string | ArrayBuffer, mimeType: string): Promise<DriveFile> {
    const token = await this.auth.getValidAccessToken();
    return this.queue.run(async () => {
      const response = await requestGoogleUrl({
        url: `${UPLOAD_API}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,name,modifiedTime,size,headRevisionId`,
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": mimeType
        },
        body: content
      });
      if (response.status < 200 || response.status >= 300) throw statusError(response.status, "Google Drive update failed.");
      return response.json as DriveFile;
    });
  }
}

const BOUNDARY = "obsidian_google_drive_sync_boundary";

function multipartBody(metadata: Record<string, unknown>, content: string | ArrayBuffer, mimeType: string): ArrayBuffer {
  const encoder = new TextEncoder();
  const head = encoder.encode(`--${BOUNDARY}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${BOUNDARY}\r\nContent-Type: ${mimeType}\r\n\r\n`);
  const media = typeof content === "string" ? encoder.encode(content) : new Uint8Array(content);
  const tail = encoder.encode(`\r\n--${BOUNDARY}--`);
  const bytes = new Uint8Array(head.byteLength + media.byteLength + tail.byteLength);
  bytes.set(head, 0);
  bytes.set(media, head.byteLength);
  bytes.set(tail, head.byteLength + media.byteLength);
  return bytes.buffer;
}

function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function statusError(status: number, message: string): Error & { status?: number } {
  const error = new Error(`${message} (${status})`) as Error & { status?: number };
  error.status = status;
  return error;
}
