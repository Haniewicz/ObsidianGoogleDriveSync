import { Notice, Platform, Plugin, TAbstractFile } from "obsidian";
import { GoogleAuth } from "./auth";
import { GoogleDriveClient } from "./drive";
import { DeviceFlowModal, chooseLocalFilesToKeep, confirmDangerAction, confirmResetIndex } from "./modals";
import { RequestQueue } from "./queue";
import { LocalVaultScanner } from "./scanner";
import { GoogleDriveSyncSettingTab } from "./settings";
import { SyncEngine } from "./sync";
import { DEFAULT_SETTINGS, GoogleDriveSyncSettings, PluginData, RemoteSnapshotMeta, StoredAuth, StoredPluginData, SyncStatus, SyncSummary, defaultIgnoredPaths } from "./types";
import { createLogger } from "./utils";

export default class GoogleDriveSyncPlugin extends Plugin {
  settings: GoogleDriveSyncSettings = { ...DEFAULT_SETTINGS };
  pluginData: PluginData = {};
  queue = new RequestQueue(DEFAULT_SETTINGS.requestConcurrency);
  auth!: GoogleAuth;
  drive!: GoogleDriveClient;
  scanner!: LocalVaultScanner;
  syncEngine!: SyncEngine;
  accountLabel?: string;
  onConnectionChange?: () => void;
  private syncTimer?: number;
  private cloudWatchTimer?: number;
  private debounceTimer?: number;
  private cloudWatchRunning = false;
  private dirtyPaths = new Set<string>();
  private log = createLogger(() => this.settings.debugMode);

  async onload() {
    await this.loadSettings();
    await this.loadPluginData();
    this.ensureDeviceIdentity();
    this.queue.setConcurrency(this.settings.requestConcurrency);
    this.auth = new GoogleAuth(
      this,
      () => this.settings.clientId,
      () => this.settings.clientSecret,
      (data) => this.savePluginData(data),
      () => this.markDisconnected()
    );
    this.auth.setAuth(this.pluginData.auth);
    this.drive = new GoogleDriveClient(this.auth, this.queue);
    this.scanner = new LocalVaultScanner(this.app.vault, () => this.settings.ignoredPaths);
    this.syncEngine = new SyncEngine({
      app: this.app,
      scanner: this.scanner,
      drive: this.drive,
      getRemoteFolderName: () => this.settings.remoteFolderName,
      getVaultId: () => this.getVaultId(),
      getIndex: () => this.pluginData.index ?? {},
      setIndex: async (index) => this.savePluginData({ index }),
      getMaxDeletionPercent: () => this.settings.maxDeletionPercent,
      getConflictPolicy: () => this.settings.conflictPolicy,
      getDeviceId: () => this.getDeviceId(),
      getDeviceName: () => this.getDeviceName(),
      getAppliedCommandIds: () => this.pluginData.appliedCommandIds ?? [],
      setAppliedCommandIds: async (appliedCommandIds) => this.savePluginData({ appliedCommandIds })
    });

    this.addSettingTab(new GoogleDriveSyncSettingTab(this));
    this.registerCommands();
    this.registerVaultEvents();
    this.configureTimers();
    void this.refreshAccountLabel();

    if (this.settings.syncOnStartup && this.getStoredAuth()) {
      window.setTimeout(() => void this.syncNow(), 2500);
    }
  }

  onunload() {
    if (this.syncTimer !== undefined) window.clearInterval(this.syncTimer);
    if (this.cloudWatchTimer !== undefined) window.clearInterval(this.cloudWatchTimer);
    if (this.debounceTimer !== undefined) window.clearTimeout(this.debounceTimer);
  }

  async loadSettings() {
    const loaded = await this.loadData() as StoredPluginData | null;
    const settings = {
      ...DEFAULT_SETTINGS,
      ignoredPaths: defaultIgnoredPaths(this.app.vault.configDir),
      ...(loaded?.settings ?? {})
    };
    if (!loaded?.settings?.ignoredPaths) settings.ignoredPaths = defaultIgnoredPaths(this.app.vault.configDir);
    this.settings = settings;
  }

  async saveSettings() {
    await this.savePluginData({ settings: this.settings });
  }

  async loadPluginData() {
    const loaded = await this.loadData() as StoredPluginData | null;
    this.pluginData = {
      auth: loaded?.auth,
      index: loaded?.index ?? {},
      vaultId: loaded?.vaultId,
      deviceId: loaded?.deviceId,
      appliedCommandIds: loaded?.appliedCommandIds ?? [],
      syncStatus: loaded?.syncStatus ?? { state: loaded?.auth ? "idle" : "disconnected" },
      lastRemoteUpdatedAt: loaded?.lastRemoteUpdatedAt,
      lastRemoteCommandId: loaded?.lastRemoteCommandId
    };
  }

  async savePluginData(data: Partial<StoredPluginData>) {
    const pluginData = { ...data };
    delete pluginData.settings;
    this.pluginData = {
      ...this.pluginData,
      ...pluginData
    };
    await this.saveData({
      ...this.pluginData,
      settings: this.settings
    });
  }

  getStoredAuth(): StoredAuth | undefined {
    return this.pluginData.auth;
  }

  async connectGoogleDrive() {
    const session = await this.auth.startDeviceFlow();
    const url = session.device.verification_url_complete ?? session.device.verification_uri_complete;
    if (url) window.open(url, "_blank");
    new DeviceFlowModal(this.app, session, () => undefined).open();
    await session.done;
    await this.drive.test();
    await this.refreshAccountLabel();
    new Notice("Google Drive connected.");
    this.onConnectionChange?.();
    await this.syncNow();
  }

  async disconnectGoogleDrive() {
    await this.auth.disconnect();
    await this.markDisconnected();
    new Notice("Google Drive disconnected.");
    await this.setSyncStatus({ state: "disconnected" });
    this.onConnectionChange?.();
  }

  async markDisconnected() {
    this.pluginData.auth = undefined;
    this.auth?.setAuth(undefined);
    this.accountLabel = undefined;
    await this.savePluginData({ auth: undefined });
  }

  async syncNow() {
    if (!this.getStoredAuth()) {
      new Notice("Connect Google Drive before syncing.");
      await this.setSyncStatus({ state: "disconnected" });
      return;
    }
    const startedAt = Date.now();
    await this.setSyncStatus({ state: "syncing", lastStartedAt: startedAt, lastError: undefined });
    try {
      this.log("Starting sync", { dirtyCount: this.dirtyPaths.size });
      this.dirtyPaths.clear();
      const summary = await this.syncEngine.syncNow();
      if (summary) await this.recordSyncSuccess(summary);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Google Drive sync failed.");
      this.log("Sync failed", error instanceof Error ? error.message : String(error));
      await this.recordSyncError(error);
    }
  }

  async resetCloudFromLocal() {
    await this.requireConnectedForDangerAction();
    await this.setSyncStatus({ state: "syncing", lastStartedAt: Date.now(), lastError: undefined });
    try {
      const summary = await this.syncEngine.resetCloudFromLocal();
      await this.recordSyncSuccess(summary);
    } catch (error) {
      await this.recordSyncError(error);
      throw error;
    }
  }

  async resetLocalFromCloud(keepLocalPaths: string[]) {
    await this.requireConnectedForDangerAction();
    await this.setSyncStatus({ state: "syncing", lastStartedAt: Date.now(), lastError: undefined });
    try {
      const summary = await this.syncEngine.resetLocalFromCloud(keepLocalPaths);
      await this.recordSyncSuccess(summary);
    } catch (error) {
      await this.recordSyncError(error);
      throw error;
    }
  }

  async listLocalOnlyPaths(): Promise<string[]> {
    await this.requireConnectedForDangerAction();
    return this.syncEngine.listLocalOnlyPaths();
  }

  async getRemoteSnapshots(): Promise<RemoteSnapshotMeta[]> {
    await this.requireConnectedForDangerAction();
    const state = await this.drive.loadRemoteState(this.settings.remoteFolderName, this.getVaultId());
    return state.manifest.snapshots ?? [];
  }

  async confirmAndResetCloudFromLocal() {
    const confirmed = await confirmDangerAction(
      this.app,
      "Reset Google Drive from this vault?",
      "This moves existing synced Google Drive files to trash, uploads this local vault as the new cloud state, and tells other devices to replace their local vault from cloud on next sync.",
      "Reset cloud"
    );
    if (!confirmed) return;
    await this.resetCloudFromLocal();
  }

  async confirmAndResetLocalFromCloud() {
    const confirmed = await confirmDangerAction(
      this.app,
      "Reset this vault from Google Drive?",
      "This overwrites local synced files from Google Drive. You can choose which local-only files should stay and be uploaded back to cloud.",
      "Review local files"
    );
    if (!confirmed) return;
    const localOnly = await this.listLocalOnlyPaths();
    const keep = localOnly.length > 0 ? await chooseLocalFilesToKeep(this.app, localOnly) : [];
    if (keep === null) return;
    await this.resetLocalFromCloud(keep);
  }

  configureTimers() {
    if (this.syncTimer !== undefined) window.clearInterval(this.syncTimer);
    if (this.cloudWatchTimer !== undefined) window.clearInterval(this.cloudWatchTimer);
    if (this.settings.fullSyncFallbackEnabled) {
      const intervalMs = Math.max(1, this.settings.syncIntervalMinutes) * 60 * 1000;
      this.syncTimer = window.setInterval(() => void this.syncNow(), intervalMs);
    }
    if (this.settings.cloudWatchEnabled) {
      const intervalMs = Math.max(10, this.settings.cloudWatchIntervalSeconds) * 1000;
      this.cloudWatchTimer = window.setInterval(() => void this.checkCloudForChanges(), intervalMs);
    }
  }

  async checkCloudForChanges() {
    if (this.cloudWatchRunning || !this.getStoredAuth()) return;
    this.cloudWatchRunning = true;
    try {
      const manifest = await this.drive.loadRemoteManifest(this.settings.remoteFolderName);
      if (!manifest) return;
      const commandId = manifest.command?.id;
      const hasNewCommand = commandId !== undefined && commandId !== this.pluginData.lastRemoteCommandId;
      const hasRemoteUpdate = manifest.updatedAt !== undefined && manifest.updatedAt !== this.pluginData.lastRemoteUpdatedAt;
      await this.savePluginData({
        lastRemoteUpdatedAt: manifest.updatedAt,
        lastRemoteCommandId: commandId
      });
      if (hasNewCommand || hasRemoteUpdate) {
        this.log("Cloud watch detected remote change", { updatedAt: manifest.updatedAt, commandId });
        await this.syncNow();
      }
    } catch (error) {
      this.log("Cloud watch failed", error instanceof Error ? error.message : String(error));
    } finally {
      this.cloudWatchRunning = false;
    }
  }

  private registerCommands() {
    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      icon: "refresh-cw",
      callback: () => void this.syncNow()
    });
    this.addCommand({
      id: "sync-now-mobile",
      name: "Sync now",
      icon: "refresh-cw",
      mobileOnly: true,
      callback: () => void this.syncNow()
    });
    this.addCommand({
      id: "connect-google-drive",
      name: "Connect Google Drive",
      callback: () => void this.connectGoogleDrive()
    });
    this.addCommand({
      id: "disconnect-google-drive",
      name: "Disconnect Google Drive",
      callback: () => void this.disconnectGoogleDrive()
    });
    this.addCommand({
      id: "show-sync-status",
      name: "Show sync status",
      callback: () => {
        const count = Object.keys(this.pluginData.index ?? {}).length;
        new Notice(`${this.getStoredAuth() ? "Connected" : "Disconnected"}; ${count} indexed files.`);
      }
    });
    this.addCommand({
      id: "reset-local-sync-index",
      name: "Reset local sync index",
      callback: async () => {
        if (await confirmResetIndex(this.app)) {
          await this.savePluginData({ index: {} });
          new Notice("Local sync index reset.");
        }
      }
    });
  }

  private registerVaultEvents() {
    const schedule = (file?: TAbstractFile) => {
      if (file?.path) this.dirtyPaths.add(file.path);
      if (!this.settings.autoSyncEnabled || !this.getStoredAuth()) return;
      if (this.debounceTimer !== undefined) window.clearTimeout(this.debounceTimer);
      const delayMs = Math.max(0, this.settings.syncDebounceSeconds) * 1000;
      this.debounceTimer = window.setTimeout(() => void this.syncNow(), delayMs);
    };
    this.registerEvent(this.app.vault.on("create", schedule));
    this.registerEvent(this.app.vault.on("modify", schedule));
    this.registerEvent(this.app.vault.on("delete", schedule));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      this.dirtyPaths.add(oldPath);
      schedule(file);
    }));
  }

  private getVaultId(): string {
    if (this.pluginData.vaultId) return this.pluginData.vaultId;
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const id = Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
    this.pluginData.vaultId = id;
    void this.savePluginData({ vaultId: id });
    return id;
  }

  private getDeviceId(): string {
    if (this.pluginData.deviceId) return this.pluginData.deviceId;
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    const id = Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
    this.pluginData.deviceId = id;
    void this.savePluginData({ deviceId: id });
    return id;
  }

  private getDeviceName(): string {
    return this.settings.deviceName.trim() || `Device ${this.getDeviceId().slice(0, 6)}`;
  }

  private ensureDeviceIdentity() {
    const deviceId = this.getDeviceId();
    if (!this.settings.deviceName.trim()) {
      const platform = Platform.isMobile ? "Mobile" : "Desktop";
      this.settings.deviceName = `${platform} ${deviceId.slice(0, 6)}`;
      void this.saveSettings();
    }
  }

  private async requireConnectedForDangerAction() {
    if (!this.getStoredAuth()) throw new Error("Connect Google Drive before syncing.");
  }

  private async setSyncStatus(status: SyncStatus) {
    await this.savePluginData({ syncStatus: status });
    this.onConnectionChange?.();
  }

  private async recordSyncSuccess(summary: SyncSummary) {
    await this.rememberCurrentRemoteMarkers();
    await this.setSyncStatus({
      state: "idle",
      lastStartedAt: summary.startedAt,
      lastFinishedAt: summary.finishedAt,
      lastDurationMs: summary.durationMs,
      lastSummary: summary
    });
  }

  private async recordSyncError(error: unknown) {
    await this.setSyncStatus({
      state: "error",
      lastStartedAt: this.pluginData.syncStatus?.lastStartedAt,
      lastFinishedAt: Date.now(),
      lastError: error instanceof Error ? error.message : String(error),
      lastSummary: this.pluginData.syncStatus?.lastSummary
    });
  }

  private async refreshAccountLabel() {
    if (!this.getStoredAuth()) return;
    this.accountLabel = await this.auth.getAccountLabel();
  }

  private async rememberCurrentRemoteMarkers() {
    try {
      const manifest = await this.drive.loadRemoteManifest(this.settings.remoteFolderName);
      await this.savePluginData({
        lastRemoteUpdatedAt: manifest?.updatedAt,
        lastRemoteCommandId: manifest?.command?.id
      });
    } catch (error) {
      this.log("Could not refresh cloud watch marker", error instanceof Error ? error.message : String(error));
    }
  }
}
