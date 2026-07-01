import { App, Modal, Notice, Platform, Setting } from "obsidian";
import { DeviceFlowSession } from "./auth";
import { AuthTransferPayload, buildTransferUrl, decryptAuth, encryptAuth, generateQRCodeSvg } from "./authTransfer";
import { InitialSyncDirection, PlannedDeletion, StoredAuth } from "./types";

export class DeviceFlowModal extends Modal {
  private timerId?: number;
  private statusEl!: HTMLElement;
  private countdownEl!: HTMLElement;

  constructor(app: App, private session: DeviceFlowSession, private onCancel: () => void) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    const device = this.session.device;
    const verificationUrl = device.verification_url_complete ?? device.verification_uri_complete ?? device.verification_url ?? device.verification_uri ?? "";
    contentEl.empty();
    contentEl.createEl("h2", { text: "Connect Google Drive" });
    contentEl.createEl("p", { text: "Enter this code on the Google verification page:" });
    contentEl.createEl("div", {
      text: device.user_code,
      cls: "google-drive-sync-user-code"
    });
    contentEl.createEl("p", { text: verificationUrl });
    this.countdownEl = contentEl.createEl("p");
    this.statusEl = contentEl.createEl("p", { text: "Waiting for Google authorization..." });
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Open Google verification page").onClick(() => window.open(verificationUrl, "_blank")))
      .addButton((button) => button.setButtonText("Cancel").onClick(() => {
        this.session.cancel();
        this.onCancel();
        this.close();
      }));
    this.timerId = window.setInterval(() => this.renderCountdown(), 1000);
    this.renderCountdown();
    this.session.done.then(() => this.close()).catch((error) => {
      this.statusEl.setText(error instanceof Error ? error.message : "Authorization failed.");
    });
  }

  onClose() {
    if (this.timerId !== undefined) window.clearInterval(this.timerId);
    this.contentEl.empty();
  }

  private renderCountdown() {
    const remaining = Math.max(0, Math.ceil((this.session.device.expires_in * 1000 - (Date.now() - this.openedAt)) / 1000));
    this.countdownEl.setText(`Code expires in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`);
  }

  private readonly openedAt = Date.now();
}

export class LargeDeletionModal extends Modal {
  private selected = new Set<string>();

  constructor(
    app: App,
    private deletions: PlannedDeletion[],
    private percent: number,
    private resolve: (paths: PlannedDeletion[] | null) => void
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Review planned deletions" });
    contentEl.createEl("p", { text: `${this.deletions.length} synced files (${this.percent.toFixed(1)}%) are planned for deletion.` });
    const search = contentEl.createEl("input", { type: "search", placeholder: "Search files" });
    const list = contentEl.createDiv("google-drive-sync-deletion-list");
    const render = () => {
      list.empty();
      const query = search.value.toLowerCase();
      for (const deletion of this.deletions.filter((item) => item.path.toLowerCase().includes(query))) {
        new Setting(list)
          .setName(deletion.path)
          .setDesc(deletion.direction === "local" ? "Local safe delete" : "Remote tombstone")
          .addToggle((toggle) => toggle.setValue(this.selected.has(key(deletion))).onChange((value) => {
            if (value) this.selected.add(key(deletion));
            else this.selected.delete(key(deletion));
          }));
      }
    };
    search.addEventListener("input", render);
    render();
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Delete selected").setCta().onClick(() => {
        const chosen = this.deletions.filter((item) => this.selected.has(key(item)));
        this.resolve(chosen);
        this.close();
      }))
      .addButton((button) => button.setButtonText("Skip deletions").onClick(() => {
        this.resolve([]);
        this.close();
      }))
      .addButton((button) => button.setButtonText("Cancel sync").onClick(() => {
        this.resolve(null);
        this.close();
      }));
  }

  onClose() {
    this.contentEl.empty();
  }
}

export function confirmResetIndex(app: App): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    let settled = false;
    const finish = (value: boolean, close = true) => {
      if (settled) return;
      settled = true;
      resolve(value);
      if (close) modal.close();
    };
    modal.titleEl.setText("Reset local sync index?");
    modal.contentEl.createEl("p", { text: "This keeps files and Google Drive data, but forgets the local sync baseline." });
    new Setting(modal.contentEl)
      .addButton((button) => button.setButtonText("Reset").setWarning().onClick(() => {
        finish(true);
      }))
      .addButton((button) => button.setButtonText("Cancel").onClick(() => {
        finish(false);
      }));
    modal.onClose = () => {
      finish(false, false);
      modal.contentEl.empty();
    };
    modal.open();
  });
}

export function confirmDangerAction(app: App, title: string, message: string, cta: string): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    let settled = false;
    const finish = (value: boolean, close = true) => {
      if (settled) return;
      settled = true;
      resolve(value);
      if (close) modal.close();
    };
    modal.titleEl.setText(title);
    modal.contentEl.createEl("p", { text: message });
    new Setting(modal.contentEl)
      .addButton((button) => button.setButtonText(cta).setWarning().onClick(() => finish(true)))
      .addButton((button) => button.setButtonText("Cancel").onClick(() => finish(false)));
    modal.onClose = () => {
      finish(false, false);
      modal.contentEl.empty();
    };
    modal.open();
  });
}

export function chooseInitialSyncDirection(app: App): Promise<InitialSyncDirection | null> {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    let settled = false;
    const finish = (value: InitialSyncDirection | null, close = true) => {
      if (settled) return;
      settled = true;
      resolve(value);
      if (close) modal.close();
    };
    modal.titleEl.setText("Choose first sync direction");
    modal.contentEl.createEl("p", {
      text: "Choose how this device should create its first sync baseline. Automatic sync will stay paused until you choose."
    });
    new Setting(modal.contentEl)
      .setName("Cloud to local")
      .setDesc("Replace this local vault with the current Google Drive sync state.")
      .addButton((button) => button.setButtonText("Use cloud").setCta().onClick(() => finish("cloud-to-local")));
    new Setting(modal.contentEl)
      .setName("Local to cloud")
      .setDesc("Replace the Google Drive sync state with this local vault.")
      .addButton((button) => button.setButtonText("Use local").setWarning().onClick(() => finish("local-to-cloud")));
    new Setting(modal.contentEl)
      .addButton((button) => button.setButtonText("Choose later").onClick(() => finish(null)));
    modal.onClose = () => {
      finish(null, false);
      modal.contentEl.empty();
    };
    modal.open();
  });
}

export function chooseLocalFilesToKeep(app: App, paths: string[]): Promise<string[] | null> {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    const selected = new Set<string>();
    let settled = false;
    const finish = (value: string[] | null, close = true) => {
      if (settled) return;
      settled = true;
      resolve(value);
      if (close) modal.close();
    };
    modal.titleEl.setText("Keep local-only files?");
    modal.contentEl.createEl("p", { text: "These local files are not present in Google Drive. Select files to keep locally and upload back to the cloud after reset." });
    const search = modal.contentEl.createEl("input", { type: "search", placeholder: "Search files" });
    const list = modal.contentEl.createDiv("google-drive-sync-deletion-list");
    const render = () => {
      list.empty();
      const query = search.value.toLowerCase();
      for (const path of paths.filter((item) => item.toLowerCase().includes(query))) {
        new Setting(list)
          .setName(path)
          .addToggle((toggle) => toggle.setValue(selected.has(path)).onChange((value) => {
            if (value) selected.add(path);
            else selected.delete(path);
          }));
      }
    };
    search.addEventListener("input", render);
    render();
    new Setting(modal.contentEl)
      .addButton((button) => button.setButtonText("Keep selected").setCta().onClick(() => finish(Array.from(selected))))
      .addButton((button) => button.setButtonText("Move all to trash").setWarning().onClick(() => finish([])))
      .addButton((button) => button.setButtonText("Cancel").onClick(() => finish(null)));
    modal.onClose = () => {
      finish(null, false);
      modal.contentEl.empty();
    };
    modal.open();
  });
}

export function showConflictNotice(count: number) {
  if (count > 0) new Notice(`${count} Google Drive sync conflict${count === 1 ? "" : "s"} saved as copies.`);
}

function key(deletion: PlannedDeletion): string {
  return `${deletion.direction}:${deletion.path}`;
}

// ---------------------------------------------------------------------------
// Auth Transfer – Export (desktop only)
// ---------------------------------------------------------------------------

export class AuthExportModal extends Modal {
  private usePassword = false;
  private password = "";
  private confirmPassword = "";
  private qrEl!: HTMLElement;
  private errorEl!: HTMLElement;
  private generateBtn!: HTMLButtonElement;

  constructor(app: App, private auth: StoredAuth) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Transfer Google auth to another device" });
    contentEl.createEl("p", {
      text: "Scan the QR code in Obsidian on another device. The code contains your Google OAuth tokens — treat it like a password.",
      cls: "obsidian-google-sync-status-row"
    });

    new Setting(contentEl)
      .setName("Protect with password")
      .setDesc("Encrypt the QR code payload so only someone with the password can use it.")
      .addToggle((toggle) => toggle.setValue(false).onChange((value) => {
        this.usePassword = value;
        passwordSetting.settingEl.style.display = value ? "" : "none";
        confirmSetting.settingEl.style.display = value ? "" : "none";
        this.qrEl.empty();
        this.errorEl.setText("");
      }));

    const passwordSetting = new Setting(contentEl)
      .setName("Password")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("Enter password").onChange((value) => { this.password = value; });
      });
    passwordSetting.settingEl.style.display = "none";

    const confirmSetting = new Setting(contentEl)
      .setName("Confirm password")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("Repeat password").onChange((value) => { this.confirmPassword = value; });
      });
    confirmSetting.settingEl.style.display = "none";

    this.errorEl = contentEl.createEl("p", { cls: "obsidian-google-sync-transfer-error" });

    new Setting(contentEl).addButton((button) => {
      this.generateBtn = button.buttonEl;
      button.setButtonText("Generate QR code").setCta().onClick(() => void this.generate());
    });

    this.qrEl = contentEl.createDiv("obsidian-google-sync-qr-container");
  }

  private async generate() {
    this.errorEl.setText("");
    if (this.usePassword) {
      if (!this.password) {
        this.errorEl.setText("Enter a password.");
        return;
      }
      if (this.password !== this.confirmPassword) {
        this.errorEl.setText("Passwords do not match.");
        return;
      }
    }
    this.generateBtn.disabled = true;
    this.generateBtn.textContent = "Generating…";
    try {
      let payload: AuthTransferPayload;
      if (this.usePassword) {
        payload = await encryptAuth(this.auth, this.password);
      } else {
        payload = { v: 1, encrypted: false, auth: this.auth };
      }
      const url = buildTransferUrl(payload);
      const svg = await generateQRCodeSvg(url);
      this.qrEl.empty();
      this.qrEl.innerHTML = svg;
      this.qrEl.createEl("p", {
        text: this.usePassword
          ? "Scan this QR code in Obsidian on the target device. You will be asked for the password."
          : "⚠ Unencrypted — scan quickly and do not share. Treat it like a password.",
        cls: "obsidian-google-sync-status-row"
      });
    } catch (error) {
      this.errorEl.setText(error instanceof Error ? error.message : "Failed to generate QR code.");
    } finally {
      this.generateBtn.disabled = false;
      this.generateBtn.textContent = "Generate QR code";
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ---------------------------------------------------------------------------
// Auth Transfer – Import (triggered by deep link on receiving device)
// ---------------------------------------------------------------------------

export function showAuthImportModal(app: App, payload: AuthTransferPayload): Promise<StoredAuth | null> {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    let settled = false;
    const finish = (value: StoredAuth | null, close = true) => {
      if (settled) return;
      settled = true;
      resolve(value);
      if (close) modal.close();
    };

    modal.titleEl.setText("Import Google Drive credentials");

    if (!payload.encrypted) {
      modal.contentEl.createEl("p", {
        text: "A QR code from another device contains Google Drive credentials. Import them to connect Google Drive on this device.",
        cls: "obsidian-google-sync-status-row"
      });
      new Setting(modal.contentEl)
        .addButton((btn) => btn.setButtonText("Import").setCta().onClick(() => finish(payload.auth)))
        .addButton((btn) => btn.setButtonText("Cancel").onClick(() => finish(null)));
    } else {
      modal.contentEl.createEl("p", {
        text: "The QR code is password-protected. Enter the password to decrypt and import the credentials.",
        cls: "obsidian-google-sync-status-row"
      });
      let password = "";
      const errorEl = modal.contentEl.createEl("p", { cls: "obsidian-google-sync-transfer-error" });
      new Setting(modal.contentEl)
        .setName("Password")
        .addText((text) => {
          text.inputEl.type = "password";
          text.setPlaceholder("Enter password").onChange((value) => { password = value; });
          text.inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") importBtn.click(); });
        });
      let importBtn!: HTMLButtonElement;
      new Setting(modal.contentEl)
        .addButton((btn) => {
          importBtn = btn.buttonEl;
          btn.setButtonText("Import").setCta().onClick(async () => {
            errorEl.setText("");
            if (!password) { errorEl.setText("Enter the password."); return; }
            importBtn.disabled = true;
            importBtn.textContent = "Decrypting…";
            try {
              const auth = await decryptAuth(payload, password);
              finish(auth);
            } catch (error) {
              errorEl.setText(error instanceof Error ? error.message : "Decryption failed.");
              importBtn.disabled = false;
              importBtn.textContent = "Import";
            }
          });
        })
        .addButton((btn) => btn.setButtonText("Cancel").onClick(() => finish(null)));
    }

    modal.onClose = () => { finish(null, false); modal.contentEl.empty(); };
    modal.open();
  });
}
