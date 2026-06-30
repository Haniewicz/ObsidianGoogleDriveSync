import { TFile, Vault } from "obsidian";
import { LocalFileMeta } from "./types";
import { byteSize, getExtension, ignoredPatternsFromSettings, isIgnored, isLikelyText, sha256Hex } from "./utils";

export class LocalVaultScanner {
  constructor(private vault: Vault, private getIgnoredPaths: () => string) {}

  async scan(): Promise<Record<string, LocalFileMeta>> {
    const ignored = ignoredPatternsFromSettings(this.getIgnoredPaths());
    const files = this.vault.getFiles().filter((file) => !isIgnored(file.path, ignored));
    const result: Record<string, LocalFileMeta> = {};
    for (const file of files) {
      result[file.path] = await this.scanFile(file);
    }
    return result;
  }

  async read(path: string, forceBinary = false): Promise<string | ArrayBuffer> {
    const file = this.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`Local file not found: ${path}`);
    if (!forceBinary && isLikelyText(path)) return this.vault.read(file);
    return this.vault.readBinary(file);
  }

  async readText(path: string): Promise<string> {
    const file = this.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`Local file not found: ${path}`);
    return this.vault.read(file);
  }

  private async scanFile(file: TFile): Promise<LocalFileMeta> {
    const isText = isLikelyText(file.path);
    const content = isText ? await this.vault.read(file) : await this.vault.readBinary(file);
    return {
      path: file.path,
      hash: await sha256Hex(content),
      size: byteSize(content),
      extension: getExtension(file.path),
      mtime: file.stat.mtime,
      isText
    };
  }
}
