/**
 * Converter Registry
 *
 * Central registry for domain-specific file format converters.
 * Converters transform smart home configs into structured Markdown
 * for ingestion by the document ingestion pipeline.
 */

import { extname, basename } from "node:path";
import { haYamlConverter } from "./ha-yaml-converter.js";
import { esphomeYamlConverter } from "./esphome-yaml-converter.js";
import { victronVrmConverter } from "./victron-vrm-converter.js";
import { zigbee2mqttConverter } from "./zigbee2mqtt-converter.js";

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

const builtinConverters: Converter[] = [
  haYamlConverter,
  esphomeYamlConverter,
  victronVrmConverter,
  zigbee2mqttConverter,
];

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

function sniffYamlConverter(content: string, fileName: string): Converter | null {
  // Zigbee2MQTT: must be configuration.yaml or configuration.yml with both mqtt: and serial: at root
  if (
    (fileName === "configuration.yaml" || fileName === "configuration.yml") &&
    /^mqtt:/m.test(content) &&
    /^serial:/m.test(content)
  ) {
    return zigbee2mqttConverter;
  }

  // ESPHome: top-level esphome:, esp32:, or esp8266: key
  if (/^esphome:/m.test(content) || /^esp32:/m.test(content) || /^esp8266:/m.test(content)) {
    return esphomeYamlConverter;
  }

  // Home Assistant: common HA top-level keys
  const haKeys = [
    "automation:",
    "homeassistant:",
    "sensor:",
    "binary_sensor:",
    "switch:",
    "light:",
    "script:",
    "scene:",
  ];
  if (haKeys.some((key) => new RegExp(`^${key}`, "m").test(content))) {
    return haYamlConverter;
  }

  return null;
}

function sniffJsonConverter(content: string): Converter | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  // Zigbee2MQTT device database: object where keys look like IEEE addresses (0x...)
  const keys = Object.keys(obj);
  if (keys.length > 0 && keys.some((k) => k.startsWith("0x") || /^[0-9a-f]{16}$/i.test(k))) {
    return zigbee2mqttConverter;
  }

  // Victron: has records/data arrays, or Victron-style fields
  if (Array.isArray(obj["records"]) || Array.isArray(obj["data"])) {
    return victronVrmConverter;
  }
  const keyStr = keys.join(" ").toLowerCase();
  if (keyStr.includes("soc") || keyStr.includes("pv") || keyStr.includes("battery") || keyStr.includes("victron")) {
    return victronVrmConverter;
  }

  return null;
}
