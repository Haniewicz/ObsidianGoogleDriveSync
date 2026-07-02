import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const outfile = path.join(tmpdir(), `obsidian-google-sync-offline-queue-${Date.now()}.mjs`);
await build({
  entryPoints: ["src/offlineQueue.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm"
});

const { OfflineSyncQueue } = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);

test("compacts duplicate queued operations and removes resumed items", async () => {
  let items = [];
  const queue = new OfflineSyncQueue(
    () => items,
    async (next) => { items = next; },
    () => "device-a"
  );

  await queue.enqueue("upload", "Daily.md");
  await queue.enqueue("upload", "Daily.md");
  await queue.enqueue("delete", "Old.md");

  assert.equal(items.length, 2);
  assert.equal(items[0].type, "upload");
  assert.equal(items[0].path, "Daily.md");
  assert.equal(items[1].type, "delete");

  await queue.remove(items[0].id);
  assert.deepEqual(items.map((item) => item.path), ["Old.md"]);
});
