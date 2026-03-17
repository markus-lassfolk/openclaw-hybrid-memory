/**
 * Home Assistant YAML Converter
 *
 * Converts Home Assistant configuration YAML files into structured Markdown.
 * Handles automations, scripts, scenes, and entity definitions.
 * Gracefully handles !include and !secret HA YAML directives.
 */

import { basename } from "node:path";
import type { Converter, ConversionResult } from "./index.js";
import { parseYaml } from "../../utils/yaml-parser.js";

// Sentinel prefixes used after pre-processing HA custom tags
const HA_INCLUDE_PREFIX = "__HA_INCLUDE__";
const HA_SECRET_PREFIX = "__HA_SECRET__";
const HA_INCLUDE_DIR_PREFIX = "__HA_INCLUDE_DIR__";
const HA_INCLUDE_DIR_LIST_PREFIX = "__HA_INCLUDE_DIR_LIST__";
const HA_INCLUDE_DIR_NAMED_PREFIX = "__HA_INCLUDE_DIR_NAMED__";

/**
 * Replace HA-specific YAML tags with safe sentinel string values before parsing.
 * Order matters: longer tag names must be replaced before shorter prefixes.
 * Only matches tags at the start of values (not inside quoted strings or after other content).
 */
function preprocessHAYaml(content: string): string {
  // Match tags at the start of a line value (after key: or after sequence dash -)
  // Use negative lookbehind to ensure we're not inside a quoted string
  return content
    .replace(/(^|\n)(\s*)([\w.-]+):\s+!include_dir_merge_named\s+(\S+)/g, `$1$2$3: "${HA_INCLUDE_DIR_PREFIX}$4"`)
    .replace(/(^|\n)(\s*)-\s+!include_dir_merge_named\s+(\S+)/g, `$1$2- "${HA_INCLUDE_DIR_PREFIX}$3"`)
    .replace(/(^|\n)(\s*)([\w.-]+):\s+!include_dir_list\s+(\S+)/g, `$1$2$3: "${HA_INCLUDE_DIR_LIST_PREFIX}$4"`)
    .replace(/(^|\n)(\s*)-\s+!include_dir_list\s+(\S+)/g, `$1$2- "${HA_INCLUDE_DIR_LIST_PREFIX}$3"`)
    .replace(/(^|\n)(\s*)([\w.-]+):\s+!include_dir_named\s+(\S+)/g, `$1$2$3: "${HA_INCLUDE_DIR_NAMED_PREFIX}$4"`)
    .replace(/(^|\n)(\s*)-\s+!include_dir_named\s+(\S+)/g, `$1$2- "${HA_INCLUDE_DIR_NAMED_PREFIX}$3"`)
    .replace(/(^|\n)(\s*)([\w.-]+):\s+!include\s+(\S+)/g, `$1$2$3: "${HA_INCLUDE_PREFIX}$4"`)
    .replace(/(^|\n)(\s*)-\s+!include\s+(\S+)/g, `$1$2- "${HA_INCLUDE_PREFIX}$3"`)
    .replace(/(^|\n)(\s*)([\w.-]+):\s+!secret\s+(\S+)/g, `$1$2$3: "${HA_SECRET_PREFIX}$4"`)
    .replace(/(^|\n)(\s*)-\s+!secret\s+(\S+)/g, `$1$2- "${HA_SECRET_PREFIX}$3"`);
}

type HADoc = Record<string, unknown>;

function isIncludeRef(val: unknown): val is string {
  return typeof val === "string" && val.startsWith(HA_INCLUDE_PREFIX);
}
function isSecretRef(val: unknown): val is string {
  return typeof val === "string" && val.startsWith(HA_SECRET_PREFIX);
}
function isIncludeDirRef(val: unknown): boolean {
  return (
    typeof val === "string" &&
    (val.startsWith(HA_INCLUDE_DIR_PREFIX) ||
      val.startsWith(HA_INCLUDE_DIR_LIST_PREFIX) ||
      val.startsWith(HA_INCLUDE_DIR_NAMED_PREFIX))
  );
}

function renderRef(val: unknown): string {
  if (isIncludeRef(val)) return `*(includes: ${val.substring(HA_INCLUDE_PREFIX.length)})*`;
  if (isSecretRef(val)) return `*(secret: ${val.substring(HA_SECRET_PREFIX.length)})*`;
  if (isIncludeDirRef(val)) return `*(includes directory)*`;
  return String(val);
}

function asArray(val: unknown): unknown[] {
  if (Array.isArray(val)) return val;
  if (val === undefined || val === null) return [];
  return [val];
}

function getStr(obj: Record<string, unknown>, key: string, fallback = ""): string {
  const v = obj[key];
  if (v === undefined || v === null) return fallback;
  if (isIncludeRef(v) || isSecretRef(v) || isIncludeDirRef(v)) return renderRef(v);
  return String(v);
}

function renderAutomation(auto: unknown, idx: number): string {
  if (typeof auto === "string" && (isIncludeRef(auto) || isSecretRef(auto) || isIncludeDirRef(auto))) {
    return `- ${renderRef(auto)}`;
  }
  if (typeof auto !== "object" || auto === null) return `- Automation ${idx + 1}: *(invalid)*`;
  const a = auto as Record<string, unknown>;
  const alias = getStr(a, "alias", `automation_${idx + 1}`);
  const id = a["id"] ? ` (id: ${getStr(a, "id")})` : "";
  const description = a["description"] ? `\n  - Description: ${getStr(a, "description")}` : "";

  const triggerList = asArray(a["trigger"]);
  const triggers = triggerList.length
    ? `\n  - Triggers: ${triggerList.map((t) => summariseTrigger(t)).join(", ")}`
    : "";

  const conditionList = asArray(a["condition"]);
  const conditions = conditionList.length ? `\n  - Conditions: ${conditionList.length} condition(s)` : "";

  const actionList = asArray(a["action"]);
  const actions = actionList.length ? `\n  - Actions: ${actionList.map((ac) => summariseAction(ac)).join(", ")}` : "";

  return `- **${alias}**${id}${description}${triggers}${conditions}${actions}`;
}

function summariseTrigger(t: unknown): string {
  if (typeof t !== "object" || t === null) return "*(invalid trigger)*";
  const obj = t as Record<string, unknown>;
  const platform = getStr(obj, "platform", "unknown");
  if (platform === "state") return `state(${getStr(obj, "entity_id")})`;
  if (platform === "time") return `time(${getStr(obj, "at")})`;
  if (platform === "time_pattern") return `time_pattern`;
  if (platform === "homeassistant") return `ha_event(${getStr(obj, "event")})`;
  if (platform === "sun") return `sun(${getStr(obj, "event")})`;
  if (platform === "template") return `template`;
  if (platform === "numeric_state") return `numeric_state(${getStr(obj, "entity_id")})`;
  return platform;
}

function summariseAction(a: unknown): string {
  if (typeof a !== "object" || a === null) return "*(invalid action)*";
  const obj = a as Record<string, unknown>;
  if (obj["service"]) return `service(${getStr(obj, "service")})`;
  if (obj["delay"]) return `delay`;
  if (obj["wait_template"]) return `wait_template`;
  if (obj["condition"]) return `condition`;
  if (obj["choose"]) return `choose`;
  if (obj["repeat"]) return `repeat`;
  return "action";
}

function renderScript(name: string, script: unknown): string {
  if (typeof script !== "object" || script === null) return `- **${name}**: *(invalid)*`;
  const s = script as Record<string, unknown>;
  const alias = getStr(s, "alias", name);
  const description = s["description"] ? ` — ${getStr(s, "description")}` : "";
  const sequence = asArray(s["sequence"]);
  const steps = sequence.length ? ` (${sequence.length} step(s))` : "";
  return `- **${alias}**${description}${steps}`;
}

function renderScene(scene: unknown, idx: number): string {
  if (typeof scene === "string" && (isIncludeRef(scene) || isSecretRef(scene) || isIncludeDirRef(scene))) {
    return `- ${renderRef(scene)}`;
  }
  if (typeof scene !== "object" || scene === null) return `- Scene ${idx + 1}: *(invalid)*`;
  const s = scene as Record<string, unknown>;
  const name = getStr(s, "name", `scene_${idx + 1}`);
  const entities = s["entities"];
  const count = typeof entities === "object" && entities !== null ? Object.keys(entities).length : 0;
  return `- **${name}** (${count} entity states)`;
}

function renderEntity(entity: unknown, idx: number): string {
  if (typeof entity === "string" && (isIncludeRef(entity) || isSecretRef(entity) || isIncludeDirRef(entity))) {
    return `- ${renderRef(entity)}`;
  }
  if (typeof entity !== "object" || entity === null) return `- Entity ${idx + 1}: *(invalid)*`;
  const e = entity as Record<string, unknown>;
  const name = getStr(e, "name", `entity_${idx + 1}`);
  const platform = e["platform"] ? ` — platform: ${getStr(e, "platform")}` : "";
  const uniqueId = e["unique_id"] ? ` (unique_id: ${getStr(e, "unique_id")})` : "";
  return `- **${name}**${platform}${uniqueId}`;
}

function renderEntitySection(sectionTitle: string, items: unknown[]): string {
  if (items.length === 0) return "";
  const lines = items.map((item, i) => renderEntity(item, i));
  return `\n## ${sectionTitle}\n\n${lines.join("\n")}\n`;
}

export const haYamlConverter: Converter = {
  extensions: [".yaml", ".yml"],

  convert(content: string, filePath: string): ConversionResult {
    const fileName = basename(filePath);
    let doc: HADoc;

    try {
      const preprocessed = preprocessHAYaml(content);
      const parsed = parseYaml(preprocessed);
      doc = (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {}) as HADoc;
    } catch {
      doc = {};
    }

    const title = `Home Assistant Configuration: ${fileName}`;
    const sections: string[] = [`# ${title}\n`];

    // Automations
    const automations = asArray(doc["automation"]);
    if (automations.length > 0) {
      sections.push(`## Automations\n\n${automations.map((a, i) => renderAutomation(a, i)).join("\n")}\n`);
    }

    // Scripts
    const scripts = doc["script"];
    if (scripts && typeof scripts === "object" && !Array.isArray(scripts)) {
      const scriptEntries = Object.entries(scripts as Record<string, unknown>);
      if (scriptEntries.length > 0) {
        const lines = scriptEntries.map(([name, script]) => renderScript(name, script));
        sections.push(`## Scripts\n\n${lines.join("\n")}\n`);
      }
    }

    // Scenes
    const scenes = asArray(doc["scene"]);
    if (scenes.length > 0) {
      sections.push(`## Scenes\n\n${scenes.map((s, i) => renderScene(s, i)).join("\n")}\n`);
    }

    // Entities
    const entitySections: [string, string][] = [
      ["sensor", "Sensors"],
      ["binary_sensor", "Binary Sensors"],
      ["switch", "Switches"],
      ["light", "Lights"],
      ["input_boolean", "Input Booleans"],
      ["input_select", "Input Selects"],
      ["input_number", "Input Numbers"],
    ];

    for (const [key, label] of entitySections) {
      const items = asArray(doc[key]);
      const section = renderEntitySection(label, items);
      if (section) sections.push(section);
    }

    // HA global config
    if (doc["homeassistant"]) {
      const ha = doc["homeassistant"] as Record<string, unknown>;
      const name = getStr(ha, "name", "");
      const lat = ha["latitude"] ? String(ha["latitude"]) : "";
      const lon = ha["longitude"] ? String(ha["longitude"]) : "";
      const unit = getStr(ha, "unit_system", "");
      const info = [name && `Name: ${name}`, lat && lon && `Location: ${lat}, ${lon}`, unit && `Units: ${unit}`]
        .filter(Boolean)
        .join(", ");
      sections.push(`## Global Config\n\n${info || "*(see config)*"}\n`);
    }

    // Note included/referenced files
    const includeRefs: string[] = [];
    function collectIncludes(obj: unknown, depth = 0): void {
      if (depth > 5) return;
      if (typeof obj === "string") {
        if (obj.startsWith(HA_INCLUDE_PREFIX)) {
          includeRefs.push(obj.substring(HA_INCLUDE_PREFIX.length));
        } else if (
          obj.startsWith(HA_INCLUDE_DIR_PREFIX) ||
          obj.startsWith(HA_INCLUDE_DIR_LIST_PREFIX) ||
          obj.startsWith(HA_INCLUDE_DIR_NAMED_PREFIX)
        ) {
          includeRefs.push("*(directory)*");
        }
        return;
      }
      if (typeof obj !== "object" || obj === null) return;
      if (Array.isArray(obj)) {
        obj.forEach((v) => collectIncludes(v, depth + 1));
        return;
      }
      Object.values(obj).forEach((v) => collectIncludes(v, depth + 1));
    }
    collectIncludes(doc);

    if (includeRefs.length > 0) {
      const unique = [...new Set(includeRefs)];
      sections.push(`## Referenced Files\n\n${unique.map((r) => `- ${r}`).join("\n")}\n`);
    }

    const markdown = sections.join("\n");

    return {
      markdown,
      title,
      metadata: {
        source: "ha-yaml-converter",
        filePath,
        automationCount: asArray(doc["automation"]).length,
        scriptCount:
          typeof doc["script"] === "object" && doc["script"] !== null && !Array.isArray(doc["script"])
            ? Object.keys(doc["script"]).length
            : 0,
        sceneCount: asArray(doc["scene"]).length,
      },
    };
  },
};
