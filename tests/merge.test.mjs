import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const outfile = path.join(tmpdir(), `obsidian-google-sync-merge-${Date.now()}.mjs`);
await build({
  entryPoints: ["src/merge.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm"
});

const { MergeEngine } = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);

test("merges markdown additions in different paragraphs", () => {
  const engine = new MergeEngine();
  const result = engine.merge(
    "Daily.md",
    "Intro\n\nTasks\n",
    "Intro\nLocal note\n\nTasks\n",
    "Intro\n\nTasks\nRemote note\n"
  );
  assert.equal(result.status, "merged");
  assert.match(result.content, /Local note/);
  assert.match(result.content, /Remote note/);
});

test("conflicts on same-line edits", () => {
  const engine = new MergeEngine();
  const result = engine.merge("Daily.md", "- [ ] task\n", "- [x] task\n", "- [ ] task updated\n");
  assert.equal(result.status, "conflict");
});

test("conflicts on delete versus edit", () => {
  const engine = new MergeEngine();
  const result = engine.merge("Daily.md", "Keep\nRemove me\n", "Keep\n", "Keep\nEdited me\n");
  assert.equal(result.status, "conflict");
});

test("does not automerge risky file types", () => {
  const engine = new MergeEngine();
  assert.equal(engine.merge("data.json", "{\"a\":1}\n", "{\"a\":2}\n", "{\"a\":3}\n").status, "conflict");
  assert.equal(engine.merge("board.canvas", "{}", "{\"nodes\":[]}", "{\"edges\":[]}").status, "conflict");
  assert.equal(engine.merge(".obsidian/app.json", "{}", "{\"x\":1}", "{\"y\":1}").status, "conflict");
});
