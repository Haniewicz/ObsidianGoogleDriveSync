import { Modal, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import { runGoogleNetworkDiagnostics } from "./auth";
import GoogleDriveSyncPlugin from "./main";
import { requestManualBackupName, showBackupRestoreModal } from "./modals";

export class GoogleDriveSyncSettingTab extends PluginSettingTab {
  constructor(private plugin: GoogleDriveSyncPlugin) {
    super(plugin.app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    this.plugin.onConnectionChange = () => undefined;
    containerEl.empty();

    const connected = this.plugin.getStoredAuth() !== undefined;
    this.renderStatus(containerEl, connected);

    new Setting(containerEl).setName("Setup").setHeading();
    new Setting(containerEl)
      .setName("Google Drive connection")
      .setDesc(connected ? this.plugin.accountLabel || "Connected" : "Not connected")
      .addButton((button) => button.setButtonText("Open").onClick(() => this.openConnectionModal()));

    this.renderFirstSync(containerEl, connected);

    new Setting(containerEl)
      .setName("Sync behavior")
      .setDesc("Auto sync, cloud watch, conflict policy, and sync timing.")
      .addButton((button) => button.setButtonText("Open").onClick(() => this.openSyncSettingsModal()));

    this.renderBackups(containerEl, connected);

    new Setting(containerEl).setName("Advanced").setHeading();
    new Setting(containerEl)
      .setName("Advanced settings")
      .setDesc("Remote folder, ignored paths, deletion guard, concurrency, diagnostics, and debug logging.")
      .addButton((button) => button.setButtonText("Open").onClick(() => this.openAdvancedSettingsModal()));

    this.renderDangerZone(containerEl, connected);
  }

  private renderStatus(containerEl: HTMLElement, connected: boolean) {
    const status = this.plugin.pluginData.syncStatus;
    new Setting(containerEl).setName("Sync status").setHeading();
    const state = status?.state ?? (connected ? "idle" : "disconnected");
    const lastSync = status?.lastFinishedAt ? new Date(status.lastFinishedAt).toLocaleString() : "never";
    new Setting(containerEl)
      .setName(state)
      .setDesc(`Last sync: ${lastSync}${status?.lastError ? " · Last error available" : ""}`)
      .addButton((button) => button.setButtonText("Sync now").setDisabled(!connected || !this.plugin.isInitialSyncCompleted()).onClick(() => this.plugin.syncNow(true)))
      .addButton((button) => button.setButtonText("Details").onClick(() => this.openSyncStatusModal(connected)));
  }

  private renderFirstSync(containerEl: HTMLElement, connected: boolean) {
    if (!connected || this.plugin.isInitialSyncCompleted()) return;
    new Setting(containerEl).setName("First sync").setHeading();
    containerEl.createEl("p", {
      text: "Choose the first sync direction for this device. Automatic sync is paused until one option completes.",
      cls: "obsidian-google-sync-status-row"
    });
    new Setting(containerEl)
      .setName("Cloud to local")
      .setDesc("Replace this local vault with the current Google Drive sync state.")
      .addButton((button) => button.setButtonText("Use cloud").setCta().onClick(async () => {
        try {
          await this.plugin.runInitialSync("cloud-to-local");
          this.display();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "First sync failed.");
        }
      }));
    new Setting(containerEl)
      .setName("Local to cloud")
      .setDesc("Replace the Google Drive sync state with this local vault.")
      .addButton((button) => button.setButtonText("Use local").setWarning().onClick(async () => {
        try {
          await this.plugin.runInitialSync("local-to-cloud");
          this.display();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "First sync failed.");
        }
      }));
  }

  private openSyncStatusModal(connected: boolean) {
    const modal = new Modal(this.plugin.app);
    const render = () => {
      const status = this.plugin.pluginData.syncStatus;
      const summary = status?.lastSummary;
      modal.contentEl.empty();
      modal.titleEl.setText("Sync status");
      const rows = [
        `State: ${status?.state ?? (connected ? "idle" : "disconnected")}`,
        connected && !this.plugin.isInitialSyncCompleted() ? "First sync: waiting for direction" : undefined,
        `Device: ${this.plugin.settings.deviceName || "Unnamed"}`,
        `Account: ${this.plugin.accountLabel || (connected ? "Connected" : "Not connected")}`,
        status?.lastStartedAt ? `Last started: ${new Date(status.lastStartedAt).toLocaleString()}` : undefined,
        status?.lastFinishedAt ? `Last finished: ${new Date(status.lastFinishedAt).toLocaleString()}` : "Last sync: never",
        status?.lastDurationMs !== undefined ? `Duration: ${(status.lastDurationMs / 1000).toFixed(1)}s` : undefined,
        summary ? `Summary: ${summary.uploads} uploads, ${summary.downloads} downloads, ${summary.localDeletes} local deletes, ${summary.remoteDeletes} remote deletes, ${summary.conflicts} conflicts, ${summary.errors} errors` : undefined,
        summary?.command ? `Command: ${summary.command}` : undefined,
        `Remote reset commands applied: ${this.plugin.pluginData.appliedCommandIds?.length ?? 0}`,
        status?.lastError ? `Last error: ${status.lastError}` : undefined
      ].filter(Boolean) as string[];
      for (const row of rows) modal.contentEl.createEl("p", { text: row, cls: "obsidian-google-sync-status-row" });
      new Setting(modal.contentEl)
        .addButton((button) => button.setButtonText("Sync now").setDisabled(!connected || !this.plugin.isInitialSyncCompleted()).onClick(() => this.plugin.syncNow(true)))
        .addButton((button) => button.setButtonText("Refresh").onClick(render))
        .addButton((button) => button.setButtonText("Clear last error").setDisabled(!status?.lastError).onClick(async () => {
          await this.plugin.savePluginData({ syncStatus: { ...(this.plugin.pluginData.syncStatus ?? { state: connected ? "idle" : "disconnected" }), lastError: undefined } });
          render();
        }))
        .addButton((button) => button.setButtonText("Close").onClick(() => modal.close()));
    };
    modal.onClose = () => modal.contentEl.empty();
    render();
    modal.open();
  }

  private openConnectionModal() {
    const modal = new Modal(this.plugin.app);
    const { contentEl } = modal;
    const connected = this.plugin.getStoredAuth() !== undefined;
    modal.titleEl.setText("Google Drive connection");

    new Setting(contentEl)
      .setName("Device name")
      .setDesc("Shown in reset commands and sync status.")
      .addText((text) => text
        .setPlaceholder("This device")
        .setValue(this.plugin.settings.deviceName)
        .onChange(async (value) => {
          this.plugin.settings.deviceName = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(contentEl)
      .setName("Connected status")
      .setDesc(connected ? this.plugin.accountLabel || "Connected" : "Not connected");

    new Setting(contentEl)
      .setName("OAuth client ID")
      .setDesc("Use a Google OAuth client for TVs and limited-input devices when available.")
      .addText((text) => text
        .setPlaceholder("Google OAuth client ID")
        .setValue(this.plugin.settings.clientId)
        .onChange(async (value) => {
          this.plugin.settings.clientId = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(contentEl)
      .setName("OAuth client secret")
      .setDesc("Required by Google's device authorization token endpoint. Store it only in vaults you trust.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Google OAuth client secret")
          .setValue(this.plugin.settings.clientSecret)
          .onChange(async (value) => {
            this.plugin.settings.clientSecret = value.trim();
            await this.plugin.saveSettings();
          });
      });

    const helpEl = contentEl.createEl("details", { cls: "obsidian-google-sync-oauth-help" });
    helpEl.createEl("summary", { text: "How to get a Google OAuth client ID" });
    const listEl = helpEl.createEl("ol");
    [
      "Open Google Cloud Console and create or select a project.",
      "Enable Google Drive API in APIs & Services > Library.",
      "Configure APIs & Services > OAuth consent screen and add your Google account as a test user if the app is in testing.",
      "Open APIs & Services > Credentials.",
      "Choose Create credentials > OAuth client ID.",
      "Select TVs and Limited Input devices as the application type. Do not choose Web application.",
      "Open the created OAuth client.",
      "Copy the Client ID into the Client ID field above.",
      "In Client secrets, add or rotate a secret if needed, then copy it into the Client secret field above."
    ].forEach((step) => listEl.createEl("li", { text: step }));
    helpEl.createEl("p", { text: "Required scope: https://www.googleapis.com/auth/drive.file" });

    new Setting(contentEl)
      .setName("Connect Google Drive")
      .setDesc("Starts Google OAuth device authorization.")
      .addButton((button) => button.setButtonText("Connect").setCta().onClick(async () => {
        try {
          await this.plugin.connectGoogleDrive();
          modal.close();
          this.display();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "Could not connect Google Drive.");
        }
      }));

    if (connected) {
      new Setting(contentEl)
        .setName("Transfer to another device")
        .setDesc("Generate a QR code to import Google Drive credentials on another device.")
        .addButton((button) => button.setButtonText("Show QR code").onClick(() => this.plugin.showAuthExportModal()));
    }

    new Setting(contentEl)
      .setName("Disconnect")
      .setDesc("Deletes stored Google auth data from plugin storage.")
      .addButton((button) => button.setButtonText("Disconnect").setWarning().setDisabled(!connected).onClick(async () => {
        await this.plugin.disconnectGoogleDrive();
        modal.close();
        this.display();
      }));

    modal.onClose = () => modal.contentEl.empty();
    modal.open();
  }

  private openSyncSettingsModal() {
    const modal = new Modal(this.plugin.app);
    const { contentEl } = modal;
    modal.titleEl.setText("Sync behavior");

    new Setting(contentEl)
      .setName("Auto sync local changes")
      .setDesc("Starts sync after local vault changes with the edit delay below.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.autoSyncEnabled).onChange(async (value) => {
        this.plugin.settings.autoSyncEnabled = value;
        await this.plugin.saveSettings();
        this.plugin.configureTimers();
      }));

    new Setting(contentEl)
      .setName("Sync on startup")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async (value) => {
        this.plugin.settings.syncOnStartup = value;
        await this.plugin.saveSettings();
      }));

    new Setting(contentEl)
      .setName("Full sync fallback")
      .setDesc("Runs a full sync periodically as a safety net. Cloud watch handles faster remote change detection.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.fullSyncFallbackEnabled).onChange(async (value) => {
        this.plugin.settings.fullSyncFallbackEnabled = value;
        await this.plugin.saveSettings();
        this.plugin.configureTimers();
      }));

    new Setting(contentEl)
      .setName("Full sync fallback interval minutes")
      .addText((text) => text.setValue(String(this.plugin.settings.syncIntervalMinutes)).onChange(async (value) => {
        this.plugin.settings.syncIntervalMinutes = Math.max(1, Number.parseInt(value, 10) || 30);
        await this.plugin.saveSettings();
        this.plugin.configureTimers();
      }));

    new Setting(contentEl)
      .setName("Cloud watch")
      .setDesc("Lightweight remote manifest polling. Starts full sync only when cloud changes are detected.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.cloudWatchEnabled).onChange(async (value) => {
        this.plugin.settings.cloudWatchEnabled = value;
        await this.plugin.saveSettings();
        this.plugin.configureTimers();
      }));

    new Setting(contentEl)
      .setName("Cloud watch interval seconds")
      .setDesc("Minimum 10 seconds. 30-60 seconds is usually enough for a few devices.")
      .addText((text) => text.setValue(String(this.plugin.settings.cloudWatchIntervalSeconds)).onChange(async (value) => {
        this.plugin.settings.cloudWatchIntervalSeconds = Math.max(10, Number.parseInt(value, 10) || 30);
        await this.plugin.saveSettings();
        this.plugin.configureTimers();
      }));

    new Setting(contentEl)
      .setName("Sync delay after edits")
      .setDesc("Seconds to wait after a vault change before auto sync starts.")
      .addText((text) => text.setValue(String(this.plugin.settings.syncDebounceSeconds)).onChange(async (value) => {
        this.plugin.settings.syncDebounceSeconds = Math.max(0, Number.parseInt(value, 10) || 0);
        await this.plugin.saveSettings();
      }));

    new Setting(contentEl)
      .setName("Conflict policy")
      .setDesc("Used only when both local and cloud versions changed since the last sync.")
      .addDropdown((dropdown) => dropdown
        .addOption("keep-both", "Keep both copies")
        .addOption("prefer-local", "Prefer local")
        .addOption("prefer-remote", "Prefer Google Drive")
        .setValue(this.plugin.settings.conflictPolicy)
        .onChange(async (value) => {
          this.plugin.settings.conflictPolicy = value as typeof this.plugin.settings.conflictPolicy;
          await this.plugin.saveSettings();
        }));

    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Close").onClick(() => modal.close()));
    modal.onClose = () => modal.contentEl.empty();
    modal.open();
  }

  private renderDiagnostics(containerEl: HTMLElement) {
    new Setting(containerEl).setName("Connection diagnostics").setHeading();
    const resultEl = containerEl.createDiv("obsidian-google-sync-diagnostics");
    resultEl.setText("Run diagnostics to check whether this device can reach Google OAuth and Drive endpoints.");
    new Setting(containerEl)
      .setName("Google network diagnostics")
      .setDesc("HTTP 400/401 responses still mean the device reached Google. Network or DNS errors point to the mobile connection layer.")
      .addButton((button) => button.setButtonText("Run diagnostics").onClick(async () => {
        button.setDisabled(true);
        button.setButtonText("Running...");
        resultEl.setText("Running diagnostics...");
        try {
          const results = await runGoogleNetworkDiagnostics(this.plugin.settings.clientId, this.plugin.settings.clientSecret);
          resultEl.empty();
          for (const result of results) {
            const itemEl = resultEl.createDiv("obsidian-google-sync-diagnostic-item");
            itemEl.createEl("strong", { text: result.name });
            itemEl.createEl("p", { text: `${result.method} ${result.url}` });
            if (result.reachable) {
              const status = result.ok
                ? "success"
                : result.expectedErrorResponse
                  ? "reachable with expected diagnostic response"
                  : "reachable with Google error response";
              itemEl.createEl("p", { text: `Result: ${status}; HTTP ${result.status}; ${result.durationMs}ms` });
              if (result.note) itemEl.createEl("p", { text: result.note });
              if (result.responseError) itemEl.createEl("p", { text: `Google error: ${result.responseError}` });
              if (result.responseDescription) itemEl.createEl("p", { text: `Description: ${result.responseDescription}` });
              if (result.responsePreview) itemEl.createEl("pre", { text: result.responsePreview });
            } else {
              itemEl.createEl("p", { text: `Result: network error; ${result.durationMs}ms` });
              itemEl.createEl("p", { text: result.error ?? "Unknown error" });
            }
          }
          const networkFailures = results.filter((result) => !result.reachable).length;
          new Notice(networkFailures === 0 ? "Google endpoints are reachable." : `Google network diagnostics found ${networkFailures} network issue${networkFailures === 1 ? "" : "s"}.`);
        } catch (error) {
          resultEl.setText(error instanceof Error ? error.message : "Diagnostics failed.");
        } finally {
          button.setDisabled(false);
          button.setButtonText("Run diagnostics");
        }
      }));
  }

  private openAdvancedSettingsModal() {
    const modal = new Modal(this.plugin.app);
    const { contentEl } = modal;
    modal.titleEl.setText("Advanced settings");

    new Setting(contentEl)
      .setName("Remote folder name")
      .addText((text) => text.setValue(this.plugin.settings.remoteFolderName).onChange(async (value) => {
        this.plugin.settings.remoteFolderName = value.trim() || "ObsidianGoogleDriveSync";
        await this.plugin.saveSettings();
      }));

    new Setting(contentEl)
      .setName("Request concurrency")
      .addText((text) => text.setValue(String(this.plugin.settings.requestConcurrency)).onChange(async (value) => {
        this.plugin.settings.requestConcurrency = Math.max(1, Number.parseInt(value, 10) || 2);
        this.plugin.queue.setConcurrency(this.plugin.settings.requestConcurrency);
        await this.plugin.saveSettings();
      }));

    new Setting(contentEl)
      .setName("Max deletion percent")
      .addText((text) => text.setValue(String(this.plugin.settings.maxDeletionPercent)).onChange(async (value) => {
        this.plugin.settings.maxDeletionPercent = Math.max(0, Number.parseInt(value, 10) || 20);
        await this.plugin.saveSettings();
      }));

    new Setting(contentEl)
      .setName("Ignored paths")
      .setDesc("One vault-relative path or folder prefix per line.")
      .addTextArea((text) => {
        text.inputEl.rows = 8;
        text.inputEl.cols = 40;
        text.setValue(this.plugin.settings.ignoredPaths).onChange(async (value) => {
          this.plugin.settings.ignoredPaths = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(contentEl)
      .setName("Debug mode")
      .setDesc("Never logs tokens, codes, or note contents.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.debugMode).onChange(async (value) => {
        this.plugin.settings.debugMode = value;
        await this.plugin.saveSettings();
      }));

    this.renderDiagnostics(contentEl);
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Close").onClick(() => modal.close()));
    modal.onClose = () => modal.contentEl.empty();
    modal.open();
  }

  private renderBackups(containerEl: HTMLElement, connected: boolean) {
    new Setting(containerEl).setName("Backups").setHeading();

    new Setting(containerEl)
      .setName("Backups enabled")
      .setDesc("Create Google Drive backups before sync actions that can overwrite or remove files.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.backupEnabled).onChange(async (value) => {
        this.plugin.settings.backupEnabled = value;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Backup mode")
      .setDesc("Safety only backs up risky changes. Timed also backs up routine local edits at most once per interval. Every sync keeps the most history.")
      .addDropdown((dropdown) => dropdown
        .addOption("safety-only", "Safety only")
        .addOption("timed", "Timed")
        .addOption("every-sync", "Every sync")
        .setValue(this.plugin.settings.backupMode)
        .onChange(async (value) => {
          this.plugin.settings.backupMode = value as typeof this.plugin.settings.backupMode;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Routine backup interval")
      .setDesc("Minimum minutes between routine backups when Backup mode is Timed. Safety backups ignore this interval.")
      .addText((text) => text.setValue(String(this.plugin.settings.backupIntervalMinutes)).onChange(async (value) => {
        this.plugin.settings.backupIntervalMinutes = Math.max(1, parseInt(value, 10) || 30);
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Backups to keep")
      .setDesc("Maximum number of backups stored on Google Drive. Oldest are deleted automatically.")
      .addText((text) => text.setValue(String(this.plugin.settings.maxBackups)).onChange(async (value) => {
        this.plugin.settings.maxBackups = Math.max(1, parseInt(value, 10) || 10);
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Manual full backup")
      .setDesc("Create a named full backup in separate storage. Manual backups are deleted only when you delete them.")
      .addButton((btn) => btn.setButtonText("Create manual backup").setCta().setDisabled(!connected).onClick(async () => {
        const label = await requestManualBackupName(this.plugin.app);
        if (!label) return;
        try {
          btn.setDisabled(true);
          btn.setButtonText("Creating...");
          await this.plugin.createManualBackup(label);
          this.display();
        } catch (error) {
          btn.setDisabled(false);
          btn.setButtonText("Create manual backup");
          new Notice(error instanceof Error ? error.message : "Manual backup failed.");
        }
      }));

    new Setting(containerEl).setName("Manual backups").setHeading();
    this.renderManualBackups(containerEl, connected);

    new Setting(containerEl).setName("Automatic backups").setHeading();
    const listEl = containerEl.createDiv("obsidian-google-sync-backup-list");
    listEl.setText(connected ? "Loading backups…" : "Connect Google Drive to manage backups.");
    if (!connected) return;

    void this.plugin.getBackups().then((backups) => {
      listEl.empty();
      if (backups.length === 0) {
        listEl.setText("No backups yet.");
        return;
      }
      for (const backup of backups) {
        new Setting(listEl)
          .setName(new Date(backup.createdAt).toLocaleString())
          .setDesc(`${backup.deviceName} — ${backup.changedCount} changed, ${backup.deletedCount} deleted`)
          .addButton((btn) => btn.setButtonText("Preview & Restore").onClick(async () => {
            try {
              btn.setDisabled(true);
              btn.setButtonText("Loading…");
              const data = await this.plugin.drive.loadBackupData(backup.fileId);
              btn.setDisabled(false);
              btn.setButtonText("Preview & Restore");
              const confirmed = await showBackupRestoreModal(
                this.plugin.app,
                backup,
                data,
                (fileId) => this.plugin.drive.downloadFile(fileId)
              );
              if (!confirmed) return;
              if (confirmed.type === "file") {
                await this.plugin.restoreFileFromBackup(backup, confirmed.path);
              } else {
                await this.plugin.restoreFromBackup(backup);
              }
              this.display();
            } catch (error) {
              btn.setDisabled(false);
              btn.setButtonText("Preview & Restore");
              new Notice(error instanceof Error ? error.message : "Restore failed.");
            }
          }))
          .addButton((btn) => btn.setButtonText("Delete").setWarning().onClick(async () => {
            try {
              await this.plugin.deleteBackup(backup);
              this.display();
            } catch (error) {
              new Notice(error instanceof Error ? error.message : "Delete failed.");
            }
          }));
      }
    }).catch((error) => {
      listEl.setText(error instanceof Error ? error.message : "Could not load backups.");
    });
  }

  private renderManualBackups(containerEl: HTMLElement, connected: boolean) {
    const listEl = containerEl.createDiv("obsidian-google-sync-backup-list");
    listEl.setText(connected ? "Loading manual backups…" : "Connect Google Drive to manage manual backups.");
    if (!connected) return;

    void this.plugin.getManualBackups().then((backups) => {
      listEl.empty();
      if (backups.length === 0) {
        listEl.setText("No manual backups yet.");
        return;
      }
      for (const backup of backups) {
        new Setting(listEl)
          .setName(backup.label || new Date(backup.createdAt).toLocaleString())
          .setDesc(`${new Date(backup.createdAt).toLocaleString()} — ${backup.deviceName} — ${backup.changedCount} files`)
          .addButton((btn) => btn.setButtonText("Preview & Restore").onClick(async () => {
            try {
              btn.setDisabled(true);
              btn.setButtonText("Loading…");
              const data = await this.plugin.drive.loadBackupData(backup.fileId);
              btn.setDisabled(false);
              btn.setButtonText("Preview & Restore");
              const confirmed = await showBackupRestoreModal(
                this.plugin.app,
                backup,
                data,
                (fileId) => this.plugin.drive.downloadFile(fileId)
              );
              if (!confirmed) return;
              if (confirmed.type === "file") {
                await this.plugin.restoreFileFromBackup(backup, confirmed.path);
              } else {
                await this.plugin.restoreFromBackup(backup);
              }
              this.display();
            } catch (error) {
              btn.setDisabled(false);
              btn.setButtonText("Preview & Restore");
              new Notice(error instanceof Error ? error.message : "Restore failed.");
            }
          }))
          .addButton((btn) => btn.setButtonText("Delete").setWarning().onClick(async () => {
            try {
              await this.plugin.deleteManualBackup(backup);
              this.display();
            } catch (error) {
              new Notice(error instanceof Error ? error.message : "Delete failed.");
            }
          }));
      }
    }).catch((error) => {
      listEl.setText(error instanceof Error ? error.message : "Could not load manual backups.");
    });
  }

  private renderDangerZone(containerEl: HTMLElement, connected: boolean) {
    new Setting(containerEl).setName("Danger zone").setHeading();
    new Setting(containerEl)
      .setName("Reset cloud from this vault")
      .setDesc("Move existing synced Drive files to trash, upload this vault, and command other devices to replace local data from cloud.")
      .addButton((button) => button.setButtonText("Reset cloud").setWarning().setDisabled(!connected).onClick(async () => {
        try {
          await this.plugin.confirmAndResetCloudFromLocal();
          this.display();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "Cloud reset failed.");
        }
      }));
    new Setting(containerEl)
      .setName("Reset this vault from cloud")
      .setDesc("Overwrite this vault from Google Drive, with a per-file choice for local-only files.")
      .addButton((button) => button.setButtonText("Reset local").setWarning().setDisabled(!connected).onClick(async () => {
        try {
          await this.plugin.confirmAndResetLocalFromCloud();
          this.display();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "Local reset failed.");
        }
      }));
  }
}
