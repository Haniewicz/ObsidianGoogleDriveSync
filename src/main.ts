import { Notice, Platform, Plugin, TAbstractFile, TFile, moment, setIcon } from "obsidian";
import { GoogleAuth } from "./auth";
import { decodeTransferPayload } from "./authTransfer";
import { GoogleDriveClient } from "./drive";
import { OfflineSyncQueue } from "./offlineQueue";
import { GoogleDriveProvider } from "./provider";
import { AuthExportModal, DeviceFlowModal, chooseInitialSyncDirection, chooseLocalFilesToKeep, confirmDangerAction, confirmResetIndex, showAuthImportModal } from "./modals";
import { RequestQueue } from "./queue";
import { LocalVaultScanner } from "./scanner";
import { GoogleDriveSyncSettingTab } from "./settings";
import { SyncEngine } from "./sync";
import { DEFAULT_SETTINGS, GoogleDriveSyncSettings, InitialSyncDirection, PluginData, RemoteSnapshotMeta, StoredAuth, StoredPluginData, SyncStatus, SyncSummary, defaultIgnoredPaths } from "./types";
import { createLogger, ignoredPatternsFromSettings, isIgnored, sanitizeLogValue } from "./utils";

const LOCAL_SYNC_LOG_PATH = ".sync/google-drive-vault-sync.log";
const MAX_LOCAL_SYNC_LOG_BYTES = 512 * 1024;

export default class GoogleDriveSyncPlugin extends Plugin {
  settings: GoogleDriveSyncSettings = { ...DEFAULT_SETTINGS };
  pluginData: PluginData = {};
  queue = new RequestQueue(DEFAULT_SETTINGS.requestConcurrency);
  auth!: GoogleAuth;
  drive!: GoogleDriveClient;
  provider!: GoogleDriveProvider;
  offlineQueue!: OfflineSyncQueue;
  scanner!: LocalVaultScanner;
  syncEngine!: SyncEngine;
  accountLabel?: string;
  onConnectionChange?: () => void;
  private statusBarEl!: HTMLElement;
  private ribbonEl!: HTMLElement;
  private syncTimer?: number;
  private cloudWatchTimer?: number;
  private debounceTimer?: number;
  private cloudWatchRunning = false;
  private startupSyncRunning = false;
  private syncRunning = false;
  private normalUploadUnlocked = false;
  private ignoreVaultEventsUntil = 0;
  private dirtyPaths = new Set<string>();
  private log = createLogger(() => this.settings.debugMode);
  private logSessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  private lastCloudWatchSkipLogAt = 0;

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
    this.provider = new GoogleDriveProvider(
      this.drive,
      () => this.settings.remoteFolderName,
      () => this.getVaultId(),
      () => this.getDeviceId(),
      () => this.getDeviceName()
    );
    this.offlineQueue = new OfflineSyncQueue(
      () => this.pluginData.offlineQueue ?? [],
      async (offlineQueue) => this.savePluginData({ offlineQueue }),
      () => this.getDeviceId()
    );
    this.scanner = new LocalVaultScanner(this.app.vault, () => this.settings.ignoredPaths);
    this.syncEngine = new SyncEngine({
      app: this.app,
      scanner: this.scanner,
      drive: this.drive,
      provider: this.provider,
      offlineQueue: this.offlineQueue,
      getRemoteFolderName: () => this.settings.remoteFolderName,
      getVaultId: () => this.getVaultId(),
      getIndex: () => this.pluginData.index ?? {},
      setIndex: async (index) => this.savePluginData({ index }),
      getLocalManifest: () => this.pluginData.localManifest,
      setLocalManifest: async (localManifest) => this.savePluginData({ localManifest }),
      getOfflineQueueItems: () => this.pluginData.offlineQueue ?? [],
      getMaxDeletionPercent: () => this.settings.maxDeletionPercent,
      getConflictPolicy: () => this.settings.conflictPolicy,
      getDeviceId: () => this.getDeviceId(),
      getDeviceName: () => this.getDeviceName(),
      getAppliedCommandIds: () => this.pluginData.appliedCommandIds ?? [],
      setAppliedCommandIds: async (appliedCommandIds) => this.savePluginData({ appliedCommandIds }),
      getBackupEnabled: () => this.settings.backupEnabled,
      getBackupMode: () => this.settings.backupMode,
      getBackupIntervalMinutes: () => this.settings.backupIntervalMinutes,
      getMaxBackups: () => this.settings.maxBackups,
      appendLog: (message, details) => this.appendSyncLog(message, details)
    });
    await this.appendSyncLog("plugin-loaded", {
      version: this.manifest.version,
      mobile: Platform.isMobile,
      syncOnStartup: this.settings.syncOnStartup,
      initialSyncCompleted: this.isInitialSyncCompleted(),
      connected: this.getStoredAuth() !== undefined
    });

    this.addSettingTab(new GoogleDriveSyncSettingTab(this));
    this.registerCommands();
    this.registerVaultEvents();
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("obsidian-google-sync-status-bar");
    this.statusBarEl.setAttribute("aria-label", "Google Drive Sync: click to sync");
    this.statusBarEl.setAttribute("aria-label-position", "top");
    this.statusBarEl.addEventListener("click", () => void this.syncNow(true));
    this.updateStatusBar();
    this.ribbonEl = this.addRibbonIcon("cloud", "Sync Google Drive", () => void this.syncNow(true));
    this.updateStatusBar();
    this.registerObsidianProtocolHandler("google-drive-vault-sync", (data) => {
      if (typeof data.payload === "string" && data.payload) {
        void this.handleAuthImport(data.payload);
      }
    });
    void this.refreshAccountLabel();

    if (this.settings.syncOnStartup && this.getStoredAuth() && this.isInitialSyncCompleted()) {
      await this.appendSyncLog("startup-sync-scheduled", { delayMs: 2500 });
      window.setTimeout(() => void this.safeStartupSync(), 2500);
    } else {
      this.normalUploadUnlocked = true;
      await this.rememberCurrentRemoteMarkers();
      this.configureTimers();
      await this.appendSyncLog("startup-sync-skipped", {
        syncOnStartup: this.settings.syncOnStartup,
        connected: this.getStoredAuth() !== undefined,
        initialSyncCompleted: this.isInitialSyncCompleted()
      });
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
    if (!settings.ignoredPaths.split(/\r?\n/).some((line) => line.trim() === ".sync/")) {
      settings.ignoredPaths = `${settings.ignoredPaths.trim()}\n.sync/`.trim();
    }
    this.settings = settings;
  }

  async saveSettings() {
    await this.savePluginData({ settings: this.settings });
  }

  async loadPluginData() {
    const loaded = await this.loadData() as StoredPluginData | null;
    const index = loaded?.index ?? {};
    const hasPreviousSync = Object.keys(index).length > 0 || loaded?.syncStatus?.lastSummary !== undefined;
    this.pluginData = {
      auth: loaded?.auth,
      index,
      localManifest: loaded?.localManifest,
      offlineQueue: loaded?.offlineQueue ?? [],
      vaultId: loaded?.vaultId,
      deviceId: loaded?.deviceId,
      appliedCommandIds: loaded?.appliedCommandIds ?? [],
      initialSyncCompleted: loaded?.initialSyncCompleted ?? (loaded?.auth ? hasPreviousSync : false),
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
    await this.promptForInitialSyncIfNeeded();
  }

  async disconnectGoogleDrive() {
    await this.auth.disconnect();
    await this.markDisconnected();
    new Notice("Google Drive disconnected.");
    await this.setSyncStatus({ state: "disconnected" });
    this.onConnectionChange?.();
  }

  async getBackups(): Promise<import("./types").BackupMeta[]> {
    const state = await this.drive.loadRemoteState(this.settings.remoteFolderName, this.getVaultId());
    return state.manifest.backups ?? [];
  }

  async getManualBackups(): Promise<import("./types").BackupMeta[]> {
    const state = await this.drive.loadRemoteState(this.settings.remoteFolderName, this.getVaultId());
    return state.manifest.manualBackups ?? [];
  }

  async createManualBackup(label: string): Promise<void> {
    await this.syncEngine.createManualBackup(label);
    new Notice(`Manual backup created: ${label}`);
    this.onConnectionChange?.();
  }

  async restoreFromBackup(backup: import("./types").BackupMeta): Promise<void> {
    await this.syncEngine.restoreFromBackup(backup.fileId);
    new Notice(`Vault restored from backup (${new Date(backup.createdAt).toLocaleString()}).`);
    this.onConnectionChange?.();
  }

  async restoreFileFromBackup(backup: import("./types").BackupMeta, path: string): Promise<void> {
    await this.syncEngine.restoreFileFromBackup(backup.fileId, path);
    new Notice(`Restored ${path} from backup (${new Date(backup.createdAt).toLocaleString()}).`);
    this.onConnectionChange?.();
  }

  async deleteBackup(backup: import("./types").BackupMeta): Promise<void> {
    await this.drive.trashFile(backup.folderId ?? backup.fileId);
    const state = await this.drive.loadRemoteState(this.settings.remoteFolderName, this.getVaultId());
    state.manifest.backups = (state.manifest.backups ?? []).filter((b) => b.id !== backup.id);
    await this.drive.saveManifest(state);
  }

  async deleteManualBackup(backup: import("./types").BackupMeta): Promise<void> {
    await this.drive.trashFile(backup.folderId ?? backup.fileId);
    const state = await this.drive.loadRemoteState(this.settings.remoteFolderName, this.getVaultId());
    state.manifest.manualBackups = (state.manifest.manualBackups ?? []).filter((b) => b.id !== backup.id);
    await this.drive.saveManifest(state);
  }


  showAuthExportModal() {
    const auth = this.getStoredAuth();
    if (!auth) {
      new Notice("Connect Google Drive first.");
      return;
    }
    new AuthExportModal(this.app, auth).open();
  }

  async handleAuthImport(rawPayload: string) {
    let payload;
    try {
      payload = decodeTransferPayload(rawPayload);
    } catch {
      new Notice("Invalid QR code payload.");
      return;
    }
    const auth = await showAuthImportModal(this.app, payload);
    if (!auth) return;
    this.auth.setAuth(auth);
    await this.savePluginData({ auth });
    await this.refreshAccountLabel();
    new Notice("Google Drive credentials imported successfully.");
    this.onConnectionChange?.();
    await this.promptForInitialSyncIfNeeded();
  }


  async markDisconnected() {
    this.pluginData.auth = undefined;
    this.auth?.setAuth(undefined);
    this.accountLabel = undefined;
    await this.savePluginData({ auth: undefined });
  }

  async syncNow(manual = false) {
    if (this.syncRunning || this.syncEngine?.isRunning()) {
      await this.appendSyncLog("sync-skipped-already-running", { manual, syncRunning: this.syncRunning, engineRunning: this.syncEngine?.isRunning() });
      if (manual) new Notice("Google Drive sync is already running.");
      return;
    }
    if (!this.getStoredAuth()) {
      await this.appendSyncLog("sync-skipped-disconnected", { manual });
      if (manual) new Notice("Connect Google Drive before syncing.");
      await this.setSyncStatus({ state: "disconnected" });
      return;
    }
    if (!this.isInitialSyncCompleted()) {
      await this.appendSyncLog("sync-skipped-initial-sync-incomplete", { manual });
      if (manual) new Notice("Choose first sync direction before syncing.");
      this.onConnectionChange?.();
      return;
    }
    const startedAt = Date.now();
    this.syncRunning = true;
    this.ignoreVaultEventsUntil = Date.now() + 5000;
    await this.appendSyncLog("sync-start", {
      manual,
      dirtyCount: this.dirtyPaths.size,
      startupSyncRunning: this.startupSyncRunning,
      normalUploadUnlocked: this.normalUploadUnlocked
    });
    await this.setSyncStatus({ state: "syncing", lastStartedAt: startedAt, lastError: undefined });
    try {
      this.log("Starting sync", { dirtyCount: this.dirtyPaths.size });
      this.dirtyPaths.clear();
      const summary = await this.syncEngine.syncNow(manual);
      if (summary) await this.recordSyncSuccess(summary);
      await this.appendSyncLog("sync-finished", summary);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Google Drive sync failed.");
      this.log("Sync failed", error instanceof Error ? error.message : String(error));
      await this.appendSyncLog("sync-error", this.errorDetails(error));
      await this.recordSyncError(error);
    } finally {
      this.ignoreVaultEventsUntil = Date.now() + 5000;
      this.syncRunning = false;
      await this.appendSyncLog("sync-unlocked", { ignoreVaultEventsUntil: this.ignoreVaultEventsUntil });
    }
  }

  async safeStartupSync() {
    if (this.startupSyncRunning) return;
    this.startupSyncRunning = true;
    this.normalUploadUnlocked = false;
    await this.appendSyncLog("startup-sync-start");
    try {
      await this.syncNow(false);
      await this.rememberCurrentRemoteMarkers();
      this.normalUploadUnlocked = true;
      await this.appendSyncLog("startup-sync-finished");
    } catch (error) {
      await this.appendSyncLog("startup-sync-error", this.errorDetails(error));
      throw error;
    } finally {
      this.startupSyncRunning = false;
      this.configureTimers();
      await this.appendSyncLog("startup-sync-unlocked");
    }
  }

  async openDailyNoteSafely() {
    if (!this.getStoredAuth()) {
      new Notice("Connect Google Drive before opening the daily note safely.");
      return;
    }
    if (this.isInitialSyncCompleted()) await this.syncNow(false);
    const path = `${moment().format("YYYY-MM-DD")}.md`;
    const file = this.app.vault.getAbstractFileByPath(path);
    const target = file instanceof TFile ? file : await this.app.vault.create(path, "");
    await this.app.workspace.getLeaf(false).openFile(target);
  }

  async resetCloudFromLocal() {
    await this.requireConnectedForDangerAction();
    await this.setSyncStatus({ state: "syncing", lastStartedAt: Date.now(), lastError: undefined });
    try {
      const summary = await this.syncEngine.resetCloudFromLocal();
      await this.recordSyncSuccess(summary);
      await this.markInitialSyncCompleted();
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
      await this.markInitialSyncCompleted();
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
    if (this.settings.fullSyncFallbackEnabled && this.isInitialSyncCompleted()) {
      const intervalMs = Math.max(1, this.settings.syncIntervalMinutes) * 60 * 1000;
      this.syncTimer = window.setInterval(() => void this.syncNow(), intervalMs);
    }
    if (this.settings.cloudWatchEnabled && this.isInitialSyncCompleted()) {
      const intervalMs = Math.max(10, this.settings.cloudWatchIntervalSeconds) * 1000;
      this.cloudWatchTimer = window.setInterval(() => void this.checkCloudForChanges(), intervalMs);
    }
  }

  async checkCloudForChanges() {
    if (
      this.cloudWatchRunning ||
      this.startupSyncRunning ||
      this.syncRunning ||
      this.syncEngine.isRunning() ||
      !this.normalUploadUnlocked ||
      !this.getStoredAuth() ||
      !this.isInitialSyncCompleted()
    ) {
      if (Date.now() - this.lastCloudWatchSkipLogAt > 60000) {
        this.lastCloudWatchSkipLogAt = Date.now();
        await this.appendSyncLog("cloud-watch-skipped", {
          cloudWatchRunning: this.cloudWatchRunning,
          startupSyncRunning: this.startupSyncRunning,
          syncRunning: this.syncRunning,
          engineRunning: this.syncEngine.isRunning(),
          normalUploadUnlocked: this.normalUploadUnlocked,
          connected: this.getStoredAuth() !== undefined,
          initialSyncCompleted: this.isInitialSyncCompleted()
        });
      }
      return;
    }
    this.cloudWatchRunning = true;
    try {
      const manifest = await this.drive.loadRemoteManifest(this.settings.remoteFolderName);
      if (!manifest) {
        await this.appendSyncLog("cloud-watch-no-manifest");
        return;
      }
      const commandId = manifest.command?.id;
      const hasNewCommand = commandId !== undefined && commandId !== this.pluginData.lastRemoteCommandId;
      const hasRemoteUpdate = manifest.updatedAt !== undefined && manifest.updatedAt !== this.pluginData.lastRemoteUpdatedAt;
      await this.appendSyncLog("cloud-watch-checked", {
        updatedAt: manifest.updatedAt,
        previousUpdatedAt: this.pluginData.lastRemoteUpdatedAt,
        commandId,
        previousCommandId: this.pluginData.lastRemoteCommandId,
        hasNewCommand,
        hasRemoteUpdate
      });
      await this.savePluginData({
        lastRemoteUpdatedAt: manifest.updatedAt,
        lastRemoteCommandId: commandId
      });
      if (hasNewCommand || hasRemoteUpdate) {
        this.log("Cloud watch detected remote change", { updatedAt: manifest.updatedAt, commandId });
        await this.appendSyncLog("cloud-watch-trigger-sync", { hasNewCommand, hasRemoteUpdate });
        await this.syncNow();
      }
    } catch (error) {
      this.log("Cloud watch failed", error instanceof Error ? error.message : String(error));
      await this.appendSyncLog("cloud-watch-error", this.errorDetails(error));
    } finally {
      this.cloudWatchRunning = false;
    }
  }

  private registerCommands() {
    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      icon: "refresh-cw",
      callback: () => void this.syncNow(true)
    });
    this.addCommand({
      id: "sync-now-mobile",
      name: "Sync now",
      icon: "refresh-cw",
      mobileOnly: true,
      callback: () => void this.syncNow(true)
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
      id: "open-daily-note-safely",
      name: "Open Daily Note Safely",
      icon: "calendar-check",
      callback: () => void this.openDailyNoteSafely()
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
      if (this.shouldIgnoreVaultEvent(file?.path)) {
        void this.appendSyncLog("vault-event-ignored", { path: file?.path, syncRunning: this.syncRunning, startupSyncRunning: this.startupSyncRunning });
        return;
      }
      if (file?.path) this.dirtyPaths.add(file.path);
      if (!this.settings.autoSyncEnabled || !this.getStoredAuth() || !this.isInitialSyncCompleted()) return;
      if (!this.normalUploadUnlocked) return;
      if (this.syncEngine.isRunning()) return;
      if (this.debounceTimer !== undefined) window.clearTimeout(this.debounceTimer);
      const delayMs = Math.max(0, this.settings.syncDebounceSeconds) * 1000;
      void this.appendSyncLog("vault-event-schedule-sync", { path: file?.path, delayMs });
      this.debounceTimer = window.setTimeout(() => void this.syncNow(), delayMs);
    };
    this.registerEvent(this.app.vault.on("create", schedule));
    this.registerEvent(this.app.vault.on("modify", schedule));
    this.registerEvent(this.app.vault.on("delete", schedule));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (this.shouldIgnoreVaultEvent(oldPath) && this.shouldIgnoreVaultEvent(file.path)) return;
      this.dirtyPaths.add(oldPath);
      schedule(file);
    }));
  }

  private shouldIgnoreVaultEvent(path?: string): boolean {
    if (!path) return this.syncRunning || this.startupSyncRunning || Date.now() < this.ignoreVaultEventsUntil;
    const ignored = ignoredPatternsFromSettings(this.settings.ignoredPaths);
    return this.syncRunning
      || this.startupSyncRunning
      || Date.now() < this.ignoreVaultEventsUntil
      || path.startsWith(".sync/")
      || path.startsWith(".trash/")
      || path.startsWith(`${this.app.vault.configDir}/plugins/google-drive-vault-sync/`)
      || isIgnored(path, ignored);
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

  isInitialSyncCompleted(): boolean {
    return this.pluginData.initialSyncCompleted === true;
  }

  async promptForInitialSyncIfNeeded() {
    if (!this.getStoredAuth() || this.isInitialSyncCompleted()) return;
    const direction = await chooseInitialSyncDirection(this.app);
    if (!direction) {
      new Notice("First sync paused. Choose a direction in Google Drive Vault Sync settings.");
      this.onConnectionChange?.();
      return;
    }
    await this.runInitialSync(direction);
  }

  async runInitialSync(direction: InitialSyncDirection) {
    if (!this.getStoredAuth()) {
      new Notice("Connect Google Drive before syncing.");
      await this.setSyncStatus({ state: "disconnected" });
      return;
    }
    if (this.isInitialSyncCompleted()) {
      new Notice("First sync is already complete on this device.");
      return;
    }
    if (direction === "local-to-cloud") {
      await this.resetCloudFromLocal();
      return;
    }
    await this.resetLocalFromCloud([]);
  }

  private async markInitialSyncCompleted() {
    if (this.pluginData.initialSyncCompleted) return;
    await this.savePluginData({ initialSyncCompleted: true });
    this.configureTimers();
    this.onConnectionChange?.();
  }

  private async setSyncStatus(status: SyncStatus) {
    await this.savePluginData({ syncStatus: status });
    this.updateStatusBar();
    this.onConnectionChange?.();
  }

  private updateStatusBar() {
    const state = this.pluginData.syncStatus?.state ?? (this.getStoredAuth() ? "idle" : "disconnected");
    const iconName =
      state === "syncing" ? "refresh-cw" :
      state === "error" ? "alert-circle" :
      state === "disconnected" ? "cloud-off" :
      "cloud";
    const label =
      state === "syncing" ? "Google Drive: syncing…" :
      state === "error" ? "Google Drive: sync error — click to retry" :
      state === "disconnected" ? "Google Drive: not connected" :
      "Google Drive: click to sync";
    if (this.statusBarEl) {
      this.statusBarEl.empty();
      setIcon(this.statusBarEl, iconName);
      this.statusBarEl.setAttribute("aria-label", label);
    }
    if (this.ribbonEl) {
      setIcon(this.ribbonEl, iconName);
      this.ribbonEl.setAttribute("aria-label", label);
    }
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
      await this.appendSyncLog("remote-markers-remembered", {
        updatedAt: manifest?.updatedAt,
        commandId: manifest?.command?.id
      });
    } catch (error) {
      this.log("Could not refresh cloud watch marker", error instanceof Error ? error.message : String(error));
      await this.appendSyncLog("remote-markers-error", this.errorDetails(error));
    }
  }

  private async appendSyncLog(message: string, details?: unknown): Promise<void> {
    const detailsText = details === undefined ? "" : ` ${sanitizeLogValue(details)}`;
    const line = `${new Date().toISOString()} [${this.logSessionId}] ${message}${detailsText}\n`;
    try {
      await this.app.vault.adapter.mkdir(".sync").catch(() => undefined);
      let existing = "";
      try {
        existing = await this.app.vault.adapter.read(LOCAL_SYNC_LOG_PATH);
      } catch {
        existing = "";
      }
      let next = `${existing}${line}`;
      if (new TextEncoder().encode(next).byteLength > MAX_LOCAL_SYNC_LOG_BYTES) {
        next = next.slice(-MAX_LOCAL_SYNC_LOG_BYTES);
        const firstLine = next.indexOf("\n");
        if (firstLine >= 0) next = next.slice(firstLine + 1);
        next = `${new Date().toISOString()} [${this.logSessionId}] log-truncated\n${next}`;
      }
      await this.app.vault.adapter.write(LOCAL_SYNC_LOG_PATH, next);
    } catch (error) {
      console.warn("[Google Drive Sync] Could not write local sync log", error);
    }
  }

  private errorDetails(error: unknown): Record<string, string | undefined> {
    return {
      name: error instanceof Error ? error.name : undefined,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    };
  }
}
