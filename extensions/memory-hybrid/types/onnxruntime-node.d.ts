/**
 * Ambient module declaration for onnxruntime-node.
 * The package is an optional runtime dependency — not installed by default.
 * TypeScript module resolution requires this shim so `import("onnxruntime-node")`
 * compiles cleanly. The actual types are provided via local shims in services/embeddings.ts.
 */
declare module "onnxruntime-node";
