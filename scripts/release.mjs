import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const mode = process.argv[2];

if (!["dev", "stable"].includes(mode)) {
  throw new Error("Usage: node scripts/release.mjs <dev|stable>");
}

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: "inherit", ...options });
}

function output(command, args) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function assertCleanWorkingTree() {
  const status = output("git", ["status", "--porcelain"]);
  if (status) {
    throw new Error("Working tree must be clean before starting a release.");
  }
}

function assertBranch() {
  const branch = output("git", ["branch", "--show-current"]);
  if (mode === "dev" && branch !== "dev") {
    throw new Error("Dev releases must be created from the dev branch.");
  }

  if (mode === "stable" && !["master", "main"].includes(branch)) {
    throw new Error("Stable releases must be created from master or main.");
  }
}

function parseVersion(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-dev\.(\d+))?$/);
  if (!match) {
    throw new Error(`Unsupported version format: ${version}`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    dev: match[4] === undefined ? undefined : Number(match[4])
  };
}

function nextDevVersion(version) {
  const current = parseVersion(version);
  if (current.dev !== undefined) {
    return `${current.major}.${current.minor}.${current.patch}-dev.${current.dev + 1}`;
  }

  return `${current.major}.${current.minor}.${current.patch + 1}-dev.0`;
}

function stableVersion(version) {
  const current = parseVersion(version);
  return `${current.major}.${current.minor}.${current.patch}`;
}

function updateRootLockVersion(lock, version) {
  lock.version = version;
  if (lock.packages?.[""]) {
    lock.packages[""].version = version;
  }
}

assertCleanWorkingTree();
assertBranch();

const packageJson = readJson("package.json");
const nextVersion = mode === "dev" ? nextDevVersion(packageJson.version) : stableVersion(packageJson.version);
const tag = `v${nextVersion}`;

packageJson.version = nextVersion;
writeJson("package.json", packageJson);

const manifestJson = readJson("manifest.json");
manifestJson.version = nextVersion;
writeJson("manifest.json", manifestJson);

const packageLockJson = readJson("package-lock.json");
updateRootLockVersion(packageLockJson, nextVersion);
writeJson("package-lock.json", packageLockJson);

if (mode === "stable") {
  const versionsJson = readJson("versions.json");
  versionsJson[nextVersion] = manifestJson.minAppVersion;
  writeJson("versions.json", versionsJson);
}

run("npm", ["run", "build"]);
run("git", ["add", "package.json", "package-lock.json", "manifest.json", "versions.json", "main.js"]);
run("git", ["commit", "-m", `${mode === "dev" ? "chore: dev release" : "chore: release"} ${tag}`]);
run("git", ["tag", tag]);
run("git", ["push", "-u", "origin", output("git", ["branch", "--show-current"])]);
run("git", ["push", "origin", tag]);
run("gh", [
  "release",
  "create",
  tag,
  "main.js",
  "manifest.json",
  "styles.css",
  "--title",
  tag,
  "--target",
  "HEAD",
  "--generate-notes",
  ...(mode === "dev" ? ["--prerelease"] : [])
]);
