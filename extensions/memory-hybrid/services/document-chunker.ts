/**
 * Document Chunker Service
 *
 * Splits a Markdown document into semantically meaningful chunks suitable
 * for storage as individual memory facts.
 *
 * Algorithm:
 *   1. Split by ## and ### headings (heading-aware)
 *   2. Each chunk carries the section heading as context
 *   3. Very long sections are further split by paragraphs
 *   4. If no headings exist, fall back to paragraph splitting
 */

interface DocumentChunk {
  text: string;
  sectionHeading: string | null;
  chunkIndex: number;
  totalChunks: number;
}

interface ChunkerOptions {
  /** Max characters per chunk (default: 2000) */
  chunkSize?: number;
  /** Characters of heading context overlap (default: 200) */
  chunkOverlap?: number;
}

const DEFAULT_CHUNK_SIZE = 2000;
const DEFAULT_OVERLAP = 200;

/**
 * Split markdown by top-level section headings (## or ###).
 * Returns pairs of [headingText | null, sectionBody].
 */
function splitByHeadings(markdown: string): Array<{ heading: string | null; body: string }> {
  // Match ## or ### headings (not deeper — # is document title, #### are detail)
  const headingRegex = /^(#{2,3})\s+(.+)$/m;
  const lines = markdown.split("\n");
  const sections: Array<{ heading: string | null; body: string }> = [];
  let currentHeading: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    const match = headingRegex.exec(line);
    if (match) {
      // Save previous section
      const body = currentLines.join("\n").trim();
      if (body.length > 0 || currentHeading !== null) {
        sections.push({ heading: currentHeading, body });
      }
      currentHeading = match[2].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  // Push final section
  const body = currentLines.join("\n").trim();
  if (body.length > 0 || currentHeading !== null) {
    sections.push({ heading: currentHeading, body });
  }

  return sections;
}

/**
 * Split a text block into chunks by paragraph boundaries, respecting maxSize.
 * Each chunk starts with the optional headingPrefix for context.
 */
function splitByParagraphs(text: string, headingPrefix: string, maxSize: number): string[] {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = headingPrefix;

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    const candidate = current.length > 0 ? `${current}\n\n${trimmed}` : trimmed;
    if (candidate.length <= maxSize) {
      current = candidate;
    } else {
      // Save current chunk and start a new one
      if (current.trim().length > 0) {
        chunks.push(current.trim());
      }
      // If the paragraph alone is longer than maxSize, hard-split by characters
      if (`${headingPrefix}\n\n${trimmed}`.length > maxSize) {
        const parts = splitByChars(trimmed, headingPrefix, maxSize);
        // The last part becomes the new "current"
        for (let i = 0; i < parts.length - 1; i++) {
          chunks.push(parts[i]);
        }
        current = parts[parts.length - 1] ?? headingPrefix;
      } else {
        current = headingPrefix.length > 0 ? `${headingPrefix}\n\n${trimmed}` : trimmed;
      }
    }
  }

  if (
    current.trim().length > headingPrefix.trim().length ||
    (current.trim().length > 0 && headingPrefix.trim().length === 0)
  ) {
    chunks.push(current.trim());
  } else if (current.trim().length > 0 && current.trim() !== headingPrefix.trim()) {
    chunks.push(current.trim());
  }

  return chunks.filter((c) => c.trim().length > 0);
}

/** Hard-split text into character-bounded chunks, each prefixed with headingPrefix. */
function splitByChars(text: string, headingPrefix: string, maxSize: number): string[] {
  const overhead = headingPrefix.length > 0 ? headingPrefix.length + 2 : 0;
  const effectiveMax = Math.max(100, maxSize - overhead);
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    const slice = text.slice(offset, offset + effectiveMax);
    const prefix = headingPrefix.length > 0 ? `${headingPrefix}\n\n${slice}` : slice;
    chunks.push(prefix);
    offset += effectiveMax;
  }
  return chunks;
}

/**
 * Chunk a markdown document into DocumentChunk[] records.
 *
 * @param markdown - Full markdown text of the document
 * @param options  - chunkSize and chunkOverlap settings
 */
export function chunkMarkdown(markdown: string, options: ChunkerOptions = {}): DocumentChunk[] {
  const maxSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  // chunkOverlap controls the heading prefix size included in each chunk
  const overlapSize = options.chunkOverlap ?? DEFAULT_OVERLAP;

  const sections = splitByHeadings(markdown);

  const rawChunks: Array<{ text: string; heading: string | null }> = [];

  if (sections.length === 0) {
    // No content at all
    return [];
  }

  // Check if there are any real headings
  const hasHeadings = sections.some((s) => s.heading !== null);

  if (!hasHeadings) {
    // Fall back to pure paragraph splitting
    const parts = splitByParagraphs(markdown.trim(), "", maxSize);
    for (const part of parts) {
      rawChunks.push({ text: part, heading: null });
    }
  } else {
    for (const section of sections) {
      const headingPrefix = section.heading !== null ? `## ${section.heading}`.slice(0, overlapSize) : "";

      if (!section.body.trim() && section.heading) {
        // Heading-only section — include just the heading
        rawChunks.push({ text: `## ${section.heading}`, heading: section.heading });
        continue;
      }

      // Combine heading + body; check if it fits in one chunk
      const full = headingPrefix.length > 0 ? `${headingPrefix}\n\n${section.body}`.trim() : section.body.trim();

      if (full.length <= maxSize) {
        rawChunks.push({ text: full, heading: section.heading });
      } else {
        // Split long section by paragraphs
        const parts = splitByParagraphs(section.body, headingPrefix, maxSize);
        for (const part of parts) {
          rawChunks.push({ text: part, heading: section.heading });
        }
      }
    }
  }

  const total = rawChunks.length;
  return rawChunks.map((c, i) => ({
    text: c.text,
    sectionHeading: c.heading,
    chunkIndex: i,
    totalChunks: total,
  }));
}
