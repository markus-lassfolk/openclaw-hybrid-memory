/**
 * Zigbee2MQTT Config Converter
 *
 * Converts Zigbee2MQTT configuration.yaml and device database JSON files
 * into structured Markdown.
 * SECURITY: Strips MQTT passwords and network keys.
 */

import { basename, extname } from "node:path";
import type { Converter, ConversionResult } from "./index.js";
import { parse } from "yaml";

type Z2MDoc = Record<string, unknown>;

function getStr(obj: Record<string, unknown>, key: string, fallback = ""): string {
  const v = obj[key];
  if (v === undefined || v === null) return fallback;
  return String(v);
}

function renderMQTT(mqtt: Record<string, unknown>): string {
  const server = getStr(mqtt, "server", "*(not set)*");
  const baseTopic = getStr(mqtt, "base_topic", "zigbee2mqtt");
  // password: always redact
  return `- Server: ${server}\n- Base topic: ${baseTopic}\n- Password: [REDACTED]`;
}

function renderSerial(serial: Record<string, unknown>): string {
  const port = getStr(serial, "port", "*(not set)*");
  const adapter = serial["adapter"] ? getStr(serial, "adapter") : "auto";
  const baudrate = serial["baudrate"] ? String(serial["baudrate"]) : "default";
  return `- Port: ${port}\n- Adapter: ${adapter}\n- Baudrate: ${baudrate}`;
}

interface Z2MDevice {
  friendly_name?: string;
  ieee_address?: string;
  model?: string;
  manufacturer?: string;
  description?: string;
  disabled?: boolean;
}

function renderDevice(ieeeOrKey: string, device: unknown): string {
  if (typeof device !== "object" || device === null) return `- ${ieeeOrKey}: *(invalid)*`;
  const d = device as Z2MDevice;
  const name = d.friendly_name ? `**${d.friendly_name}**` : `*(unnamed)*`;
  const ieee = d.ieee_address ?? ieeeOrKey;
  const model = d.model ? ` model: ${d.model}` : "";
  const mfr = d.manufacturer ? ` (${d.manufacturer})` : "";
  const desc = d.description ? ` — ${d.description}` : "";
  const disabled = d.disabled ? " [DISABLED]" : "";
  return `- ${name} — IEEE: \`${ieee}\`${model}${mfr}${desc}${disabled}`;
}

interface Z2MGroup {
  friendly_name?: string;
  members?: Array<{ ieee_address?: string; endpoint?: number }>;
}

function renderGroup(id: string, group: unknown): string {
  if (typeof group !== "object" || group === null) return `- Group ${id}: *(invalid)*`;
  const g = group as Z2MGroup;
  const name = g.friendly_name ? `**${g.friendly_name}**` : `Group ${id}`;
  const members = Array.isArray(g.members) ? g.members : [];
  const memberStr = members.length
    ? ` (${members.length} member(s): ${members.map((m) => m.ieee_address ?? "?").join(", ")})`
    : "";
  return `- ${name}${memberStr}`;
}

function isDeviceDatabase(obj: unknown): boolean {
  if (typeof obj !== "object" || obj === null) return false;
  // Device DB: object where all keys look like IEEE addresses (0x...) or is empty
  const keys = Object.keys(obj as object);
  if (keys.length === 0) return true; // empty device database
  return keys.some((k) => k.startsWith("0x") || /^[0-9a-f]{16}$/i.test(k));
}

function convertConfigYAML(doc: Z2MDoc, filePath: string): ConversionResult {
  const title = "Zigbee2MQTT Configuration";
  const sections: string[] = [`# ${title}\n`];

  // MQTT
  const mqtt = doc["mqtt"] as Record<string, unknown> | undefined;
  if (mqtt) {
    sections.push(`## MQTT\n\n${renderMQTT(mqtt)}\n`);
  }

  // Serial
  const serial = doc["serial"] as Record<string, unknown> | undefined;
  if (serial) {
    sections.push(`## Serial\n\n${renderSerial(serial)}\n`);
  }

  // Advanced — redact network_key
  const advanced = doc["advanced"] as Record<string, unknown> | undefined;
  if (advanced) {
    const panId = advanced["pan_id"] ? `PAN ID: ${String(advanced["pan_id"])}` : "";
    const channel = advanced["channel"] ? `Channel: ${String(advanced["channel"])}` : "";
    const networkKey = "Network key: [REDACTED]";
    const info = [panId, channel, networkKey].filter(Boolean).join("\n- ");
    sections.push(`## Advanced\n\n- ${info}\n`);
  }

  // Devices
  const devices = doc["devices"] as Record<string, unknown> | undefined;
  if (devices && typeof devices === "object") {
    const entries = Object.entries(devices);
    if (entries.length > 0) {
      const lines = entries.map(([key, device]) => renderDevice(key, device));
      sections.push(`## Devices\n\n${lines.join("\n")}\n`);
    }
  }

  // Groups
  const groups = doc["groups"] as Record<string, unknown> | undefined;
  if (groups && typeof groups === "object") {
    const entries = Object.entries(groups);
    if (entries.length > 0) {
      const lines = entries.map(([id, group]) => renderGroup(id, group));
      sections.push(`## Groups\n\n${lines.join("\n")}\n`);
    }
  }

  // Frontend/homeassistant settings (non-sensitive)
  const ha = doc["homeassistant"];
  if (ha !== undefined) {
    sections.push(`## Home Assistant Integration\n\n- Enabled: ${Boolean(ha)}\n`);
  }

  return {
    markdown: sections.join("\n"),
    title,
    metadata: {
      source: "zigbee2mqtt-converter",
      filePath,
      type: "config",
      deviceCount: devices ? Object.keys(devices).length : 0,
      groupCount: groups ? Object.keys(groups).length : 0,
    },
  };
}

function convertDeviceDatabase(obj: Record<string, unknown>, filePath: string): ConversionResult {
  const fileName = basename(filePath);
  const title = `Zigbee2MQTT Device Database: ${fileName}`;
  const sections: string[] = [`# ${title}\n`];

  const entries = Object.entries(obj);
  if (entries.length === 0) {
    sections.push("*No devices found*\n");
  } else {
    const lines = entries.map(([ieee, device]) => renderDevice(ieee, device));
    sections.push(`## Devices\n\n${lines.join("\n")}\n`);
  }

  return {
    markdown: sections.join("\n"),
    title,
    metadata: {
      source: "zigbee2mqtt-converter",
      filePath,
      type: "device-database",
      deviceCount: entries.length,
    },
  };
}

export const zigbee2mqttConverter: Converter = {
  extensions: [".yaml", ".yml", ".json"],

  convert(content: string, filePath: string): ConversionResult {
    const ext = extname(filePath).toLowerCase();

    if (ext === ".json") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        return {
          markdown: `# Zigbee2MQTT Data: ${basename(filePath)}\n\n*Error: Could not parse JSON*\n`,
          title: `Zigbee2MQTT Data: ${basename(filePath)}`,
          metadata: { source: "zigbee2mqtt-converter", filePath },
        };
      }
      if (isDeviceDatabase(parsed)) {
        return convertDeviceDatabase(parsed as Record<string, unknown>, filePath);
      }
      // Generic JSON fallback
      return {
        markdown: `# Zigbee2MQTT Data: ${basename(filePath)}\n\n\`\`\`json\n${JSON.stringify(parsed, null, 2).slice(0, 2000)}\n\`\`\`\n`,
        title: `Zigbee2MQTT Data: ${basename(filePath)}`,
        metadata: { source: "zigbee2mqtt-converter", filePath },
      };
    }

    // YAML
    let doc: Z2MDoc;
    try {
      const parsed = parse(content);
      doc = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Z2MDoc;
    } catch {
      doc = {};
    }

    return convertConfigYAML(doc, filePath);
  },
};
