/**
 * ESPHome YAML Converter
 *
 * Converts ESPHome device configuration YAML files into structured Markdown.
 * SECURITY: Strips all passwords, API keys, OTA passwords, WiFi passwords.
 */

import { basename } from "node:path";
import type { Converter, ConversionResult } from "./index.js";
import { parse } from "yaml";
import type { SchemaOptions } from "yaml";

// ESPHome allows !secret directives — redact at parse time
const ESPHOME_CUSTOM_TAGS: NonNullable<SchemaOptions["customTags"]> = [
  { tag: "!secret", resolve: (_value: string) => "[REDACTED]" },
];

type ESPDoc = Record<string, unknown>;

function asArray(val: unknown): unknown[] {
  if (Array.isArray(val)) return val;
  if (val === undefined || val === null) return [];
  return [val];
}

function getStr(obj: Record<string, unknown>, key: string, fallback = ""): string {
  const v = obj[key];
  if (v === undefined || v === null) return fallback;
  return String(v);
}

function renderSensor(sensor: unknown, idx: number): string {
  if (typeof sensor !== "object" || sensor === null) return `- Sensor ${idx + 1}: *(invalid)*`;
  const s = sensor as Record<string, unknown>;
  const name = getStr(s, "name", `sensor_${idx + 1}`);
  const platform = getStr(s, "platform", "unknown");
  const unit = s["unit_of_measurement"] ? ` (${getStr(s, "unit_of_measurement")})` : "";
  const pin = s["pin"] ? ` pin: ${JSON.stringify(s["pin"])}` : "";
  const address = s["address"] ? ` address: ${getStr(s, "address")}` : "";
  const filters = asArray(s["filters"]);
  const filterStr = filters.length ? ` [${filters.length} filter(s)]` : "";
  return `- **${name}** — platform: ${platform}${unit}${pin}${address}${filterStr}`;
}

function renderBinarySensor(sensor: unknown, idx: number): string {
  if (typeof sensor !== "object" || sensor === null) return `- Binary Sensor ${idx + 1}: *(invalid)*`;
  const s = sensor as Record<string, unknown>;
  const name = getStr(s, "name", `binary_sensor_${idx + 1}`);
  const platform = getStr(s, "platform", "unknown");
  const deviceClass = s["device_class"] ? ` (${getStr(s, "device_class")})` : "";
  const pin = s["pin"] ? ` pin: ${JSON.stringify(s["pin"])}` : "";
  return `- **${name}** — platform: ${platform}${deviceClass}${pin}`;
}

function renderSwitch(sw: unknown, idx: number): string {
  if (typeof sw !== "object" || sw === null) return `- Switch ${idx + 1}: *(invalid)*`;
  const s = sw as Record<string, unknown>;
  const name = getStr(s, "name", `switch_${idx + 1}`);
  const platform = getStr(s, "platform", "unknown");
  const pin = s["pin"] ? ` pin: ${JSON.stringify(s["pin"])}` : "";
  return `- **${name}** — platform: ${platform}${pin}`;
}

function renderOutput(output: unknown, idx: number): string {
  if (typeof output !== "object" || output === null) return `- Output ${idx + 1}: *(invalid)*`;
  const o = output as Record<string, unknown>;
  const id = getStr(o, "id", `output_${idx + 1}`);
  const platform = getStr(o, "platform", "unknown");
  const pin = o["pin"] ? ` pin: ${JSON.stringify(o["pin"])}` : "";
  return `- **${id}** — platform: ${platform}${pin}`;
}

export const esphomeYamlConverter: Converter = {
  extensions: [".yaml", ".yml"],

  convert(content: string, filePath: string): ConversionResult {
    const fileName = basename(filePath);
    let doc: ESPDoc;

    try {
      const parsed = parse(content, { customTags: ESPHOME_CUSTOM_TAGS });
      doc = (typeof parsed === "object" && parsed !== null ? parsed : {}) as ESPDoc;
    } catch {
      doc = {};
    }

    // Device name
    const esphomeSection = doc["esphome"] as Record<string, unknown> | undefined;
    const deviceName = esphomeSection ? getStr(esphomeSection, "name", fileName) : fileName;
    const title = `ESPHome Device: ${deviceName}`;
    const sections: string[] = [`# ${title}\n`];

    // Board info
    const boardSection =
      (doc["esp32"] as Record<string, unknown> | undefined) ?? (doc["esp8266"] as Record<string, unknown> | undefined);
    const platform = doc["esp32"] ? "ESP32" : doc["esp8266"] ? "ESP8266" : "Unknown";
    if (boardSection) {
      const board = getStr(boardSection, "board", "unknown");
      const framework = boardSection["framework"]
        ? ` / framework: ${typeof boardSection["framework"] === "object" ? getStr(boardSection["framework"] as Record<string, unknown>, "type", "default") : String(boardSection["framework"])}`
        : "";
      sections.push(`## Board\n\n- Platform: ${platform}\n- Board: ${board}${framework}\n`);
    } else if (platform !== "Unknown") {
      sections.push(`## Board\n\n- Platform: ${platform}\n`);
    }

    // Sensors
    const sensors = asArray(doc["sensor"]);
    if (sensors.length > 0) {
      sections.push(`## Sensors\n\n${sensors.map((s, i) => renderSensor(s, i)).join("\n")}\n`);
    }

    // Binary Sensors
    const binarySensors = asArray(doc["binary_sensor"]);
    if (binarySensors.length > 0) {
      sections.push(`## Binary Sensors\n\n${binarySensors.map((s, i) => renderBinarySensor(s, i)).join("\n")}\n`);
    }

    // Switches & Outputs
    const switches = asArray(doc["switch"]);
    const outputs = asArray(doc["output"]);
    if (switches.length > 0 || outputs.length > 0) {
      const lines = [...switches.map((s, i) => renderSwitch(s, i)), ...outputs.map((o, i) => renderOutput(o, i))];
      sections.push(`## Switches/Outputs\n\n${lines.join("\n")}\n`);
    }

    // WiFi — NEVER include password
    const wifi = doc["wifi"] as Record<string, unknown> | undefined;
    if (wifi) {
      const ssid = wifi["ssid"] ? getStr(wifi, "ssid") : "*(not set)*";
      // password: always redact
      const staticIp = wifi["manual_ip"]
        ? ` / static IP: ${getStr(wifi["manual_ip"] as Record<string, unknown>, "static_ip")}`
        : "";
      const ap = wifi["ap"] ? " / access point: enabled" : "";
      sections.push(`## WiFi\n\n- SSID: ${ssid}\n- Password: [REDACTED]${staticIp}${ap}\n`);
    }

    // API
    const api = doc["api"];
    if (api !== undefined) {
      const apiEnabled = api !== false && api !== null;
      sections.push(`## API\n\n- Enabled: ${apiEnabled}\n- Password: [REDACTED]\n`);
    }

    // OTA
    const ota = doc["ota"];
    if (ota !== undefined) {
      const otaEnabled = ota !== false && ota !== null;
      sections.push(`## OTA\n\n- Enabled: ${otaEnabled}\n- Password: [REDACTED]\n`);
    }

    // Logger
    const logger = doc["logger"] as Record<string, unknown> | undefined;
    if (logger) {
      const level = getStr(logger, "level", "DEBUG");
      sections.push(`## Logger\n\n- Level: ${level}\n`);
    }

    const markdown = sections.join("\n");

    return {
      markdown,
      title,
      metadata: {
        source: "esphome-yaml-converter",
        filePath,
        deviceName,
        platform,
        sensorCount: sensors.length,
        binarySensorCount: binarySensors.length,
        switchCount: switches.length,
      },
    };
  },
};
