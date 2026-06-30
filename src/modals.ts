import { App, Modal, Notice, Setting } from "obsidian";
import { DeviceFlowSession } from "./auth";
import { PlannedDeletion } from "./types";

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
      .addButton((button) => button.setButtonText("Reset").setDestructive().onClick(() => {
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
      .addButton((button) => button.setButtonText(cta).setDestructive().onClick(() => finish(true)))
      .addButton((button) => button.setButtonText("Cancel").onClick(() => finish(false)));
    modal.onClose = () => {
      finish(false, false);
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
      .addButton((button) => button.setButtonText("Move all to trash").setDestructive().onClick(() => finish([])))
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
