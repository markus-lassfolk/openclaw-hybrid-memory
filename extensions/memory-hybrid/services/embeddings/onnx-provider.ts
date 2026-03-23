/**
 * ONNX local embedding provider.
 */

import { promises as fs } from "node:fs";
import { createWriteStream } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { EmbeddingProvider } from "./types.js";

// ---------------------------------------------------------------------------
// ONNX type shims (loaded dynamically at runtime; package is optional).
// ---------------------------------------------------------------------------

interface OnnxTensor {
  data: Float32Array | Int32Array | BigInt64Array;
  dims: readonly number[];
}
interface OnnxInferenceSession {
  readonly inputNames: readonly string[];
  run(feeds: Record<string, OnnxTensor>): Promise<Record<string, OnnxTensor>>;
}
interface OnnxRuntime {
  InferenceSession: { create(modelPath: string): Promise<OnnxInferenceSession> };
  Tensor: new (type: string, data: BigInt64Array, dims: number[]) => OnnxTensor;
}
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

export class OnnxRuntimeMissingError extends Error {
  readonly code = "ONNX_RUNTIME_MISSING";
  constructor(message: string) {
    super(message);
    this.name = "OnnxRuntimeMissingError";
  }
}

export function isOnnxRuntimeMissingError(err: unknown): err is OnnxRuntimeMissingError {
  return (
    err instanceof OnnxRuntimeMissingError ||
    (err instanceof Error && (err as Error & { code?: string }).code === "ONNX_RUNTIME_MISSING")
  );
}

const defaultOnnxRuntimeLoader: OnnxRuntimeLoader = () =>
  import("onnxruntime-node") as Promise<unknown> as Promise<OnnxRuntime>;
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
    throw new Error(
      `Failed to download ${url}: HTTP ${resp.status} ${resp.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`,
    );
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
    const vocabPath = opts?.vocabPath ? resolve(opts.vocabPath) : join(dirname(modelPath), "vocab.txt");
    if (!(await fileExists(vocabPath))) {
      throw new Error(`Tokenizer vocab.txt not found at ${vocabPath}`);
    }
    return { modelPath, vocabPath };
  }

  const resolvedModelPath = resolve(model);
  if (model.endsWith(".onnx") && (await fileExists(resolvedModelPath))) {
    const vocabPath = opts?.vocabPath ? resolve(opts.vocabPath) : join(dirname(resolvedModelPath), "vocab.txt");
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
      } catch {}
    }
  }
  if (!vocabPath) {
    throw new Error(`Unable to locate or download vocab.txt for model '${model}'.`);
  }
  return { modelPath, vocabPath };
}

// ---------------------------------------------------------------------------
// Tokenizer helpers
// ---------------------------------------------------------------------------

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

function meanPool(
  lastHidden: Float32Array,
  attentionMask: BigInt64Array,
  batch: number,
  seq: number,
  hidden: number,
): Float32Array[] {
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

// ---------------------------------------------------------------------------
// OnnxEmbeddingProvider
// ---------------------------------------------------------------------------

export class OnnxEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  readonly modelName: string;
  private readonly batchSize: number;
  private readonly maxSeqLength: number;
  private readonly cacheDir?: string;
  private readonly modelPath?: string;
  private readonly vocabPath?: string;
  private session?: OnnxInferenceSession;
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
      const encoded = batch.map((t) => this.tokenizer?.encode(t, this.maxSeqLength));
      const maxLen = Math.min(this.maxSeqLength, Math.max(...encoded.map((e) => e.inputIds.length)));
      const padId = this.tokenizer?.getPadTokenId();
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
      const feeds: Record<string, OnnxTensor> = {};
      const inputNames = this.session.inputNames;
      if (!inputNames.includes("input_ids")) {
        throw new Error("ONNX model input does not include input_ids");
      }
      feeds.input_ids = new this.ort.Tensor("int64", inputIds, [batchSize, maxLen]);
      if (inputNames.includes("attention_mask")) {
        feeds.attention_mask = new this.ort.Tensor("int64", attentionMask, [batchSize, maxLen]);
      }
      if (inputNames.includes("token_type_ids")) {
        feeds.token_type_ids = new this.ort.Tensor("int64", tokenTypeIds, [batchSize, maxLen]);
      }

      const output = await this.session.run(feeds);
      const outputTensor = output.sentence_embedding ?? output.pooler_output ?? output.last_hidden_state;
      if (!outputTensor) {
        throw new Error("ONNX output missing sentence_embedding/pooler_output/last_hidden_state");
      }
      const data = outputTensor.data as Float32Array;
      const dims = outputTensor.dims as number[];
      let vectors: Float32Array[] = [];
      if (outputTensor === output.last_hidden_state) {
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
