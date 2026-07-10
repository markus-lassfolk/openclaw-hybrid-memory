/**
 * Regression test (#2067-followup sweep) for services/embeddings/onnx-provider.ts's ONNX model
 * cache directory resolution:
 *
 * `repo` (from embedding.model, split at the last "@") was sanitized via `sanitizeRepoDir` before
 * being joined into the cache path, but `revision` was used raw. A config value like
 * "custom-model@../../../../tmp/evil" made the resolved cache directory escape the intended
 * cache root entirely, so downloadFile() would write the fetched model/vocab files outside
 * DEFAULT_ONNX_CACHE_DIR.
 */
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveOnnxRepoCacheDir } from "../services/embeddings/onnx-provider.js";

describe("resolveOnnxRepoCacheDir path-traversal safety", () => {
  it("keeps the resolved cache dir inside cacheDir even when revision contains path-traversal segments", () => {
    const cacheDir = "/tmp/fake-onnx-cache";
    const repoDir = resolveOnnxRepoCacheDir(cacheDir, "custom-model@../../../../tmp/evil");

    // The security property: no slash survives sanitization, so join() can never interpret any
    // segment as "go up a directory" -- the resolved path must stay a direct descendant of cacheDir.
    expect(resolve(repoDir).startsWith(`${resolve(cacheDir)}/`)).toBe(true);
    expect(repoDir.slice(resolve(cacheDir).length)).not.toContain("/../");
    expect(repoDir).not.toMatch(/\/\.\.($|\/)/);
  });

  it("keeps the resolved cache dir inside cacheDir even when repo contains path-traversal segments", () => {
    const cacheDir = "/tmp/fake-onnx-cache";
    const repoDir = resolveOnnxRepoCacheDir(cacheDir, "../../../../tmp/evil@main");

    expect(resolve(repoDir).startsWith(`${resolve(cacheDir)}/`)).toBe(true);
    expect(repoDir.slice(resolve(cacheDir).length)).not.toContain("/../");
    expect(repoDir).not.toMatch(/\/\.\.($|\/)/);
  });

  it("still builds the expected cache dir for a normal repo@revision input", () => {
    const cacheDir = "/tmp/fake-onnx-cache";
    const repoDir = resolveOnnxRepoCacheDir(cacheDir, "org/model-name@v1.0");

    expect(repoDir).toBe(join(cacheDir, "org__model-name", "v1.0"));
  });

  it("defaults revision to main when no @ is present", () => {
    const cacheDir = "/tmp/fake-onnx-cache";
    const repoDir = resolveOnnxRepoCacheDir(cacheDir, "org/model-name");

    expect(repoDir).toBe(join(cacheDir, "org__model-name", "main"));
  });
});
