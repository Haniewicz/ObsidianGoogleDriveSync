import { SyncQueueItem } from "./types";

export class OfflineSyncQueue {
  constructor(
    private getItems: () => SyncQueueItem[],
    private setItems: (items: SyncQueueItem[]) => Promise<void>,
    private getDeviceId: () => string
  ) {}

  items(): SyncQueueItem[] {
    return this.getItems();
  }

  async enqueue(type: SyncQueueItem["type"], path: string, targetPath?: string): Promise<void> {
    const existing = this.getItems();
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const next = compactQueue([
      ...existing,
      {
        id,
        type,
        path,
        targetPath,
        createdAt: Date.now(),
        deviceId: this.getDeviceId()
      }
    ]);
    await this.setItems(next);
  }

  async remove(id: string): Promise<void> {
    await this.setItems(this.getItems().filter((item) => item.id !== id));
  }
}

function compactQueue(items: SyncQueueItem[]): SyncQueueItem[] {
  const latestByKey = new Map<string, SyncQueueItem>();
  for (const item of items) {
    latestByKey.set(`${item.type}:${item.path}:${item.targetPath ?? ""}`, item);
  }
  return Array.from(latestByKey.values()).sort((a, b) => a.createdAt - b.createdAt);
}
