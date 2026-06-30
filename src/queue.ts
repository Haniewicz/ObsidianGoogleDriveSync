import { sleep } from "./utils";

export class RequestQueue {
  private active = 0;
  private readonly pending: Array<() => void> = [];

  constructor(private concurrency: number) {}

  setConcurrency(concurrency: number) {
    this.concurrency = Math.max(1, concurrency);
    this.drain();
  }

  async run<T>(task: () => Promise<T>, maxRetries = 5): Promise<T> {
    await this.acquire();
    try {
      return await this.withRetries(task, maxRetries);
    } finally {
      this.active -= 1;
      this.drain();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.pending.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private drain() {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const next = this.pending.shift();
      next?.();
    }
  }

  private async withRetries<T>(task: () => Promise<T>, maxRetries: number): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await task();
      } catch (error) {
        const status = getStatus(error);
        if (!status || ![403, 429, 500, 502, 503, 504].includes(status) || attempt >= maxRetries) {
          throw error;
        }
        const jitter = Math.floor(Math.random() * 350);
        const delay = Math.min(30000, 750 * 2 ** attempt) + jitter;
        attempt += 1;
        await sleep(delay);
      }
    }
  }
}

function getStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as { status?: unknown }).status;
  return typeof value === "number" ? value : undefined;
}
