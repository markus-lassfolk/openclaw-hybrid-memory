/**
 * Converter Registry
 *
 * Central registry for domain-specific file format converters.
 * Converters transform configs into structured Markdown for ingestion.
 *
 * Domain converters (Home Assistant, ESPHome, Victron VRM, Zigbee2MQTT) have been
 * removed from the memory plugin; use a separate plugin (e.g. openclaw-ha-converters)
 * and registerConverter() to add them back.
 */

import { extname, basename } from "node:path";

export interface ConversionResult {
  markdown: string;
  title: string;
  metadata: Record<string, unknown>;
}

export interface Converter {
  /** File extensions this converter handles (lowercase, with dot, e.g. ".yaml") */
  extensions: string[];
  mimeTypes?: string[];
  convert(content: string, filePath: string): ConversionResult;
}

/** Built-in converters. Domain converters (HA, ESPHome, Victron, Zigbee2MQTT) removed — register via plugin. */
const builtinConverters: Converter[] = [];

const extraConverters: Converter[] = [];

export function registerConverter(converter: Converter): void {
  extraConverters.push(converter);
}

function allConverters(): Converter[] {
  return [...builtinConverters, ...extraConverters];
}

/**
 * Find a converter for the given file path.
 *
 * Matches by file extension for unambiguous types (.csv).
 * For YAML and JSON files, uses content sniffing to select the right converter
 * since multiple converters share these extensions.
 */
export function getConverter(filePath: string, content?: string): Converter | null {
  const ext = extname(filePath).toLowerCase();
  const fileName = basename(filePath).toLowerCase();

  if (ext === ".yaml" || ext === ".yml") {
    if (content === undefined) return null;
    return sniffYamlConverter(content, fileName);
  }

  if (ext === ".json") {
    if (content === undefined) return null;
    return sniffJsonConverter(content);
  }

  // For non-YAML/JSON extensions, first match wins
  for (const converter of allConverters()) {
    if (converter.extensions.includes(ext)) {
      return converter;
    }
  }

  return null;
}

/** Sniff YAML: only registered (extra) converters; no builtin domain converters. */
function sniffYamlConverter(_content: string, _fileName: string): Converter | null {
  for (const converter of extraConverters) {
    if (converter.extensions.includes(".yaml") || converter.extensions.includes(".yml")) {
      return converter;
    }
  }
  return null;
}

/** Sniff JSON: only registered (extra) converters; no builtin domain converters. */
function sniffJsonConverter(_content: string): Converter | null {
  for (const converter of extraConverters) {
    if (converter.extensions.includes(".json")) {
      return converter;
    }
  }
  return null;
}
