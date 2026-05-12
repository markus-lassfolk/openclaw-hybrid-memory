import { defineConfig } from "tsdown";

/**
 * tsdown build for OpenClaw 2026.5.4+ (issue #1171).
 *
 * Emits a multi-file ESM tree under `dist/` (one .js per source .ts) so the
 * gateway can statically discover route modules and other plugin metadata.
 * A single bundled `dist/index.js` is intentionally avoided — see issue #1173
 * for why bundling causes "http route registration missing path" warnings.
 *
 * The runtime entry point (consumed by `openclaw.extensions`) is `dist/index.js`.
 */
export default defineConfig({
  entry: ["index.ts"],
  format: ["esm"],
  outDir: "dist",
  target: "node22",
  platform: "node",
  // Multi-file output: keep the source module tree in dist/ so OpenClaw's
  // plugin loader can introspect route modules individually instead of
  // treating one bundle as opaque source.
  unbundle: true,
  // Use `.js` for output (package.json#type is "module"); the default
  // platform=node setting would otherwise emit `.mjs`.
  fixedExtension: false,
  // Generate .d.ts alongside .js — keeps editor / consumer types working.
  dts: true,
  sourcemap: true,
  clean: true,
  // Treat all dependencies (and their subpaths) as external. tsdown reads
  // package.json#dependencies / peerDependencies / optionalDependencies for
  // this by default; we list a few extras explicitly for clarity.
  deps: {
    neverBundle: [
      /^node:/,
      "openclaw",
      /^openclaw\//,
      "@sinclair/typebox",
      /^@sinclair\/typebox\//,
      "openai",
      /^openai\//,
      "@lancedb/lancedb",
      /^@lancedb\//,
      "onnxruntime-node",
      "franc",
      "commander",
    ],
  },
  shims: false,
});
