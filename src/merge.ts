export type MergeResult =
  | { status: "merged"; content: string }
  | { status: "conflict"; reason: string }
  | { status: "no-changes" };

export class MergeEngine {
  merge(path: string, base: string, local: string, remote: string): MergeResult {
    if (local === remote) return { status: "no-changes" };
    if (base === local) return { status: "merged", content: remote };
    if (base === remote) return { status: "merged", content: local };
    if (!isSafeMarkdownPath(path)) return { status: "conflict", reason: "Only Markdown files are eligible for automatic merge." };

    const baseLines = splitLines(base);
    const localLines = splitLines(local);
    const remoteLines = splitLines(remote);
    const localInsertions = collectPureInsertions(baseLines, localLines);
    const remoteInsertions = collectPureInsertions(baseLines, remoteLines);
    if (localInsertions && remoteInsertions) {
      return { status: "merged", content: mergeInsertions(baseLines, localInsertions, remoteInsertions).join("") };
    }

    const localChanges = changedLineSet(baseLines, localLines);
    const remoteChanges = changedLineSet(baseLines, remoteLines);

    for (const line of localChanges) {
      if (remoteChanges.has(line)) return { status: "conflict", reason: "Both devices changed the same line." };
      if (isDeletionAgainstEdit(line, baseLines, localLines, remoteLines)) {
        return { status: "conflict", reason: "One device deleted content changed by another device." };
      }
    }

    const merged = localLines.slice();
    for (const line of remoteChanges) {
      if (line >= baseLines.length) {
        merged.push(...remoteLines.slice(baseLines.length));
        continue;
      }
      const remoteLine = remoteLines[line];
      if (remoteLine !== undefined) merged[line] = remoteLine;
    }

    if (sameParagraphChanged(baseLines, localChanges, remoteChanges)) {
      return { status: "conflict", reason: "Both devices changed the same paragraph." };
    }

    return { status: "merged", content: merged.join("") };
  }
}

function collectPureInsertions(base: string[], changed: string[]): Map<number, string[]> | null {
  const insertions = new Map<number, string[]>();
  let baseIndex = 0;
  let changedIndex = 0;
  while (changedIndex < changed.length) {
    if (baseIndex < base.length && changed[changedIndex] === base[baseIndex]) {
      baseIndex += 1;
      changedIndex += 1;
      continue;
    }
    const bucket = insertions.get(baseIndex) ?? [];
    bucket.push(changed[changedIndex]);
    insertions.set(baseIndex, bucket);
    changedIndex += 1;
  }
  return baseIndex === base.length ? insertions : null;
}

function mergeInsertions(base: string[], local: Map<number, string[]>, remote: Map<number, string[]>): string[] {
  const result: string[] = [];
  for (let index = 0; index <= base.length; index += 1) {
    result.push(...(local.get(index) ?? []));
    result.push(...(remote.get(index) ?? []));
    if (index < base.length) result.push(base[index]);
  }
  return result;
}

export function mergeText(base: string, local: string, remote: string): { clean: boolean; text: string } {
  const result = new MergeEngine().merge("note.md", base, local, remote);
  if (result.status === "conflict") return { clean: false, text: "" };
  return { clean: true, text: result.status === "no-changes" ? local : result.content };
}

function isSafeMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  if (!lower.endsWith(".md")) return false;
  if (lower.startsWith(".obsidian/") || lower.includes("/.obsidian/")) return false;
  return !lower.endsWith(".json") && !lower.endsWith(".canvas") && !lower.endsWith(".base");
}

function splitLines(value: string): string[] {
  const matches = value.match(/[^\n]*\n|[^\n]+$/g);
  return matches ?? [];
}

function changedLineSet(base: string[], changed: string[]): Set<number> {
  const result = new Set<number>();
  const length = Math.max(base.length, changed.length);
  for (let index = 0; index < length; index += 1) {
    if (base[index] !== changed[index]) result.add(index);
  }
  return result;
}

function isDeletionAgainstEdit(line: number, base: string[], local: string[], remote: string[]): boolean {
  const baseLine = base[line];
  if (baseLine === undefined) return false;
  const localDeleted = local[line] === undefined;
  const remoteDeleted = remote[line] === undefined;
  const localEdited = local[line] !== undefined && local[line] !== baseLine;
  const remoteEdited = remote[line] !== undefined && remote[line] !== baseLine;
  return (localDeleted && remoteEdited) || (remoteDeleted && localEdited);
}

function sameParagraphChanged(baseLines: string[], localChanges: Set<number>, remoteChanges: Set<number>): boolean {
  for (const localLine of localChanges) {
    for (const remoteLine of remoteChanges) {
      if (paragraphId(baseLines, localLine) === paragraphId(baseLines, remoteLine)) return true;
    }
  }
  return false;
}

function paragraphId(lines: string[], line: number): number {
  let id = 0;
  for (let index = 0; index <= Math.min(line, lines.length - 1); index += 1) {
    if (lines[index].trim() === "") id += 1;
  }
  return id;
}
