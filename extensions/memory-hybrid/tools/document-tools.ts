/**
 * Document Tools
 *
 * Provides document ingestion utilities for the memory pipeline.
 * Uses native TypeScript converters for domain-specific file formats
 * (smart home configs, energy data) and falls back to the Python
 * MarkItDown bridge for general documents.
 */

import { readFileSync } from "node:fs";
import { getConverter, type ConversionResult } from "./converters/index.js";

export type { ConversionResult };

export interface IngestOptions {
  /** Absolute path to the file to ingest */
  filePath: string;
  /** File content — if omitted, the file is read from disk */
  content?: string;
}

export interface IngestResult {
  markdown: string;
  title: string;
  metadata: Record<string, unknown>;
  /** Which converter was used */
  converterSource: "native" | "python-bridge" | "passthrough";
}

/**
 * Convert a file to Markdown for ingestion.
 *
 * Priority:
 * 1. Native converter (smart home formats)
 * 2. Python MarkItDown bridge (general docs — not implemented here)
 * 3. Passthrough (plain text)
 */
export function ingestDocument(opts: IngestOptions): IngestResult {
  const { filePath } = opts;
  const content = opts.content ?? readFileSync(filePath, "utf-8");

  // 1. Try native converter
  const converter = getConverter(filePath, content);
  if (converter) {
    const result: ConversionResult = converter.convert(content, filePath);
    return {
      markdown: result.markdown,
      title: result.title,
      metadata: result.metadata,
      converterSource: "native",
    };
  }

  // 2. Python bridge would go here (future integration point)
  //    For now we fall through to passthrough.

  // 3. Passthrough — return content as-is wrapped in markdown
  const fileName = filePath.split("/").pop() ?? filePath;
  return {
    markdown: content,
    title: fileName,
    metadata: { source: "passthrough", filePath },
    converterSource: "passthrough",
  };
}
