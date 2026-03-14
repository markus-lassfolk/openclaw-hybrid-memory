/**
 * Document Tool Registrations
 *
 * Provides the `memory_ingest_document` tool that converts documents (PDF,
 * DOCX, XLSX, PPTX, HTML, images, etc.) to Markdown via the MarkItDown
 * Python bridge, chunks the result, and stores each chunk as a fact.
 */

import { Type } from "@sinclair/typebox";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import type OpenAI from "openai";

import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import type { PythonBridge } from "../services/python-bridge.js";
import { chunkMarkdown } from "../services/document-chunker.js";
import { capturePluginError } from "../services/error-reporter.js";
import {
  getCronModelConfig,
  getLLMModelPreference,
  getMemoryCategories,
  type HybridMemoryConfig,
  type MemoryCategory,
} from "../config.js";
import { extractTags } from "../utils/tags.js";
import { stringEnum } from "openclaw/plugin-sdk";
import type { ProvenanceService } from "../services/provenance.js";

export interface DocumentToolsContext {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  cfg: HybridMemoryConfig;
  embeddings: EmbeddingProvider;
  openai: OpenAI;
  pythonBridge: PythonBridge;
  provenanceService?: ProvenanceService | null;
  onProgress?: (progress: { stage: string; pct: number; message: string }) => void;
}

type ProgressTracker = {
  steps: string[];
  add: (message: string) => void;
  summary: () => string;
};

type IngestResult = {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
};

type IngestSummary = {
  path: string;
  realPath: string;
  fileName: string;
  title?: string;
  fingerprint?: string;
  status: "ingested" | "skipped_duplicate" | "dry_run" | "error";
  chunkCount?: number;
  storedCount?: number;
  errorCount?: number;
  error?: string;
  progress: string[];
  response: IngestResult;
};

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff"]);

const SUPPORTED_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
  ".xls",
  ".xlsx",
  ".csv",
  ".tsv",
  ".md",
  ".markdown",
  ".txt",
  ".rtf",
  ".html",
  ".htm",
  ".json",
  ".yaml",
  ".yml",
  ".epub",
  ".odt",
  ".ods",
  ".odp",
  ...IMAGE_EXTENSIONS,
]);

function createProgressTracker(logger: { info: (msg: string) => void }, label?: string): ProgressTracker {
  const steps: string[] = [];
  const prefix = label ? `${label}: ` : "";
  return {
    steps,
    add(message: string) {
      steps.push(message);
      logger.info(`memory-hybrid: ${prefix}${message}`);
    },
    summary() {
      return steps.join(" ");
    },
  };
}

function isUnderAllowedPaths(realPath: string, allowedPaths?: string[]): boolean {
  if (!allowedPaths || allowedPaths.length === 0) return true;
  return allowedPaths.some((root) => {
    try {
      const realRoot = realpathSync.native(resolve(root));
      const rel = relative(realRoot, realPath);
      return rel === "" || (!rel.startsWith("..") && !rel.includes(".."));
    } catch {
      return false;
    }
  });
}

function normalizeExtensions(exts: string[]): string[] {
  return [
    ...new Set(
      exts
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean)
        .map((e) => (e.startsWith(".") ? e : `.${e}`)),
    ),
  ];
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§§DOUBLE_STAR§§")
    .replace(/\*/g, "[^/]*")
    .replace(/§§DOUBLE_STAR§§/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesGlob(filePath: string, glob: string): boolean {
  if (!glob.trim()) return true;
  const trimmed = glob.trim();
  const target = trimmed.includes("/") ? filePath.replace(/\\/g, "/") : basename(filePath);
  return globToRegex(trimmed).test(target);
}

function isSupportedExtension(filePath: string, customExts?: string[], glob?: string): boolean {
  const lowerExt = extname(filePath).toLowerCase();
  const custom = customExts && customExts.length > 0 ? new Set(customExts) : null;
  const extOk = custom ? custom.has(lowerExt) : SUPPORTED_EXTENSIONS.has(lowerExt);
  const globOk = glob ? matchesGlob(filePath, glob) : true;
  return extOk && globOk;
}

function collectFilesRecursive(dir: string, predicate: (path: string) => boolean): string[] {
  const out: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        out.push(...collectFilesRecursive(full, predicate));
      } else if (entry.isFile() && predicate(full)) {
        out.push(full);
      }
    }
  } catch (err) {
    // Skip unreadable directories (permission denied, broken mounts, etc.)
  }
  return out;
}

function toMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".tif":
    case ".tiff":
      return "image/tiff";
    default:
      return "application/octet-stream";
  }
}

async function describeImageWithVision(opts: {
  openai: OpenAI;
  cfg: HybridMemoryConfig;
  filePath: string;
}): Promise<{ text: string; model: string }> {
  const { openai, cfg, filePath } = opts;
  const cronCfg = getCronModelConfig(cfg);
  const pref = getLLMModelPreference(cronCfg, "default");
  const configuredModel = cfg.documents.visionModel?.trim();
  const primaryModel = configuredModel || pref[0];
  const fallbackModels = configuredModel ? pref.filter((m) => m !== configuredModel) : pref.slice(1);
  const modelsToTry = [primaryModel, ...fallbackModels].filter(Boolean);

  if (modelsToTry.length === 0) {
    throw new Error("No vision model configured (documents.visionModel or llm.default must be set).");
  }

  const mime = toMimeType(filePath);
  const imageData = readFileSync(filePath).toString("base64");
  const imageUrl = `data:${mime};base64,${imageData}`;

  const prompt =
    "Describe this image for memory storage. Focus on concrete, factual details: " +
    "objects, people, text, labels, charts, and context. Keep it concise but complete.";

  let lastError: Error | undefined;
  for (const model of modelsToTry) {
    try {
      const resp = await openai.chat.completions.create({
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: imageUrl } },
            ],
          },
        ],
        temperature: 0.2,
        max_tokens: 800,
      });
      const text = resp.choices[0]?.message?.content?.trim() ?? "";
      if (!text) {
        throw new Error(`Vision model ${model} returned empty response.`);
      }
      return { text, model };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      continue;
    }
  }

  const finalError = lastError ?? new Error("Vision model failed");
  capturePluginError(finalError, {
    subsystem: "documents",
    operation: "vision-describe",
    phase: "runtime",
  });
  throw finalError;
}

/**
 * Register the memory_ingest_document tool.
 * Only called when cfg.documents.enabled is true.
 */
export function registerDocumentTools(ctx: DocumentToolsContext, api: ClawdbotPluginApi): void {
  const { factsDb, vectorDb, cfg, embeddings, pythonBridge, openai, provenanceService, onProgress } = ctx;
  const docCfg = cfg.documents;

  const tagSafe = (s: string): string =>
    s.toLowerCase().trim().replace(/\s+/g, "-").replace(/,/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "tag";

  const headingTagSafe = (s: string): string => {
    const t = s.toLowerCase().replace(/\s+/g, "-").replace(/,/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    return t || s.toLowerCase();
  };

  function normalizeExtraTags(tags: unknown): string[] {
    const rawTags = Array.isArray(tags) ? (tags as string[]).filter((t) => typeof t === "string") : [];
    return [
      ...new Set(
        rawTags.flatMap((t) =>
          t
            .split(",")
            .map((p) => tagSafe(p.trim()))
            .filter(Boolean),
        ),
      ),
    ];
  }

  function makeErrorResponse(message: string, details: Record<string, unknown>): IngestResult {
    return { content: [{ type: "text", text: message }], details };
  }

  async function ingestSingleDocument(opts: {
    path: string;
    tags: unknown;
    category: string;
    dryRun: boolean;
    progressLabel?: string;
    onProgress?: (progress: { stage: string; pct: number; message: string }) => void;
  }): Promise<IngestSummary> {
    const filePath = opts.path;
    const progress = createProgressTracker(api.logger, opts.progressLabel);
    opts.onProgress?.({ stage: "start", pct: 0, message: `Starting ingestion of ${basename(filePath)}` });

    if (!isAbsolute(filePath)) {
      return {
        path: filePath,
        realPath: filePath,
        fileName: basename(filePath),
        status: "error",
        error: "path_not_absolute",
        progress: progress.steps,
        response: makeErrorResponse(`Error: Path must be absolute. Got: ${filePath}`, {
          error: "path_not_absolute",
          path: filePath,
        }),
      };
    }

    let realPath: string;
    try {
      realPath = realpathSync.native(filePath);
    } catch (err: unknown) {
      const code = err && typeof err === "object" && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
      const isNotFound = code === "ENOENT";
      return {
        path: filePath,
        realPath: filePath,
        fileName: basename(filePath),
        status: "error",
        error: isNotFound ? "file_not_found" : "path_inaccessible",
        progress: progress.steps,
        response: makeErrorResponse(
          `Error: ${isNotFound ? "File not found" : "Path does not exist or is not accessible"}. Got: ${filePath}`,
          { error: isNotFound ? "file_not_found" : "path_inaccessible", path: filePath },
        ),
      };
    }

    if (!isUnderAllowedPaths(realPath, docCfg.allowedPaths)) {
      return {
        path: filePath,
        realPath,
        fileName: basename(realPath),
        status: "error",
        error: "path_not_allowed",
        progress: progress.steps,
        response: makeErrorResponse(
          `Error: Path is not under any allowed directory. Allowed: ${docCfg.allowedPaths?.join(", ") ?? ""}`,
          { error: "path_not_allowed", path: realPath, allowedPaths: docCfg.allowedPaths },
        ),
      };
    }

    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(realPath);
    } catch {
      return {
        path: filePath,
        realPath,
        fileName: basename(realPath),
        status: "error",
        error: "file_not_found",
        progress: progress.steps,
        response: makeErrorResponse(`Error: File not found or inaccessible: ${realPath}`, {
          error: "file_not_found",
          path: realPath,
        }),
      };
    }

    if (!stat.isFile()) {
      return {
        path: filePath,
        realPath,
        fileName: basename(realPath),
        status: "error",
        error: "not_a_file",
        progress: progress.steps,
        response: makeErrorResponse(`Error: Path is not a file: ${realPath}`, {
          error: "not_a_file",
          path: realPath,
        }),
      };
    }

    const fileSize = stat.size;
    if (fileSize > docCfg.maxDocumentSize) {
      const maxMB = (docCfg.maxDocumentSize / 1024 / 1024).toFixed(0);
      const fileMB = (fileSize / 1024 / 1024).toFixed(1);
      return {
        path: filePath,
        realPath,
        fileName: basename(realPath),
        status: "error",
        error: "file_too_large",
        progress: progress.steps,
        response: makeErrorResponse(`Error: File too large (${fileMB} MB). Maximum allowed: ${maxMB} MB.`, {
          error: "file_too_large",
          fileSize,
          maxDocumentSize: docCfg.maxDocumentSize,
        }),
      };
    }

    // Compute SHA-256 hash of file content for stable, content-based deduplication.
    // This ensures re-ingesting an unchanged file is always skipped, regardless of
    // mtime/path changes (e.g. file moved or touched without modification).
    const fileContent = readFileSync(realPath);
    const fingerprint = createHash("sha256").update(fileContent).digest("hex");

    const existingCount = factsDb.countBySource(`document:${fingerprint}`);
    if (existingCount > 0 && !opts.dryRun) {
      const response = makeErrorResponse(
        `Document already ingested (${existingCount} chunks stored). Delete existing facts first if you want to re-ingest.`,
        { action: "skipped_duplicate", fingerprint, chunkCount: existingCount },
      );
      return {
        path: filePath,
        realPath,
        fileName: basename(realPath),
        fingerprint,
        status: "skipped_duplicate",
        chunkCount: existingCount,
        progress: progress.steps,
        response,
      };
    }

    progress.add("Converting...");
    opts.onProgress?.({ stage: "converting", pct: 10, message: "Converting..." });
    let markdown: string;
    let title: string;

    try {
      const isImage = IMAGE_EXTENSIONS.has(extname(realPath).toLowerCase());
      if (isImage && docCfg.visionEnabled) {
        try {
          const vision = await describeImageWithVision({ openai, cfg, filePath: realPath });
          markdown = vision.text;
          title = basename(realPath);
        } catch (visionErr) {
          const result = await pythonBridge.convert(realPath);
          markdown = result.markdown;
          title = result.title;
        }
      } else {
        const result = await pythonBridge.convert(realPath);
        markdown = result.markdown;
        title = result.title;
      }
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "documents",
        operation: "convert",
        phase: "runtime",
      });
      const msg = err instanceof Error ? err.message : String(err);
      const response = makeErrorResponse(`Error converting document: ${msg}`, {
        error: "conversion_failed",
        path: realPath,
      });
      return {
        path: filePath,
        realPath,
        fileName: basename(realPath),
        fingerprint,
        status: "error",
        error: "conversion_failed",
        progress: progress.steps,
        response,
      };
    }

    if (!markdown || !markdown.trim()) {
      const response = makeErrorResponse("Document converted but produced no text content.", {
        error: "empty_content",
        path: realPath,
      });
      return {
        path: filePath,
        realPath,
        fileName: basename(realPath),
        fingerprint,
        status: "error",
        error: "empty_content",
        progress: progress.steps,
        response,
      };
    }

    const chunks = chunkMarkdown(markdown, {
      chunkSize: docCfg.chunkSize,
      chunkOverlap: docCfg.chunkOverlap,
    });

    if (chunks.length === 0) {
      const response = makeErrorResponse("Document produced no storable chunks after chunking.", {
        error: "no_chunks",
        path: realPath,
      });
      return {
        path: filePath,
        realPath,
        fileName: basename(realPath),
        fingerprint,
        status: "error",
        error: "no_chunks",
        progress: progress.steps,
        response,
      };
    }

    progress.add(`Chunking (${chunks.length} chunks)...`);
    opts.onProgress?.({ stage: "chunking", pct: 40, message: `Chunking (${chunks.length} chunks)...` });

    if (opts.dryRun) {
      const preview = chunks
        .slice(0, 3)
        .map(
          (c, i) =>
            `Chunk ${i + 1}/${chunks.length} [${c.sectionHeading ?? "no heading"}]:\n${c.text.slice(0, 200)}...`,
        )
        .join("\n\n");
      progress.add("Done (dry run)");
      opts.onProgress?.({ stage: "complete", pct: 100, message: "Done (dry run)" });
      const response: IngestResult = {
        content: [
          {
            type: "text",
            text: `${progress.summary()}\n\nDry run: ${chunks.length} chunk(s) would be stored.\n\n${preview}`,
          },
        ],
        details: { dryRun: true, chunkCount: chunks.length, title },
      };
      return {
        path: filePath,
        realPath,
        fileName: basename(realPath),
        title,
        fingerprint,
        status: "dry_run",
        chunkCount: chunks.length,
        progress: progress.steps,
        response,
      };
    }

    progress.add("Storing...");
    opts.onProgress?.({ stage: "store", pct: 50, message: "Storing..." });

    const fileName = basename(realPath);
    const sourceName = `document:${fingerprint}`;
    const extraTags = normalizeExtraTags(opts.tags);
    const baseTags: string[] = [...(docCfg.autoTag ? [headingTagSafe(fileName)] : []), "document", ...extraTags];

    let storedCount = 0;
    let errorCount = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const headingTag = chunk.sectionHeading ? headingTagSafe(chunk.sectionHeading) : null;
      const chunkTags = [...baseTags, ...(headingTag ? [headingTag] : []), ...extractTags(chunk.text, title)];

      const chunkText = chunk.text;
      let entry;
      try {
        entry = factsDb.store({
          text: chunkText,
          category: opts.category as MemoryCategory,
          importance: 0.7,
          entity: title,
          key: chunk.sectionHeading ?? null,
          // Store content hash as source_document_hash metadata so callers can
          // trace a fact back to the exact file version that produced it.
          value: fingerprint,
          source: sourceName,
          tags: chunkTags,
          decayClass: "stable",
        });
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "documents",
          operation: "facts-store",
          phase: "runtime",
          backend: "sqlite",
        });
        errorCount++;
        continue;
      }

      if (provenanceService) {
        try {
          provenanceService.addEdge(entry.id, {
            edgeType: "DERIVED_FROM",
            sourceType: "document",
            sourceId: fingerprint,
            sourceText: chunkText.slice(0, 500),
          });
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "documents",
            operation: "provenance",
          });
        }
      }

      try {
        const vector = await embeddings.embed(chunkText);
        factsDb.setEmbeddingModel(entry.id, embeddings.modelName);
        if (!(await vectorDb.hasDuplicate(vector))) {
          await vectorDb.store({
            text: chunkText,
            vector,
            importance: 0.7,
            category: opts.category,
            id: entry.id,
          });
        }
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "documents",
          operation: "vector-store",
          phase: "runtime",
          backend: "lancedb",
        });
      }

      storedCount++;
      const pct = 50 + Math.round(((i + 1) / chunks.length) * 50);
      opts.onProgress?.({ stage: "store", pct, message: `Stored chunk ${i + 1}/${chunks.length}` });
      if ((i + 1) % 25 === 0 || i === chunks.length - 1) {
        api.logger.info(`memory-hybrid: ${fileName} storing chunk ${i + 1}/${chunks.length}`);
      }
    }

    progress.add("Done");
    opts.onProgress?.({ stage: "complete", pct: 100, message: "Done" });

    const response: IngestResult = {
      content: [
        {
          type: "text",
          text:
            `${progress.summary()}\n\n` +
            `Ingested "${title}" (${fileName}): ` +
            `${storedCount} chunk(s) stored` +
            (errorCount > 0 ? `, ${errorCount} error(s)` : "") +
            `.`,
        },
      ],
      details: {
        action: "ingested",
        title,
        path: filePath,
        fingerprint,
        source_document_hash: fingerprint,
        chunkCount: chunks.length,
        storedCount,
        errorCount,
      },
    };

    return {
      path: filePath,
      realPath,
      fileName,
      title,
      fingerprint,
      status: "ingested",
      chunkCount: chunks.length,
      storedCount,
      errorCount,
      progress: progress.steps,
      response,
    };
  }

  api.registerTool(
    {
      name: "memory_ingest_document",
      label: "Ingest Document",
      description:
        "Convert a document (PDF, DOCX, XLSX, PPTX, HTML, image, audio, etc.) to Markdown " +
        "using MarkItDown, then chunk and store each section as a memory fact with source attribution. " +
        "Requires Python 3 with markitdown installed (`pip install markitdown`).",
      parameters: Type.Object({
        path: Type.String({
          description: "Absolute path to the document file to ingest",
        }),
        tags: Type.Optional(
          Type.Array(Type.String(), {
            description: "Additional tags to attach to each stored fact",
          }),
        ),
        category: Type.Optional(stringEnum(getMemoryCategories() as unknown as readonly string[])),
        dryRun: Type.Optional(
          Type.Boolean({
            description: "When true, convert and chunk but do NOT store — returns preview only",
          }),
        ),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const filePath = params.path as string;
        const categoryParam = typeof params.category === "string" ? params.category : "fact";
        const isDryRun = params.dryRun === true;

        const summary = await ingestSingleDocument({
          path: filePath,
          tags: params.tags,
          category: categoryParam,
          dryRun: isDryRun,
          onProgress,
        });
        return summary.response;
      },
    },
    { name: "memory_ingest_document" },
  );

  api.registerTool(
    {
      name: "memory_ingest_folder",
      label: "Ingest Document Folder",
      description:
        "Recursively ingest all supported documents in a folder using memory_ingest_document. " +
        "Supports optional file filters and dry-run listing.",
      parameters: Type.Object({
        path: Type.String({
          description: "Absolute path to the folder containing documents to ingest",
        }),
        filter: Type.Optional(
          Type.Object({
            glob: Type.Optional(
              Type.String({
                description: "Glob pattern to match file paths (e.g. **/*.pdf)",
              }),
            ),
            extensions: Type.Optional(
              Type.Array(Type.String(), {
                description: "File extensions to include (e.g. ['.pdf', '.docx'])",
              }),
            ),
          }),
        ),
        tags: Type.Optional(
          Type.Array(Type.String(), {
            description: "Additional tags to attach to each stored fact",
          }),
        ),
        category: Type.Optional(stringEnum(getMemoryCategories() as unknown as readonly string[])),
        dryRun: Type.Optional(
          Type.Boolean({
            description: "When true, only list matching files without ingesting",
          }),
        ),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const folderPath = params.path as string;
        const isDryRun = params.dryRun === true;
        const categoryParam = typeof params.category === "string" ? params.category : "fact";

        if (!isAbsolute(folderPath)) {
          return makeErrorResponse(`Error: Path must be absolute. Got: ${folderPath}`, {
            error: "path_not_absolute",
            path: folderPath,
          });
        }

        let realFolder: string;
        try {
          realFolder = realpathSync.native(folderPath);
        } catch (err: unknown) {
          const code =
            err && typeof err === "object" && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
          const isNotFound = code === "ENOENT";
          return makeErrorResponse(
            `Error: ${isNotFound ? "Folder not found" : "Path does not exist or is not accessible"}. Got: ${folderPath}`,
            { error: isNotFound ? "folder_not_found" : "path_inaccessible", path: folderPath },
          );
        }

        if (!isUnderAllowedPaths(realFolder, docCfg.allowedPaths)) {
          return makeErrorResponse(
            `Error: Path is not under any allowed directory. Allowed: ${docCfg.allowedPaths?.join(", ") ?? ""}`,
            { error: "path_not_allowed", path: realFolder, allowedPaths: docCfg.allowedPaths },
          );
        }

        let folderStat: ReturnType<typeof statSync>;
        try {
          folderStat = statSync(realFolder);
        } catch {
          return makeErrorResponse(`Error: Folder not found or inaccessible: ${realFolder}`, {
            error: "folder_not_found",
            path: realFolder,
          });
        }

        if (!folderStat.isDirectory()) {
          return makeErrorResponse(`Error: Path is not a directory: ${realFolder}`, {
            error: "not_a_directory",
            path: realFolder,
          });
        }

        const filter = (params.filter ?? {}) as { glob?: string; extensions?: string[] };
        const customExts = Array.isArray(filter.extensions) ? normalizeExtensions(filter.extensions) : undefined;
        const glob = typeof filter.glob === "string" ? filter.glob.trim() : undefined;
        const files = collectFilesRecursive(realFolder, (fp) => isSupportedExtension(fp, customExts, glob));

        if (isDryRun) {
          return {
            content: [
              {
                type: "text",
                text: `Dry run: ${files.length} file(s) would be ingested.\n\n${files.join("\n")}`,
              },
            ],
            details: { dryRun: true, fileCount: files.length, files },
          };
        }

        const summaries: IngestSummary[] = [];
        let totalChunks = 0;
        let totalStored = 0;
        let totalErrors = 0;

        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const label = `[${i + 1}/${files.length}] ${basename(file)}`;
          const summary = await ingestSingleDocument({
            path: file,
            tags: params.tags,
            category: categoryParam,
            dryRun: false,
            progressLabel: label,
            onProgress,
          });
          summaries.push(summary);
          totalChunks += summary.chunkCount ?? 0;
          totalStored += summary.storedCount ?? 0;
          totalErrors += summary.errorCount ?? (summary.status === "error" ? 1 : 0);
        }

        const progressLines = summaries.map((s) => `${s.fileName}: ${s.progress.join(" ")}`);
        const errorLines = summaries
          .filter((s) => s.status === "error")
          .map((s) => `${s.fileName}: ${s.error ?? "error"}`);

        return {
          content: [
            {
              type: "text",
              text:
                `Folder ingest complete: ${summaries.length} file(s), ${totalStored} chunk(s) stored` +
                (totalErrors > 0 ? `, ${totalErrors} error(s)` : "") +
                `.\n\n` +
                `Progress:\n${progressLines.join("\n")}` +
                (errorLines.length > 0 ? `\n\nErrors:\n${errorLines.join("\n")}` : ""),
            },
          ],
          details: {
            action: "folder_ingest",
            path: folderPath,
            fileCount: summaries.length,
            totalChunks,
            totalStored,
            totalErrors,
            files: summaries.map((s) => ({
              path: s.path,
              realPath: s.realPath,
              status: s.status,
              chunkCount: s.chunkCount ?? 0,
              storedCount: s.storedCount ?? 0,
              errorCount: s.errorCount ?? 0,
              error: s.error,
              progress: s.progress,
            })),
          },
        };
      },
    },
    { name: "memory_ingest_folder" },
  );
}
