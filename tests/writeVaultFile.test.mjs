import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const outfile = path.join(tmpdir(), `obsidian-google-sync-utils-${Date.now()}.mjs`);
await build({
  entryPoints: ["src/utils.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  plugins: [{
    name: "obsidian-shim",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({
        path: path.resolve("tests/obsidian-shim.mjs")
      }));
    }
  }]
});

const { writeVaultFile } = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);

test("writes folder/file collisions to a safe conflict copy", async () => {
  const created = [];
  const vault = {
    getAbstractFileByPath: () => null,
    createFolder: async () => undefined,
    create: async (filePath, content) => {
      if (filePath === "Daily.md") throw new Error("Folder already exists");
      created.push({ filePath, content });
    },
    createBinary: async (filePath, content) => {
      if (filePath === "Daily.md") throw new Error("Folder already exists");
      created.push({ filePath, content });
    },
    modify: async () => undefined,
    modifyBinary: async () => undefined
  };

  await writeVaultFile(vault, "Daily.md", "remote text");

  assert.equal(created.length, 1);
  assert.match(created[0].filePath, /^\.sync\/conflicts\//);
  assert.match(created[0].filePath, /Daily%2Emd$/);
});
