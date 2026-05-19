import { isAbsolute, relative, resolve as pathResolve } from "node:path";
import { realpathSync } from "node:fs";

export function resolvedPathOrFallback(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return pathResolve(path);
  }
}

export function isPathInsideDir(rootDirAbs: string, candidatePath: string): boolean {
  const rootResolved = resolvedPathOrFallback(rootDirAbs);
  const candidateAbs = isAbsolute(candidatePath) ? candidatePath : pathResolve(candidatePath);
  const candidateResolved = resolvedPathOrFallback(candidateAbs);
  const rel = relative(rootResolved, candidateResolved);
  if (rel === "") return true;
  return !rel.startsWith("..") && !isAbsolute(rel);
}
