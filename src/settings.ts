import { Notice, PluginSettingTab, Setting } from "obsidian";
import GoogleDriveSyncPlugin from "./main";

export class GoogleDriveSyncSettingTab extends PluginSettingTab {
  constructor(private plugin: GoogleDriveSyncPlugin) {
    super(plugin.app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    this.plugin.onConnectionChange = () => this.display();
    containerEl.empty();

    const connected = this.plugin.getStoredAuth() !== undefined;
    const initialSyncCompleted = this.plugin.isInitialSyncCompleted();
    this.renderStatus(containerEl, connected);

    new Setting(containerEl)
      .setName("Device name")
      .setDesc("Shown in reset commands and sync status.")
      .addText((text) => text
        .setPlaceholder("This device")
        .setValue(this.plugin.settings.deviceName)
        .onChange(async (value) => {
          this.plugin.settings.deviceName = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Connected status")
      .setDesc(connected ? this.plugin.accountLabel || "Connected" : "Not connected")
      .addButton((button) => button.setButtonText("Sync now").setDisabled(!connected || !initialSyncCompleted).onClick(() => this.plugin.syncNow()));

    new Setting(containerEl)
      .setName("OAuth client ID")
      .setDesc("Use a Google OAuth client for TVs and limited-input devices when available.")
      .addText((text) => text
        .setPlaceholder("Google OAuth client ID")
        .setValue(this.plugin.settings.clientId)
        .onChange(async (value) => {
          this.plugin.settings.clientId = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
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

    const helpEl = containerEl.createEl("details", { cls: "obsidian-google-sync-oauth-help" });
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

    new Setting(containerEl)
      .setName("Connect Google Drive")
      .setDesc("Starts Google OAuth device authorization.")
      .addButton((button) => button.setButtonText("Connect Google Drive").setCta().onClick(async () => {
        try {
          await this.plugin.connectGoogleDrive();
          this.display();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "Could not connect Google Drive.");
        }
      }));

    this.renderFirstSync(containerEl, connected);

    new Setting(containerEl)
      .setName("Disconnect")
      .setDesc("Deletes stored Google auth data from plugin storage.")
      .addButton((button) => button.setButtonText("Disconnect").setWarning().setDisabled(!connected).onClick(async () => {
        await this.plugin.disconnectGoogleDrive();
        this.display();
      }));

    new Setting(containerEl)
      .setName("Remote folder name")
      .addText((text) => text.setValue(this.plugin.settings.remoteFolderName).onChange(async (value) => {
        this.plugin.settings.remoteFolderName = value.trim() || "ObsidianGoogleDriveSync";
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Auto sync local changes")
      .setDesc("Starts sync after local vault changes with the edit delay below.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.autoSyncEnabled).onChange(async (value) => {
        this.plugin.settings.autoSyncEnabled = value;
        await this.plugin.saveSettings();
        this.plugin.configureTimers();
      }));

    new Setting(containerEl)
      .setName("Sync on startup")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async (value) => {
        this.plugin.settings.syncOnStartup = value;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Full sync fallback")
      .setDesc("Runs a full sync periodically as a safety net. Cloud watch handles faster remote change detection.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.fullSyncFallbackEnabled).onChange(async (value) => {
        this.plugin.settings.fullSyncFallbackEnabled = value;
        await this.plugin.saveSettings();
        this.plugin.configureTimers();
      }));

    new Setting(containerEl)
      .setName("Full sync fallback interval minutes")
      .addText((text) => text.setValue(String(this.plugin.settings.syncIntervalMinutes)).onChange(async (value) => {
        this.plugin.settings.syncIntervalMinutes = Math.max(1, Number.parseInt(value, 10) || 30);
        await this.plugin.saveSettings();
        this.plugin.configureTimers();
      }));

    new Setting(containerEl)
      .setName("Cloud watch")
      .setDesc("Lightweight remote manifest polling. Starts full sync only when cloud changes are detected.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.cloudWatchEnabled).onChange(async (value) => {
        this.plugin.settings.cloudWatchEnabled = value;
        await this.plugin.saveSettings();
        this.plugin.configureTimers();
      }));

    new Setting(containerEl)
      .setName("Cloud watch interval seconds")
      .setDesc("Minimum 10 seconds. 30-60 seconds is usually enough for a few devices.")
      .addText((text) => text.setValue(String(this.plugin.settings.cloudWatchIntervalSeconds)).onChange(async (value) => {
        this.plugin.settings.cloudWatchIntervalSeconds = Math.max(10, Number.parseInt(value, 10) || 30);
        await this.plugin.saveSettings();
        this.plugin.configureTimers();
      }));

    new Setting(containerEl)
      .setName("Sync delay after edits")
      .setDesc("Seconds to wait after a vault change before auto sync starts.")
      .addText((text) => text.setValue(String(this.plugin.settings.syncDebounceSeconds)).onChange(async (value) => {
        this.plugin.settings.syncDebounceSeconds = Math.max(0, Number.parseInt(value, 10) || 0);
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
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

    new Setting(containerEl)
      .setName("Request concurrency")
      .addText((text) => text.setValue(String(this.plugin.settings.requestConcurrency)).onChange(async (value) => {
        this.plugin.settings.requestConcurrency = Math.max(1, Number.parseInt(value, 10) || 2);
        this.plugin.queue.setConcurrency(this.plugin.settings.requestConcurrency);
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Max deletion percent")
      .addText((text) => text.setValue(String(this.plugin.settings.maxDeletionPercent)).onChange(async (value) => {
        this.plugin.settings.maxDeletionPercent = Math.max(0, Number.parseInt(value, 10) || 20);
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
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

    new Setting(containerEl)
      .setName("Debug mode")
      .setDesc("Never logs tokens, codes, or note contents.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.debugMode).onChange(async (value) => {
        this.plugin.settings.debugMode = value;
          await this.plugin.saveSettings();
      }));

    this.renderSnapshots(containerEl, connected);
    this.renderDangerZone(containerEl, connected);
  }

  private renderStatus(containerEl: HTMLElement, connected: boolean) {
    const status = this.plugin.pluginData.syncStatus;
    const summary = status?.lastSummary;
    new Setting(containerEl).setName("Sync status").setHeading();
    const rows = [
      `State: ${status?.state ?? (connected ? "idle" : "disconnected")}`,
      connected && !this.plugin.isInitialSyncCompleted() ? "First sync: waiting for direction" : undefined,
      `Device: ${this.plugin.settings.deviceName || "Unnamed"}`,
      `Account: ${this.plugin.accountLabel || (connected ? "Connected" : "Not connected")}`,
      status?.lastFinishedAt ? `Last sync: ${new Date(status.lastFinishedAt).toLocaleString()}` : "Last sync: never",
      status?.lastDurationMs !== undefined ? `Duration: ${(status.lastDurationMs / 1000).toFixed(1)}s` : undefined,
      summary ? `Last summary: ${summary.uploads} uploads, ${summary.downloads} downloads, ${summary.localDeletes} local deletes, ${summary.remoteDeletes} remote deletes, ${summary.conflicts} conflicts` : undefined,
      status?.lastError ? `Last error: ${status.lastError}` : undefined
    ].filter(Boolean) as string[];
    for (const row of rows) containerEl.createEl("p", { text: row, cls: "obsidian-google-sync-status-row" });
    new Setting(containerEl)
      .addButton((button) => button.setButtonText("Sync now").setDisabled(!connected || !this.plugin.isInitialSyncCompleted()).onClick(() => this.plugin.syncNow()))
      .addButton((button) => button.setButtonText("Show command status").setDisabled(!connected).onClick(() => {
        const count = this.plugin.pluginData.appliedCommandIds?.length ?? 0;
        new Notice(`${count} remote reset command${count === 1 ? "" : "s"} applied on this device.`);
      }))
      .addButton((button) => button.setButtonText("Clear last error").setDisabled(!status?.lastError).onClick(async () => {
        await this.plugin.savePluginData({ syncStatus: { ...(this.plugin.pluginData.syncStatus ?? { state: connected ? "idle" : "disconnected" }), lastError: undefined } });
        this.display();
      }));
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

  private renderSnapshots(containerEl: HTMLElement, connected: boolean) {
    new Setting(containerEl).setName("Snapshots").setHeading();
    const listEl = containerEl.createDiv("obsidian-google-sync-snapshot-list");
    listEl.setText(connected ? "Loading snapshots..." : "Connect Google Drive to load snapshots.");
    if (!connected) return;
    void this.plugin.getRemoteSnapshots().then((snapshots) => {
      listEl.empty();
      if (snapshots.length === 0) {
        listEl.setText("No snapshots yet.");
        return;
      }
      for (const snapshot of snapshots) {
        listEl.createEl("p", {
          text: `${new Date(snapshot.createdAt).toLocaleString()} - ${snapshot.createdByDeviceName} - ${snapshot.name}`
        });
      }
    }).catch((error) => {
      listEl.setText(error instanceof Error ? error.message : "Could not load snapshots.");
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
