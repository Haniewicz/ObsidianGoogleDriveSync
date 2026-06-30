export type MergeResult = {
  clean: boolean;
  text: string;
};

export function mergeText(base: string, local: string, remote: string): MergeResult {
  if (local === remote) return { clean: true, text: local };
  if (base === local) return { clean: true, text: remote };
  if (base === remote) return { clean: true, text: local };

  const baseLines = splitLines(base);
  const localLines = splitLines(local);
  const remoteLines = splitLines(remote);
  const localChanged = changedLineSet(baseLines, localLines);
  const remoteChanged = changedLineSet(baseLines, remoteLines);
  for (const line of localChanged) {
    if (remoteChanged.has(line)) return { clean: false, text: "" };
  }

  const merged = localLines.slice();
  for (const line of remoteChanged) {
    if (line >= baseLines.length) {
      merged.push(...remoteLines.slice(baseLines.length));
      continue;
    }
    const remoteLine = remoteLines[line];
    if (remoteLine !== undefined) merged[line] = remoteLine;
  }
  return { clean: true, text: merged.join("") };
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
