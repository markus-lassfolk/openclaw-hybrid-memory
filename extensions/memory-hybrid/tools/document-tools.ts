/**
 * Document Tool Registrations
 *
 * Provides the `memory_ingest_document` tool that converts documents (PDF,
 * DOCX, XLSX, PPTX, HTML, images, etc.) to Markdown via the MarkItDown
 * Python bridge, chunks the result, and stores each chunk as a fact.
 */

import { Type } from "@sinclair/typebox";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";

import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import type { PythonBridge } from "../services/python-bridge.js";
import { chunkMarkdown } from "../services/document-chunker.js";
import { capturePluginError } from "../services/error-reporter.js";
import { getMemoryCategories, type HybridMemoryConfig, type MemoryCategory } from "../config.js";
import { extractTags } from "../utils/tags.js";
import { stringEnum } from "openclaw/plugin-sdk";

export interface DocumentToolsContext {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  cfg: HybridMemoryConfig;
  embeddings: EmbeddingProvider;
  pythonBridge: PythonBridge;
}

/**
 * Register the memory_ingest_document tool.
 * Only called when cfg.documents.enabled is true.
 */
export function registerDocumentTools(ctx: DocumentToolsContext, api: ClawdbotPluginApi): void {
  const { factsDb, vectorDb, cfg, embeddings, pythonBridge } = ctx;
  const docCfg = cfg.documents;

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
        category: Type.Optional(
          stringEnum(getMemoryCategories() as unknown as readonly string[]),
        ),
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

        // --- Path validation: require absolute path; optionally restrict to allowedPaths ---
        if (!isAbsolute(filePath)) {
          return {
            content: [{ type: "text", text: `Error: Path must be absolute. Got: ${filePath}` }],
            details: { error: "path_not_absolute", path: filePath },
          };
        }
        const resolvedPath = resolve(filePath);
        const allowedPaths = docCfg.allowedPaths;
        if (allowedPaths && allowedPaths.length > 0) {
          const underAllowed = allowedPaths.some((root) => {
            const resolvedRoot = resolve(root);
            return resolvedPath === resolvedRoot || resolvedPath.startsWith(resolvedRoot + "/");
          });
          if (!underAllowed) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: Path is not under any allowed directory. Allowed: ${allowedPaths.join(", ")}`,
                },
              ],
              details: { error: "path_not_allowed", path: resolvedPath, allowedPaths },
            };
          }
        }

        // --- Normalize tags: comma-safe, lowercase, dedupe (tags stored comma-separated) ---
        const tagSafe = (s: string): string =>
          s
            .toLowerCase()
            .trim()
            .replace(/\s+/g, "-")
            .replace(/,/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "") || "tag";
        const rawTags = Array.isArray(params.tags)
          ? (params.tags as string[]).filter((t) => typeof t === "string")
          : [];
        const extraTags = [...new Set(rawTags.flatMap((t) => t.split(",").map((p) => tagSafe(p.trim())).filter(Boolean)))];

        // --- Validate file ---
        let stat: ReturnType<typeof statSync>;
        try {
          stat = statSync(resolvedPath);
        } catch {
          return {
            content: [{ type: "text", text: `Error: File not found or inaccessible: ${resolvedPath}` }],
            details: { error: "file_not_found", path: resolvedPath },
          };
        }

        const fileSize = stat.size;
        if (fileSize > docCfg.maxDocumentSize) {
          const maxMB = (docCfg.maxDocumentSize / 1024 / 1024).toFixed(0);
          const fileMB = (fileSize / 1024 / 1024).toFixed(1);
          return {
            content: [
              {
                type: "text",
                text: `Error: File too large (${fileMB} MB). Maximum allowed: ${maxMB} MB.`,
              },
            ],
            details: { error: "file_too_large", fileSize, maxDocumentSize: docCfg.maxDocumentSize },
          };
        }

        // --- Dedup check: hash the resolved path + mtime for a lightweight fingerprint ---
        const mtimeMs = stat.mtimeMs ?? 0;
        const fingerprint = createHash("sha256")
          .update(`${resolvedPath}:${mtimeMs}:${fileSize}`)
          .digest("hex")
          .slice(0, 16);

        const existingCount = factsDb.countBySource(`document:${fingerprint}`);
        if (existingCount > 0 && !isDryRun) {
          return {
            content: [
              {
                type: "text",
                text: `Document already ingested (${existingCount} chunks stored). ` +
                  `Delete existing facts first if you want to re-ingest.`,
              },
            ],
            details: { action: "skipped_duplicate", fingerprint, chunkCount: existingCount },
          };
        }

        // --- Convert via Python bridge ---
        let markdown: string;
        let title: string;
        try {
          const result = await pythonBridge.convert(resolvedPath);
          markdown = result.markdown;
          title = result.title;
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "documents",
            operation: "python-bridge-convert",
            phase: "runtime",
          });
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: `Error converting document: ${msg}` }],
            details: { error: "conversion_failed", path: resolvedPath },
          };
        }

        if (!markdown || !markdown.trim()) {
          return {
            content: [{ type: "text", text: "Document converted but produced no text content." }],
            details: { error: "empty_content", path: resolvedPath },
          };
        }

        // --- Chunk ---
        const chunks = chunkMarkdown(markdown, {
          chunkSize: docCfg.chunkSize,
          chunkOverlap: docCfg.chunkOverlap,
        });

        if (chunks.length === 0) {
          return {
            content: [{ type: "text", text: "Document produced no storable chunks after chunking." }],
            details: { error: "no_chunks", path: resolvedPath },
          };
        }

        if (isDryRun) {
          const preview = chunks
            .slice(0, 3)
            .map((c, i) => `Chunk ${i + 1}/${chunks.length} [${c.sectionHeading ?? "no heading"}]:\n${c.text.slice(0, 200)}...`)
            .join("\n\n");
          return {
            content: [
              {
                type: "text",
                text: `Dry run: ${chunks.length} chunk(s) would be stored.\n\n${preview}`,
              },
            ],
            details: { dryRun: true, chunkCount: chunks.length, title },
          };
        }

        // --- Store each chunk ---
        // Sanitize tag values from headings/filenames: tags are stored comma-separated, so commas would corrupt parseTags.
        const headingTagSafe = (s: string): string => {
          const t = s
            .toLowerCase()
            .replace(/\s+/g, "-")
            .replace(/,/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "");
          return t || s.toLowerCase();
        };
        const fileName = basename(resolvedPath);
        const sourceName = `document:${fingerprint}`;
        const baseTags: string[] = [
          ...(docCfg.autoTag ? [headingTagSafe(fileName)] : []),
          "document",
          ...extraTags,
        ];

        let storedCount = 0;
        let errorCount = 0;

        for (const chunk of chunks) {
          const headingTag = chunk.sectionHeading ? headingTagSafe(chunk.sectionHeading) : null;
          const chunkTags = [
            ...baseTags,
            ...(headingTag ? [headingTag] : []),
            ...extractTags(chunk.text, title),
          ];

          const chunkText = chunk.text;

          // Store in SQLite
          let entry;
          try {
            entry = factsDb.store({
              text: chunkText,
              category: categoryParam as MemoryCategory,
              importance: 0.7,
              entity: title,
              key: chunk.sectionHeading ?? null,
              value: null,
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

          // Store embedding in LanceDB
          try {
            const vector = await embeddings.embed(chunkText);
            factsDb.setEmbeddingModel(entry.id, embeddings.modelName);
            if (!(await vectorDb.hasDuplicate(vector))) {
              await vectorDb.store({
                text: chunkText,
                vector,
                importance: 0.7,
                category: categoryParam,
                id: entry.id,
              });
            }
          } catch (err) {
            // Vector store failure is non-fatal — fact is still in SQLite
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "documents",
              operation: "vector-store",
              phase: "runtime",
              backend: "lancedb",
            });
          }

          storedCount++;
        }

        return {
          content: [
            {
              type: "text",
              text:
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
            chunkCount: chunks.length,
            storedCount,
            errorCount,
          },
        };
      },
    },
    { name: "memory_ingest_document" },
  );
}
