/**
 * Embedding service: OpenAI and Ollama implementations, provider abstraction and factory.
 */

import OpenAI from "openai";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { createWriteStream } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { capturePluginError } from "./error-reporter.js";
import { withLLMRetry, is404Like, is403Like, is429OrWrapped, LLMRetryError } from "./chat.js";

/**
 * Thrown by ChainEmbeddingProvider when every provider in the chain has failed.
 * Callers should catch this and degrade gracefully (e.g. store without a vector)
 * rather than reporting to error monitoring, since this is expected when all
 * configured embedding backends are temporarily unavailable.
 *
 * `causes` contains the per-provider errors; callers can inspect them to decide
 * whether to suppress error monitoring (e.g. all are config errors → no report).
 */
export class AllEmbeddingProvidersFailed extends Error {
  readonly causes: Error[];
  constructor(causes: Error[] = []) {
    super("All embedding providers in the chain failed.");
    this.name = "AllEmbeddingProvidersFailed";
    this.causes = causes;
  }
}

/** Full embedding provider interface — implementations must expose these. */
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
  readonly modelName: string;
  /** When set, indicates the effective provider in use (e.g. "openai" when FallbackEmbeddingProvider has switched from ollama). */
  readonly activeProvider?: string;
}

/** Config shape accepted by createEmbeddingProvider (matches HybridMemoryConfig.embedding). */
export interface EmbeddingConfig {
  provider: "openai" | "ollama" | "onnx" | "google";
  model: string;
  apiKey?: string;
  models?: string[];
  dimensions: number;
  endpoint?: string;
  batchSize: number;
  /** Ordered list to try (failover). When length > 1, a chain is built. */
  preferredProviders?: ("ollama" | "openai" | "google")[];
  /** Set by parser from distill.apiKey or llm.providers.google.apiKey when preferredProviders includes "google". */
  googleApiKey?: string;
}

/** Google Gemini OpenAI-compatible embeddings base URL (same as chat). */
const GOOGLE_EMBEDDING_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

/**
 * Known Google Gemini embedding models accepted at the OpenAI-compatible endpoint.
 * Only these are passed to the Google endpoint; any other value falls back to the default.
 *
 * WARNING: Changing the default from text-embedding-004 to text-embedding-005 produces
 * different vectors — existing LanceDB tables indexed with 004 will see degraded retrieval
 * quality until re-indexed. Run the hybrid-mem re-index command after upgrading (#385).
 */
const KNOWN_GOOGLE_EMBED_MODELS = new Set(["text-embedding-005", "text-embedding-004"]);

/** Max cached embeddings (LRU eviction). Reduces redundant API calls for repeated text. */
const EMBEDDING_CACHE_MAX = 500;

/**
 * OpenAI embedding models have a hard limit of 8192 tokens per input.
 * Using ~4 chars/token heuristic (consistent with estimateTokens in utils/text.ts),
 * we clamp inputs to this character ceiling before hitting the API.
 * Overshooting the estimate slightly is harmless; undershooting wastes a round trip.
 */
const OPENAI_EMBEDDING_MAX_TOKENS = 8192;
const OPENAI_EMBEDDING_MAX_CHARS = OPENAI_EMBEDDING_MAX_TOKENS * 4; // ~32 768 chars

/**
 * Truncate text to fit within the OpenAI embedding token limit.
 * Uses the same ~4 chars/token heuristic as estimateTokens() so behaviour is
 * consistent across the codebase without adding a tokenizer dependency here.
 */
function truncateForEmbedding(text: string): string {
  if (text.length <= OPENAI_EMBEDDING_MAX_CHARS) return text;
  return text.slice(0, OPENAI_EMBEDDING_MAX_CHARS).trimEnd();
}

// ---------------------------------------------------------------------------
// ONNX embedding provider (local)
// ---------------------------------------------------------------------------

type OnnxRuntime = typeof import("onnxruntime-node");
type OnnxRuntimeLoader = () => Promise<OnnxRuntime>;

const DEFAULT_ONNX_CACHE_DIR = join(homedir(), ".cache", "openclaw", "onnx-embeddings");
const DEFAULT_ONNX_MAX_SEQ_LEN = 256;

const ONNX_MODEL_SPECS: Record<string, { repo: string; modelFile: string; vocabFileCandidates: string[] }> = {
  "all-MiniLM-L6-v2": {
    repo: "sentence-transformers/all-MiniLM-L6-v2",
    modelFile: "onnx/model.onnx",
    vocabFileCandidates: ["vocab.txt", "tokenizer/vocab.txt"],
  },
  "bge-small-en-v1.5": {
    repo: "BAAI/bge-small-en-v1.5",
    modelFile: "onnx/model.onnx",
    vocabFileCandidates: ["vocab.txt", "tokenizer/vocab.txt"],
  },
};

class OnnxRuntimeMissingError extends Error {
  readonly code = "ONNX_RUNTIME_MISSING";
  constructor(message: string) {
    super(message);
    this.name = "OnnxRuntimeMissingError";
  }
}

function isOnnxRuntimeMissingError(err: unknown): err is OnnxRuntimeMissingError {
  return err instanceof OnnxRuntimeMissingError || (err instanceof Error && (err as Error & { code?: string }).code === "ONNX_RUNTIME_MISSING");
}

const defaultOnnxRuntimeLoader: OnnxRuntimeLoader = () => import("onnxruntime-node");
let onnxRuntimeLoader: OnnxRuntimeLoader = defaultOnnxRuntimeLoader;

/** @internal Test hook: override ONNX runtime loader. */
export function __setOnnxRuntimeLoaderForTests(loader: OnnxRuntimeLoader | null): void {
  onnxRuntimeLoader = loader ?? defaultOnnxRuntimeLoader;
}

async function loadOnnxRuntime(): Promise<OnnxRuntime> {
  try {
    return await onnxRuntimeLoader();
  } catch {
    throw new OnnxRuntimeMissingError(
      "onnxruntime-node is not installed. Install it to use provider='onnx' (e.g. npm i onnxruntime-node).",
    );
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

function sanitizeRepoDir(repo: string): string {
  return repo.replace(/[^\w.-]+/g, "__");
}

function splitRepoAndRevision(input: string): { repo: string; revision: string } {
  const at = input.lastIndexOf("@");
  if (at > 0 && at < input.length - 1) {
    return { repo: input.slice(0, at), revision: input.slice(at + 1) };
  }
  return { repo: input, revision: "main" };
}

const ONNX_DOWNLOAD_TIMEOUT_MS = 120_000;
const ONNX_DOWNLOAD_MAX_BYTES = 500 * 1024 * 1024; // 500 MiB

async function downloadFile(url: string, destPath: string): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ONNX_DOWNLOAD_TIMEOUT_MS);
  const resp = await fetch(url, { signal: controller.signal });
  clearTimeout(timeoutId);
  if (!resp.ok || !resp.body) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Failed to download ${url}: HTTP ${resp.status} ${resp.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`);
  }
  const contentLength = resp.headers.get("content-length");
  if (contentLength) {
    const len = Number.parseInt(contentLength, 10);
    if (!Number.isNaN(len) && len > ONNX_DOWNLOAD_MAX_BYTES) {
      throw new Error(`Refusing to download ${url}: size ${len} exceeds limit ${ONNX_DOWNLOAD_MAX_BYTES}`);
    }
  }
  await fs.mkdir(dirname(destPath), { recursive: true });
  const tempPath = `${destPath}.tmp`;
  const stream = Readable.fromWeb(resp.body as import("stream/web").ReadableStream<Uint8Array>);
  try {
    let bytesWritten = 0;
    const countStream = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytesWritten += chunk.length;
        if (bytesWritten > ONNX_DOWNLOAD_MAX_BYTES) {
          cb(new Error(`Download size exceeds limit ${ONNX_DOWNLOAD_MAX_BYTES}`));
          return;
        }
        cb(null, chunk);
      },
    });
    await pipeline(stream, countStream, createWriteStream(tempPath));
    await fs.rename(tempPath, destPath);
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }
}

async function resolveOnnxModelFiles(
  model: string,
  opts?: { cacheDir?: string; modelPath?: string; vocabPath?: string },
): Promise<{ modelPath: string; vocabPath: string }> {
  const cacheDir = opts?.cacheDir ?? DEFAULT_ONNX_CACHE_DIR;
  if (opts?.modelPath) {
    const modelPath = resolve(opts.modelPath);
    if (!(await fileExists(modelPath))) {
      throw new Error(`ONNX model file not found at ${modelPath}`);
    }
    const vocabPath = opts?.vocabPath
      ? resolve(opts.vocabPath)
      : join(dirname(modelPath), "vocab.txt");
    if (!(await fileExists(vocabPath))) {
      throw new Error(`Tokenizer vocab.txt not found at ${vocabPath}`);
    }
    return { modelPath, vocabPath };
  }

  const resolvedModelPath = resolve(model);
  if (model.endsWith(".onnx") && await fileExists(resolvedModelPath)) {
    const vocabPath = opts?.vocabPath
      ? resolve(opts.vocabPath)
      : join(dirname(resolvedModelPath), "vocab.txt");
    if (!(await fileExists(vocabPath))) {
      throw new Error(`Tokenizer vocab.txt not found at ${vocabPath}`);
    }
    return { modelPath: resolvedModelPath, vocabPath };
  }

  const spec = ONNX_MODEL_SPECS[model];
  const { repo, revision } = splitRepoAndRevision(spec?.repo ?? model);
  const modelFile = spec?.modelFile ?? "onnx/model.onnx";
  const vocabCandidates = spec?.vocabFileCandidates ?? ["vocab.txt", "tokenizer/vocab.txt"];
  const repoDir = join(cacheDir, sanitizeRepoDir(repo), revision);
  const modelPath = join(repoDir, modelFile);
  if (!(await fileExists(modelPath))) {
    const modelUrl = `https://huggingface.co/${repo}/resolve/${revision}/${modelFile}`;
    await downloadFile(modelUrl, modelPath);
  }
  let vocabPath = opts?.vocabPath ? resolve(opts.vocabPath) : "";
  if (vocabPath && !(await fileExists(vocabPath))) {
    throw new Error(`Tokenizer vocab.txt not found at ${vocabPath}`);
  }
  if (!vocabPath) {
    for (const candidate of vocabCandidates) {
      const candidatePath = join(repoDir, candidate);
      if (await fileExists(candidatePath)) {
        vocabPath = candidatePath;
        break;
      }
      const vocabUrl = `https://huggingface.co/${repo}/resolve/${revision}/${candidate}`;
      try {
        await downloadFile(vocabUrl, candidatePath);
        vocabPath = candidatePath;
        break;
      } catch {
        continue;
      }
    }
  }
  if (!vocabPath) {
    throw new Error(`Unable to locate or download vocab.txt for model '${model}'.`);
  }
  return { modelPath, vocabPath };
}

function normalizeText(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function isPunctuation(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code >= 33 && code <= 47) ||
    (code >= 58 && code <= 64) ||
    (code >= 91 && code <= 96) ||
    (code >= 123 && code <= 126)
  );
}

function basicTokenize(text: string): string[] {
  const normalized = normalizeText(text).toLowerCase();
  const tokens: string[] = [];
  let current = "";
  for (const ch of normalized) {
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    if (isPunctuation(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      tokens.push(ch);
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function wordPieceTokenize(token: string, vocab: Map<string, number>, unkToken: string, maxChars = 100): string[] {
  if (token.length > maxChars) return [unkToken];
  if (vocab.has(token)) return [token];
  const chars = token.split("");
  const pieces: string[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = chars.length;
    let found = "";
    while (start < end) {
      const substr = chars.slice(start, end).join("");
      const candidate = start === 0 ? substr : `##${substr}`;
      if (vocab.has(candidate)) {
        found = candidate;
        break;
      }
      end -= 1;
    }
    if (!found) {
      return [unkToken];
    }
    pieces.push(found);
    start = end;
  }
  return pieces;
}

type TokenizedInput = { inputIds: number[]; attentionMask: number[]; tokenTypeIds: number[] };

class WordPieceTokenizer {
  private vocab: Map<string, number>;
  private readonly clsToken: string;
  private readonly sepToken: string;
  private readonly padToken: string;
  private readonly unkToken: string;

  constructor(vocab: Map<string, number>) {
    this.vocab = vocab;
    this.clsToken = "[CLS]";
    this.sepToken = "[SEP]";
    this.padToken = "[PAD]";
    this.unkToken = "[UNK]";
    for (const tok of [this.clsToken, this.sepToken, this.padToken, this.unkToken]) {
      if (!this.vocab.has(tok)) {
        throw new Error(`Tokenizer vocab missing required token ${tok}`);
      }
    }
  }

  encode(text: string, maxLen: number): TokenizedInput {
    const tokens = basicTokenize(text).flatMap((t) => wordPieceTokenize(t, this.vocab, this.unkToken));
    const maxTokens = Math.max(0, maxLen - 2);
    const trimmed = tokens.length > maxTokens ? tokens.slice(0, maxTokens) : tokens;
    const finalTokens = [this.clsToken, ...trimmed, this.sepToken];
    const inputIds = finalTokens.map((t) => this.vocab.get(t) ?? this.vocab.get(this.unkToken)!);
    const attentionMask = new Array(finalTokens.length).fill(1);
    const tokenTypeIds = new Array(finalTokens.length).fill(0);
    return { inputIds, attentionMask, tokenTypeIds };
  }

  getPadTokenId(): number {
    return this.vocab.get(this.padToken)!;
  }
}

async function loadVocab(vocabPath: string): Promise<Map<string, number>> {
  const content = await fs.readFile(vocabPath, "utf-8");
  const vocab = new Map<string, number>();
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const token = lines[i].trim();
    if (!token) continue;
    vocab.set(token, i);
  }
  return vocab;
}

function l2Normalize(vec: Float32Array): Float32Array {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum);
  if (!norm) return vec;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

function meanPool(lastHidden: Float32Array, attentionMask: BigInt64Array, batch: number, seq: number, hidden: number): Float32Array[] {
  const outputs: Float32Array[] = [];
  let offset = 0;
  for (let b = 0; b < batch; b++) {
    const out = new Float32Array(hidden);
    let count = 0;
    for (let s = 0; s < seq; s++) {
      const mask = attentionMask[b * seq + s];
      if (mask === 0n) {
        offset += hidden;
        continue;
      }
      for (let h = 0; h < hidden; h++) {
        out[h] += lastHidden[offset + h];
      }
      count++;
      offset += hidden;
    }
    if (count > 0) {
      for (let h = 0; h < hidden; h++) out[h] /= count;
    }
    outputs.push(out);
  }
  return outputs;
}

export class OnnxEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  readonly modelName: string;
  private readonly batchSize: number;
  private readonly maxSeqLength: number;
  private readonly cacheDir?: string;
  private readonly modelPath?: string;
  private readonly vocabPath?: string;
  private session?: import("onnxruntime-node").InferenceSession;
  private tokenizer?: WordPieceTokenizer;
  private ort?: OnnxRuntime;
  private ready?: Promise<void>;

  constructor(opts: {
    model: string;
    dimensions: number;
    batchSize?: number;
    maxSeqLength?: number;
    cacheDir?: string;
    modelPath?: string;
    vocabPath?: string;
  }) {
    this.modelName = opts.model;
    this.dimensions = opts.dimensions;
    this.batchSize = opts.batchSize || 32;
    this.maxSeqLength = opts.maxSeqLength || DEFAULT_ONNX_MAX_SEQ_LEN;
    this.cacheDir = opts.cacheDir;
    this.modelPath = opts.modelPath;
    this.vocabPath = opts.vocabPath;
  }

  private async ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        try {
          this.ort = await loadOnnxRuntime();
          const { modelPath, vocabPath } = await resolveOnnxModelFiles(this.modelName, {
            cacheDir: this.cacheDir,
            modelPath: this.modelPath,
            vocabPath: this.vocabPath,
          });
          const vocab = await loadVocab(vocabPath);
          this.tokenizer = new WordPieceTokenizer(vocab);
          this.session = await this.ort.InferenceSession.create(modelPath);
        } catch (err) {
          this.ready = undefined;
          throw err;
        }
      })();
    }
    await this.ready;
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    if (results.length === 0) {
      throw new Error("ONNX embed returned empty results for single text");
    }
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    await this.ensureReady();
    if (!this.session || !this.tokenizer || !this.ort) {
      throw new Error("ONNX embedding provider not initialized");
    }

    const allResults: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const encoded = batch.map((t) => this.tokenizer!.encode(t, this.maxSeqLength));
      const maxLen = Math.min(
        this.maxSeqLength,
        Math.max(...encoded.map((e) => e.inputIds.length)),
      );
      const padId = this.tokenizer!.getPadTokenId();
      for (const e of encoded) {
        while (e.inputIds.length < maxLen) {
          e.inputIds.push(padId);
          e.attentionMask.push(0);
          e.tokenTypeIds.push(0);
        }
      }
      const batchSize = encoded.length;
      const inputIds = new BigInt64Array(batchSize * maxLen);
      const attentionMask = new BigInt64Array(batchSize * maxLen);
      const tokenTypeIds = new BigInt64Array(batchSize * maxLen);
      for (let b = 0; b < batchSize; b++) {
        const e = encoded[b];
        for (let t = 0; t < maxLen; t++) {
          const idx = b * maxLen + t;
          inputIds[idx] = BigInt(e.inputIds[t] ?? 0);
          attentionMask[idx] = BigInt(e.attentionMask[t] ?? 0);
          tokenTypeIds[idx] = BigInt(e.tokenTypeIds[t] ?? 0);
        }
      }
      const feeds: Record<string, import("onnxruntime-node").Tensor> = {};
      const inputNames = this.session.inputNames;
      if (!inputNames.includes("input_ids")) {
        throw new Error("ONNX model input does not include input_ids");
      }
      feeds["input_ids"] = new this.ort.Tensor("int64", inputIds, [batchSize, maxLen]);
      if (inputNames.includes("attention_mask")) {
        feeds["attention_mask"] = new this.ort.Tensor("int64", attentionMask, [batchSize, maxLen]);
      }
      if (inputNames.includes("token_type_ids")) {
        feeds["token_type_ids"] = new this.ort.Tensor("int64", tokenTypeIds, [batchSize, maxLen]);
      }

      const output = await this.session.run(feeds);
      const outputTensor =
        output["sentence_embedding"] ??
        output["pooler_output"] ??
        output["last_hidden_state"];
      if (!outputTensor) {
        throw new Error("ONNX output missing sentence_embedding/pooler_output/last_hidden_state");
      }
      const data = outputTensor.data as Float32Array;
      const dims = outputTensor.dims as number[];
      let vectors: Float32Array[] = [];
      if (outputTensor === output["last_hidden_state"]) {
        const [b, s, h] = dims;
        if (!b || !s || !h) throw new Error("ONNX last_hidden_state has invalid dims");
        vectors = meanPool(data, attentionMask, b, s, h);
      } else {
        const [b, h] = dims;
        if (!b || !h) throw new Error("ONNX output has invalid dims");
        for (let bi = 0; bi < b; bi++) {
          const start = bi * h;
          vectors.push(data.slice(start, start + h));
        }
      }
      if (vectors.length !== batchSize) {
        throw new Error(`ONNX embed returned ${vectors.length} embeddings for ${batchSize} inputs`);
      }
      for (const vec of vectors) {
        const normalized = l2Normalize(vec);
        if (normalized.length !== this.dimensions) {
          throw new Error(`ONNX embedding dimension mismatch: expected ${this.dimensions}, got ${normalized.length}`);
        }
        allResults.push(Array.from(normalized));
      }
    }
    return allResults;
  }
}

/** Hash text for cache key (prevents large text strings as Map keys). */
function hashText(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

function makeCacheKey(model: string, text: string): string {
  return `${model}:${hashText(text)}`;
}

/** Returns true when the error is a 404 (model not found) — either directly or wrapped in LLMRetryError. */
function is404OrWrapped(err: Error): boolean {
  if (is404Like(err)) return true;
  if (err instanceof LLMRetryError && is404Like(err.cause)) return true;
  return false;
}

/** Returns true when the error is a 403 (access forbidden — country/region restriction, IP block) —
 * either directly or wrapped in an LLMRetryError.
 * Note: withLLMRetry short-circuits on 403 and rethrows directly, so 403s rarely arrive wrapped,
 * but we handle both forms for robustness.
 */
function is403OrWrapped(err: Error): boolean {
  if (is403Like(err)) return true;
  if (err instanceof LLMRetryError && is403Like(err.cause)) return true;
  return false;
}

/** Helper: check if an error is a 401 auth failure.
 * Uses the same regex as withLLMRetry (/\b401\b|unauthorized/i) to ensure consistency. */
function is401Like(err: unknown): boolean {
  if (err && typeof err === "object") {
    const status = (err as { status?: unknown }).status;
    if (status === 401 || status === "401") return true;
  }
  if (err instanceof Error) {
    // Match the same pattern as withLLMRetry: bare "401" as word boundary OR "unauthorized"
    if (/\b401\b|unauthorized/i.test(err.message)) return true;
    // Also match specific auth failure phrases for robustness
    if (/incorrect api key|invalid api key|authentication failed/i.test(err.message)) return true;
  }
  return false;
}

/** Returns true when the error is a 401 (auth failure) — either directly or wrapped in LLMRetryError.
 * Handles both direct status and message-only auth errors (e.g. Ollama plain Error with "HTTP 401 Unauthorized").
 * Note: withLLMRetry short-circuits on 401 and rethrows directly, so 401s rarely arrive wrapped,
 * but we handle both forms for robustness (consistent with is404OrWrapped and is403OrWrapped). */
function is401OrWrapped(err: Error): boolean {
  if (is401Like(err)) return true;
  if (err instanceof LLMRetryError && is401Like(err.cause)) return true;
  return false;
}

/** Returns true when err is a configuration error (404 model-not-found, 403 country/region restriction, or 401 auth failure).
 * Used to suppress capturePluginError for errors that are always operator config issues (#329, #394, #385). */
function isConfigError(err: Error): boolean {
  return is404OrWrapped(err) || is403OrWrapped(err) || is401OrWrapped(err);
}

/**
 * OpenAI-based embedding provider.
 * Uses a cache, supports model preference lists (try in order on failure).
 */
export class Embeddings implements EmbeddingProvider {
  private client: OpenAI;
  private cache = new Map<string, number[]>();
  /** Ordered list: try first model, on failure try next (all must produce same vector dimension). */
  private readonly models: string[];
  readonly dimensions: number;
  modelName: string;
  private readonly batchSize: number;

  constructor(
    clientOrApiKey: OpenAI | string,
    modelOrModels: string | string[],
    dimensions?: number,
    batchSize?: number,
  ) {
    this.client = typeof clientOrApiKey === "string"
      ? new OpenAI({ apiKey: clientOrApiKey })
      : clientOrApiKey;
    this.models = Array.isArray(modelOrModels) ? modelOrModels : [modelOrModels];
    if (this.models.length === 0) throw new Error("Embeddings requires at least one model");
    this.modelName = this.models[0];
    this.dimensions = dimensions ?? 1536; // default: text-embedding-3-small
    this.batchSize = batchSize || 2048;
    
    // Validate dimensions against known model limits and capabilities
    const modelMaxDimensions: Record<string, number> = {
      "text-embedding-3-small": 1536,
      "text-embedding-3-large": 3072,
    };
    const modelNativeDimensions: Record<string, number> = {
      "text-embedding-3-small": 1536,
      "text-embedding-3-large": 3072,
      "text-embedding-ada-002": 1536,
    };
    for (const model of this.models) {
      const maxDim = modelMaxDimensions[model];
      if (maxDim !== undefined && this.dimensions > maxDim) {
        throw new Error(`Dimensions ${this.dimensions} exceed maximum ${maxDim} for model ${model}`);
      }
      const nativeDim = modelNativeDimensions[model];
      const supportsDimensions = model.startsWith("text-embedding-3-");
      if (nativeDim !== undefined && this.dimensions !== nativeDim && !supportsDimensions) {
        throw new Error(`Model ${model} does not support custom dimensions (native: ${nativeDim}, requested: ${this.dimensions}). Use a text-embedding-3-* model for custom dimensions.`);
      }
    }
  }

  async embed(text: string): Promise<number[]> {
    // Check cache for any model before making API calls.
    // This prevents redundant API calls when the primary model consistently fails
    // and a fallback model's cached result would be immediately available.
    for (const model of this.models) {
      const cacheKey = makeCacheKey(model, text);
      const cached = this.cache.get(cacheKey);
      if (cached !== undefined) {
        // LRU refresh: move to end
        this.cache.delete(cacheKey);
        this.cache.set(cacheKey, cached);
        this.modelName = model;
        return cached;
      }
    }

    let lastErr: Error | undefined;
    for (const model of this.models) {
      const cacheKey = makeCacheKey(model, text);
      const cached = this.cache.get(cacheKey);
      if (cached !== undefined) {
        this.cache.delete(cacheKey);
        this.cache.set(cacheKey, cached);
        this.modelName = model;
        return cached;
      }
      try {
        const supportsDimensions = model.startsWith("text-embedding-3-");
        // Truncate to stay within the 8192-token OpenAI embedding limit (#442)
        const input = truncateForEmbedding(text);
        const resp = await withLLMRetry(
          () => this.client.embeddings.create({
            model,
            input,
            ...(supportsDimensions ? { dimensions: this.dimensions } : {}),
          }),
          { maxRetries: 2 },
        );
        const vector = resp.data[0].embedding;
        if (this.cache.size >= EMBEDDING_CACHE_MAX) {
          const firstKey = this.cache.keys().next().value;
          if (firstKey !== undefined) this.cache.delete(firstKey);
        }
        const storeCacheKey = makeCacheKey(model, text);
        this.cache.set(storeCacheKey, vector);
        this.modelName = model;
        return vector;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        continue;
      }
    }
    // lastErr is always defined here: constructor enforces models.length >= 1, so
    // the loop always runs at least once; either it returns early (success) or
    // sets lastErr on every iteration before reaching this point.
    // Skip reporting config errors (404 model-not-found, 403 country/region restriction, 401 auth failure) and 429 (rate limit) — operator config issues or transient errors, not bugs (#329, #394, #397, #385).
    if (!isConfigError(lastErr!) && !is429OrWrapped(lastErr!)) {
      capturePluginError(lastErr!, {
        subsystem: "embeddings",
        operation: "embed",
        phase: "fallback-exhausted",
      });
    }
    throw lastErr!;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    
    const allResults: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      
      let lastErr: Error | undefined;
      let resp: Awaited<ReturnType<typeof this.client.embeddings.create>> | undefined;
      for (const model of this.models) {
        try {
          const supportsDimensions = model.startsWith("text-embedding-3-");
          // Truncate each item to stay within the 8192-token OpenAI embedding limit (#442)
          const truncatedBatch = batch.map(truncateForEmbedding);
          resp = await withLLMRetry(
            () => this.client.embeddings.create({
              model,
              input: truncatedBatch,
              ...(supportsDimensions ? { dimensions: this.dimensions } : {}),
            }),
            { maxRetries: 2 },
          );
          this.modelName = model;
          break;
        } catch (err) {
          lastErr = err instanceof Error ? err : new Error(String(err));
          continue;
        }
      }
      if (resp !== undefined) {
        if (resp.data.length !== batch.length) {
          throw new Error(`OpenAI embed returned ${resp.data.length} embeddings for ${batch.length} inputs`);
        }
        allResults.push(
          ...resp.data
            .sort((a, b) => a.index - b.index)
            .map((item) => item.embedding),
        );
      }
      if (lastErr !== undefined && allResults.length === i) {
        // Skip reporting config errors (404 model-not-found, 403 country/region restriction, 401 auth failure) and 429 (rate limit) — operator config issues or transient errors, not bugs (#329, #394, #397, #385).
        if (!isConfigError(lastErr) && !is429OrWrapped(lastErr)) {
          capturePluginError(lastErr, {
            subsystem: "embeddings",
            operation: "embedBatch",
            phase: "fallback-exhausted",
          });
        }
        throw lastErr;
      }
    }
    return allResults;
  }
}

const OLLAMA_MAX_FAILS = 3;
const OLLAMA_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Module-level circuit breaker state keyed by Ollama endpoint URL.
 * Shared across all OllamaEmbeddingProvider instances so that a failure on
 * one instance is visible to new instances pointing at the same endpoint,
 * while endpoints at different base URLs remain independent.
 */
const _ollamaCircuitByEndpoint = new Map<string, { failCount: number; disabledUntil: number }>();

function _getOllamaCircuit(endpoint: string): { failCount: number; disabledUntil: number } {
  if (!_ollamaCircuitByEndpoint.has(endpoint)) {
    _ollamaCircuitByEndpoint.set(endpoint, { failCount: 0, disabledUntil: 0 });
  }
  return _ollamaCircuitByEndpoint.get(endpoint)!;
}

/**
 * Reset the Ollama circuit breaker state for a given endpoint (or all endpoints if omitted).
 * Intended for use in tests only — do not call in production code.
 */
export function _resetOllamaCircuitBreakerForTesting(endpoint?: string): void {
  if (endpoint) {
    _ollamaCircuitByEndpoint.delete(endpoint);
  } else {
    _ollamaCircuitByEndpoint.clear();
  }
}

/**
 * Ollama-based embedding provider.
 * Calls Ollama REST API (POST /api/embed) — no external API key required.
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  readonly modelName: string;
  private readonly endpoint: string;
  private readonly batchSize: number;

  constructor(opts: {
    model: string;
    dimensions: number;
    endpoint?: string;
    batchSize?: number;
  }) {
    this.modelName = opts.model;
    this.dimensions = opts.dimensions;
    this.endpoint = (opts.endpoint ?? "http://localhost:11434").replace(/\/$/, "");
    this.batchSize = opts.batchSize || 50;
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    if (results.length === 0) {
      throw new Error(`Ollama embed returned empty results for single text`);
    }
    return results[0];
  }

  /** Maximum characters per input text sent to Ollama (~2000 tokens for most models). */
  private static readonly MAX_INPUT_CHARS = 8000;

  async embedBatch(texts: string[]): Promise<number[][]> {
    // Circuit breaker: shared per endpoint so all instances pointing at the same URL are gated together.
    // This prevents one bad endpoint from being retried across separately-constructed instances,
    // while leaving providers at different base URLs unaffected.
    const circuit = _getOllamaCircuit(this.endpoint);
    if (Date.now() < circuit.disabledUntil) {
      throw new Error(`Ollama circuit breaker open — disabled until ${new Date(circuit.disabledUntil).toISOString()} (endpoint: ${this.endpoint})`);
    }

    const allResults: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize).map((t) => {
        if (t.length > OllamaEmbeddingProvider.MAX_INPUT_CHARS) {
          console.warn(
            `memory-hybrid: Truncating embedding input from ${t.length} to ${OllamaEmbeddingProvider.MAX_INPUT_CHARS} chars for ${this.modelName}`,
          );
          return t.slice(0, OllamaEmbeddingProvider.MAX_INPUT_CHARS);
        }
        return t;
      });
      let resp: Response;
      try {
        resp = await fetch(`${this.endpoint}/api/embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: this.modelName, input: batch }),
        });
      } catch (err) {
        // Connection failure — update shared circuit breaker state for this endpoint
        circuit.failCount++;
        if (circuit.failCount >= OLLAMA_MAX_FAILS) {
          circuit.disabledUntil = Date.now() + OLLAMA_COOLDOWN_MS;
          console.warn(
            `memory-hybrid: Ollama circuit breaker open — disabling endpoint ${this.endpoint} for 5min after ${circuit.failCount} failures`,
          );
        }
        throw new Error(`Ollama connection failed (${this.endpoint}): ${err}`);
      }
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        const errMsg = `Ollama embed failed: HTTP ${resp.status} ${resp.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`;
        // OOM: trip circuit breaker immediately — retrying the same model won't free memory.
        const isOOM =
          body.toLowerCase().includes("model requires more system memory") ||
          body.toLowerCase().includes("not enough memory to load") ||
          /\bmodel\s+requires\s+[\d.]+\s*gib/i.test(body) ||
          /\boom:/i.test(body);
        if (isOOM) {
          circuit.disabledUntil = Date.now() + OLLAMA_COOLDOWN_MS;
          circuit.failCount = OLLAMA_MAX_FAILS;
          console.warn(
            `memory-hybrid: Ollama model OOM (${this.modelName}) — model requires more memory than available. ` +
            `Circuit breaker tripped; disabling endpoint ${this.endpoint} for 5min. ` +
            `Consider using a smaller model or configuring a cloud embedding fallback.`
          );
        }
        throw new Error(errMsg);
      }
      const data = await resp.json() as { embeddings: number[][] };
      if (!Array.isArray(data.embeddings)) {
        throw new Error(`Ollama embed response missing 'embeddings' array`);
      }
      if (data.embeddings.length === 0) {
        throw new Error(`Ollama embed returned empty 'embeddings' array (expected ${batch.length})`);
      }
      if (data.embeddings.length !== batch.length) {
        throw new Error(`Ollama embed returned ${data.embeddings.length} embeddings for ${batch.length} inputs`);
      }
      allResults.push(...data.embeddings);
    }
    // Successful call — reset circuit breaker for this endpoint
    circuit.failCount = 0;
    circuit.disabledUntil = 0;
    return allResults;
  }
}

/**
 * Wrapper that tries a primary provider and switches permanently to a fallback on first failure.
 * Useful for Ollama → OpenAI fallback when Ollama is temporarily unavailable.
 */
export class FallbackEmbeddingProvider implements EmbeddingProvider {
  private active: EmbeddingProvider;
  private readonly primary: EmbeddingProvider;
  private readonly fallback: EmbeddingProvider | null;
  private switched = false;
  private lastRetryAttempt = 0;
  private readonly retryIntervalMs = 60000;
  private readonly onSwitch?: (err: unknown) => void;
  private readonly primaryLabel: string;
  private readonly fallbackLabel: string;
  readonly dimensions: number;
  modelName: string;
  /** "ollama" when using primary, "openai" when using fallback (so logs reflect actual provider). */
  get activeProvider(): string {
    return this.switched ? this.fallbackLabel : this.primaryLabel;
  }

  constructor(
    primary: EmbeddingProvider,
    fallback: EmbeddingProvider | null,
    onSwitch?: (err: unknown) => void,
    primaryLabel = "ollama",
    fallbackLabel = "openai",
  ) {
    if (fallback && fallback.dimensions !== primary.dimensions) {
      throw new Error(
        `Primary (${primary.modelName}: ${primary.dimensions}d) and fallback ` +
        `(${fallback.modelName}: ${fallback.dimensions}d) must have matching dimensions`,
      );
    }
    this.active = primary;
    this.primary = primary;
    this.fallback = fallback;
    this.onSwitch = onSwitch;
    this.primaryLabel = primaryLabel;
    this.fallbackLabel = fallbackLabel;
    this.dimensions = primary.dimensions;
    this.modelName = primary.modelName;
  }

  async embed(text: string): Promise<number[]> {
    if (!this.fallback) {
      return this.active.embed(text);
    }
    if (this.switched && Date.now() - this.lastRetryAttempt >= this.retryIntervalMs) {
      this.lastRetryAttempt = Date.now();
      try {
        const result = await this.primary.embed(text);
        this.active = this.primary;
        this.switched = false;
        this.modelName = this.active.modelName;
        return result;
      } catch (err) {
        const asErr = err instanceof Error ? err : new Error(String(err));
        // Skip reporting config errors (404 model-not-found, 403 country/region restriction, 401 auth failure) and 429 (rate limit) — operator config issues or transient errors, not bugs (#329, #394, #397, #385).
        if (!isConfigError(asErr) && !is429OrWrapped(asErr)) {
          capturePluginError(asErr, {
            subsystem: "embeddings",
            operation: "fallback-retry-primary",
            phase: "embed",
          });
        }
        // Primary still failing — continue using fallback
      }
    }
    if (this.switched) {
      return this.active.embed(text);
    }
    try {
      return await this.active.embed(text);
    } catch (err) {
      const asErr = err instanceof Error ? err : new Error(String(err));
      // Skip reporting config errors (404 model-not-found, 403 country/region restriction, 401 auth failure) and 429 (rate limit) — operator config issues or transient errors, not bugs (#329, #394, #397, #385).
      if (!isConfigError(asErr) && !is429OrWrapped(asErr)) {
        capturePluginError(asErr, {
          subsystem: "embeddings",
          operation: "fallback-switch",
          phase: "embed",
        });
      }
      this.onSwitch?.(err);
      this.active = this.fallback;
      this.switched = true;
      this.lastRetryAttempt = Date.now();
      this.modelName = this.active.modelName;
      return this.active.embed(text);
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.fallback) {
      return this.active.embedBatch(texts);
    }
    if (this.switched && Date.now() - this.lastRetryAttempt >= this.retryIntervalMs) {
      this.lastRetryAttempt = Date.now();
      try {
        const result = await this.primary.embedBatch(texts);
        this.active = this.primary;
        this.switched = false;
        this.modelName = this.active.modelName;
        return result;
      } catch (err) {
        const asErr = err instanceof Error ? err : new Error(String(err));
        // Skip reporting config errors (404 model-not-found, 403 country/region restriction, 401 auth failure) and 429 (rate limit) — operator config issues or transient errors, not bugs (#329, #394, #397, #385).
        if (!isConfigError(asErr) && !is429OrWrapped(asErr)) {
          capturePluginError(asErr, {
            subsystem: "embeddings",
            operation: "fallback-retry-primary",
            phase: "embedBatch",
          });
        }
        // Primary still failing — continue using fallback
      }
    }
    if (this.switched) {
      return this.active.embedBatch(texts);
    }
    try {
      return await this.active.embedBatch(texts);
    } catch (err) {
      const asErr = err instanceof Error ? err : new Error(String(err));
      // Skip reporting config errors (404 model-not-found, 403 country/region restriction, 401 auth failure) and 429 (rate limit) — operator config issues or transient errors, not bugs (#329, #394, #397, #385).
      if (!isConfigError(asErr) && !is429OrWrapped(asErr)) {
        capturePluginError(asErr, {
          subsystem: "embeddings",
          operation: "fallback-switch",
          phase: "embedBatch",
        });
      }
      this.onSwitch?.(err);
      this.active = this.fallback;
      this.switched = true;
      this.lastRetryAttempt = Date.now();
      this.modelName = this.active.modelName;
      return this.active.embedBatch(texts);
    }
  }
}

/**
 * Tries a list of embedding providers in order; first success wins (no retry of earlier providers).
 * Aligns with LLM failover: same idea as getLLMModelPreference / tier; Ollama can be first tier.
 */
export class ChainEmbeddingProvider implements EmbeddingProvider {
  private readonly providers: EmbeddingProvider[];
  private readonly labels: string[];
  private activeIndex = 0;
  /** Per-provider cooldown: maps provider index → { timestamp until which it should be skipped, original error }.
   *  Config errors (401/403/404) mark a provider as failed for CHAIN_PROVIDER_COOLDOWN_MS so we
   *  don't waste a round-trip retrying a known-broken provider on every call (#385 Bug 4). */
  private readonly failedUntil = new Map<number, { expiry: number; error: Error }>();
  private static readonly COOLDOWN_MS = 60_000; // 60s, matches FallbackEmbeddingProvider.retryIntervalMs
  readonly dimensions: number;
  modelName: string;
  get activeProvider(): string {
    return this.labels[this.activeIndex];
  }

  constructor(providers: EmbeddingProvider[], labels: string[]) {
    if (providers.length === 0 || providers.length !== labels.length) {
      throw new Error("ChainEmbeddingProvider requires non-empty providers and same-length labels");
    }
    const dim = providers[0].dimensions;
    if (providers.some((p) => p.dimensions !== dim)) {
      throw new Error("ChainEmbeddingProvider: all providers must have the same dimensions");
    }
    this.providers = providers;
    this.labels = labels;
    this.dimensions = dim;
    this.modelName = providers[0].modelName;
  }

  async embed(text: string): Promise<number[]> {
    let currentIndex = 0;
    this.modelName = this.providers[0].modelName;
    const collectedErrors: Error[] = [];
    const now = Date.now();
    while (currentIndex < this.providers.length) {
      // Skip providers in cooldown (config errors like 401/403/404). Expire stale entries.
      const cooldownEntry = this.failedUntil.get(currentIndex);
      if (cooldownEntry !== undefined) {
        if (now < cooldownEntry.expiry) {
          // Still in cooldown — add the original error to collectedErrors so safeEmbed can suppress correctly
          collectedErrors.push(cooldownEntry.error);
          currentIndex++;
          if (currentIndex < this.providers.length) {
            this.modelName = this.providers[currentIndex].modelName;
          }
          continue;
        }
        // Cooldown expired — let this provider retry
        this.failedUntil.delete(currentIndex);
      }
      try {
        const result = await this.providers[currentIndex].embed(text);
        // Success — clear any lingering cooldown (belt-and-suspenders)
        this.failedUntil.delete(currentIndex);
        this.activeIndex = currentIndex;
        return result;
      } catch (err) {
        // Only capture individual provider failures when there are remaining fallbacks.
        // When this is the last provider, we'll degrade gracefully via AllEmbeddingProvidersFailed.
        // Skip config errors (404 model-not-found, 403 country/region restriction, 401 auth failure) — always operator issues (#329, #394, #385).
        const asErr = err instanceof Error ? err : new Error(String(err));
        collectedErrors.push(asErr);
        // Mark config-error providers for cooldown so we don't waste round-trips on them every call.
        if (isConfigError(asErr)) {
          this.failedUntil.set(currentIndex, { expiry: Date.now() + ChainEmbeddingProvider.COOLDOWN_MS, error: asErr });
        }
        const isLast = currentIndex + 1 >= this.providers.length;
        if (!isLast && !isConfigError(asErr) && !is429OrWrapped(asErr)) {
          capturePluginError(asErr, {
            subsystem: "embeddings",
            operation: "chain-failover",
            phase: "embed",
          });
        }
        currentIndex++;
        if (currentIndex < this.providers.length) {
          this.modelName = this.providers[currentIndex].modelName;
        }
      }
    }
    // All providers exhausted — throw a typed error so callers can degrade gracefully
    // without reporting noise to error monitoring.
    throw new AllEmbeddingProvidersFailed(collectedErrors);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    let currentIndex = 0;
    this.modelName = this.providers[0].modelName;
    const collectedErrors: Error[] = [];
    const now = Date.now();
    while (currentIndex < this.providers.length) {
      // Skip providers in cooldown (config errors like 401/403/404). Expire stale entries.
      const cooldownEntry = this.failedUntil.get(currentIndex);
      if (cooldownEntry !== undefined) {
        if (now < cooldownEntry.expiry) {
          // Still in cooldown — add the original error to collectedErrors so safeEmbed can suppress correctly
          collectedErrors.push(cooldownEntry.error);
          currentIndex++;
          if (currentIndex < this.providers.length) {
            this.modelName = this.providers[currentIndex].modelName;
          }
          continue;
        }
        // Cooldown expired — let this provider retry
        this.failedUntil.delete(currentIndex);
      }
      try {
        const result = await this.providers[currentIndex].embedBatch(texts);
        this.failedUntil.delete(currentIndex);
        this.activeIndex = currentIndex;
        return result;
      } catch (err) {
        // Skip config errors (404 model-not-found, 403 country/region restriction, 401 auth failure) — always operator issues (#329, #394, #385).
        const asErr = err instanceof Error ? err : new Error(String(err));
        collectedErrors.push(asErr);
        // Mark config-error providers for cooldown so we don't waste round-trips on them every call.
        if (isConfigError(asErr)) {
          this.failedUntil.set(currentIndex, { expiry: Date.now() + ChainEmbeddingProvider.COOLDOWN_MS, error: asErr });
        }
        const isLast = currentIndex + 1 >= this.providers.length;
        if (!isLast && !isConfigError(asErr) && !is429OrWrapped(asErr)) {
          capturePluginError(asErr, {
            subsystem: "embeddings",
            operation: "chain-failover",
            phase: "embedBatch",
          });
        }
        currentIndex++;
        if (currentIndex < this.providers.length) {
          this.modelName = this.providers[currentIndex].modelName;
        }
      }
    }
    throw new AllEmbeddingProvidersFailed(collectedErrors);
  }
}

/**
 * Factory: creates the right EmbeddingProvider from plugin config.
 * - When embedding.preferredProviders has length > 1: chain (try in order; aligns with LLM failover, Ollama-as-tier).
 * - provider='ollama' → OllamaEmbeddingProvider (with optional OpenAI fallback if apiKey set)
 * - provider='openai' → Embeddings (OpenAI)
 * - provider='onnx'   → OnnxEmbeddingProvider (with optional OpenAI fallback if apiKey set)
 */
export function createEmbeddingProvider(
  cfg: EmbeddingConfig,
  onFallback?: (err: unknown) => void,
): EmbeddingProvider {
  const { provider, model, apiKey, models, dimensions, endpoint, batchSize, preferredProviders } = cfg;

  if (preferredProviders && preferredProviders.length > 1) {
    const chain: EmbeddingProvider[] = [];
    const labels: string[] = [];
    const openaiModels = models?.length ? models : ["text-embedding-3-small"];
    // All providers in the chain must use the same dimensions (config.dimensions). For ollama+openai, use 1536 and an ollama model that supports it, or 768 with openai dimension override if supported.
    const ollamaModel = model && !["text-embedding-3-small", "text-embedding-3-large", "text-embedding-ada-002"].includes(model)
      ? model
      : "nomic-embed-text";
    // Use cfg.model if it is a known Google embed model; otherwise default to text-embedding-005 (#385).
    // Non-Google model names are rejected to prevent sending them to the Google endpoint.
    const googleModel = (model && KNOWN_GOOGLE_EMBED_MODELS.has(model)) ? model : "text-embedding-005";
    for (const name of preferredProviders) {
      if (name === "ollama") {
        try {
          chain.push(new OllamaEmbeddingProvider({ model: ollamaModel, dimensions, endpoint, batchSize }));
          labels.push("ollama");
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "embeddings", operation: "chain-build-ollama" });
        }
      } else if (name === "openai" && apiKey) {
        try {
          const client = new OpenAI({ apiKey });
          chain.push(new Embeddings(client, model && ["text-embedding-3-small", "text-embedding-3-large", "text-embedding-ada-002"].includes(model) ? model : openaiModels[0], dimensions, batchSize));
          labels.push("openai");
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "embeddings", operation: "chain-build-openai" });
        }
      } else if (name === "google" && cfg.googleApiKey && cfg.googleApiKey.length >= 10) {
        try {
          const client = new OpenAI({ apiKey: cfg.googleApiKey, baseURL: GOOGLE_EMBEDDING_BASE_URL });
          chain.push(new Embeddings(client, googleModel, dimensions, batchSize));
          labels.push("google");
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "embeddings", operation: "chain-build-google" });
        }
      }
    }
    if (chain.length === 0) {
      throw new Error("embedding.preferredProviders: no provider could be built (check apiKey for openai/google, Ollama for ollama, distill.apiKey or llm.providers.google for Google).");
    }
    if (chain.length === 1) {
      return chain[0];
    }
    return new ChainEmbeddingProvider(chain, labels);
  }

  if (provider === "ollama") {
    const primary = new OllamaEmbeddingProvider({ model, dimensions, endpoint, batchSize });
    // Optional fallback to OpenAI when a key is provided
    if (apiKey) {
      const openaiClient = new OpenAI({ apiKey });
      const openaiModels = models?.length ? models : ["text-embedding-3-small"];
      try {
        const fallback = new Embeddings(openaiClient, openaiModels, dimensions, batchSize);
        return new FallbackEmbeddingProvider(primary, fallback, onFallback);
      } catch (err) {
        // Fallback creation failed (e.g. Ollama dimensions exceed all OpenAI model limits).
        // Warn the user so they know their fallback isn't working.
        console.warn(`memory-hybrid: Failed to create OpenAI fallback for Ollama provider: ${err instanceof Error ? err.message : String(err)}. Continuing with Ollama-only (no fallback).`);
        return primary;
      }
    }
    return primary;
  }

  if (provider === "openai") {
    if (!apiKey) throw new Error("OpenAI embedding provider requires embedding.apiKey");
    const openaiClient = new OpenAI({ apiKey });
    const openaiModels = models?.length ? models : [model];
    return new Embeddings(openaiClient, openaiModels, dimensions, batchSize);
  }

  if (provider === "google") {
    if (!cfg.googleApiKey || cfg.googleApiKey.length < 10) {
      throw new Error("Google embedding provider requires distill.apiKey or llm.providers.google.apiKey.");
    }
    const client = new OpenAI({ apiKey: cfg.googleApiKey, baseURL: GOOGLE_EMBEDDING_BASE_URL });
    // Use configured model only when it is a known Google embedding model; otherwise default to text-embedding-005.
    // Non-Google model names are rejected here to prevent sending them to the Google endpoint (#385).
    const googleEmbedModel = (model && KNOWN_GOOGLE_EMBED_MODELS.has(model)) ? model : "text-embedding-005";
    return new Embeddings(client, googleEmbedModel, dimensions, batchSize);
  }

  if (provider === "onnx") {
    const primary = new OnnxEmbeddingProvider({ model, dimensions, batchSize });
    if (apiKey) {
      const openaiClient = new OpenAI({ apiKey });
      const openaiModels = models?.length ? models : ["text-embedding-3-small"];
      try {
        const fallback = new Embeddings(openaiClient, openaiModels, dimensions, batchSize);
        const onSwitch = (err: unknown) => {
          if (isOnnxRuntimeMissingError(err)) {
            console.warn("memory-hybrid: onnxruntime-node not installed; falling back to OpenAI embeddings.");
          } else {
            console.warn(`memory-hybrid: ONNX embeddings failed; falling back to OpenAI. ${err instanceof Error ? err.message : String(err)}`);
          }
          onFallback?.(err);
        };
        return new FallbackEmbeddingProvider(primary, fallback, onSwitch, "onnx", "openai");
      } catch (err) {
        console.warn(`memory-hybrid: Failed to create OpenAI fallback for ONNX provider: ${err instanceof Error ? err.message : String(err)}. Continuing with ONNX-only (no fallback).`);
        return primary;
      }
    }
    return primary;
  }

  throw new Error(`Unknown embedding provider: '${provider as string}'. Valid options: openai, ollama, onnx, google.`);
}

/** Centralized embedding with error handling. Returns null on failure and optionally logs. */
export async function safeEmbed(
  provider: EmbeddingProvider,
  text: string,
  logWarn?: (msg: string) => void,
): Promise<number[] | null> {
  try {
    return await provider.embed(text);
  } catch (err) {
    const asErr = err instanceof Error ? err : new Error(String(err));
    if (err instanceof AllEmbeddingProvidersFailed) {
      // Only suppress when all individual causes are config errors (404/401/403) or 429 rate-limit errors.
      // If any cause is a transient failure (network, 5xx, etc.), still report so operators are informed.
      // When causes is empty (e.g. from non-chain providers), default to reporting.
      const allConfigOrRateLimitErrors = err.causes.length > 0 && err.causes.every(e => isConfigError(e) || is429OrWrapped(e));
      if (!allConfigOrRateLimitErrors) {
        capturePluginError(asErr, {
          operation: "safe-embed",
          subsystem: "embeddings",
        });
      }
    } else if (!isConfigError(asErr) && !is429OrWrapped(asErr)) {
      // Single-provider path: suppress 404/403/401 config errors and 429 rate-limit errors to avoid double-reporting.
      capturePluginError(asErr, {
        operation: "safe-embed",
        subsystem: "embeddings",
      });
    }
    if (logWarn) logWarn(`memory-hybrid: embedding failed: ${err}`);
    return null;
  }
}
