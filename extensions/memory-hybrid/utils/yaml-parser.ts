/**
 * Minimal inline YAML parser.
 *
 * Supports: block mappings, block sequences, flow sequences, scalar values
 * (strings, numbers, booleans, nulls), quoted keys/values, and inline comments.
 *
 * Does NOT support: anchors/aliases, multi-line scalars, flow mappings, tags.
 * Sufficient for IOT config files (Home Assistant, ESPHome, Zigbee2MQTT).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type YAMLValue = string | number | boolean | null | any[] | Record<string, any>;

interface ParseCtx {
  lines: string[];
  pos: number;
}

export function parseYaml(text: string): YAMLValue {
  if (!text || !text.trim()) return null;
  const normalized = text.replace(/\r/g, "");
  const ctx: ParseCtx = { lines: normalized.split("\n"), pos: 0 };
  skipBlanks(ctx);
  if (ctx.pos >= ctx.lines.length) return null;
  return parseNode(ctx, -1) ?? null;
}

function skipBlanks(ctx: ParseCtx): void {
  while (ctx.pos < ctx.lines.length) {
    const t = ctx.lines[ctx.pos].trim();
    if (t === "" || t.startsWith("#") || t === "---") {
      ctx.pos++;
    } else {
      break;
    }
  }
}

function getIndent(line: string): number {
  const i = line.search(/\S/);
  return i < 0 ? Infinity : i;
}

function parseNode(ctx: ParseCtx, parentIndent: number): YAMLValue {
  skipBlanks(ctx);
  if (ctx.pos >= ctx.lines.length) return null;

  const line = ctx.lines[ctx.pos];
  const indent = getIndent(line);
  if (indent <= parentIndent) return null;

  const content = line.slice(indent);

  if (content.startsWith("- ") || content === "-") {
    return parseSequence(ctx, indent);
  }
  if (hasMappingColon(content)) {
    return parseMapping(ctx, indent);
  }
  ctx.pos++;
  return parseScalar(removeInlineComment(content));
}

function hasMappingColon(content: string): boolean {
  if (content.startsWith("- ") || content === "-") return false;
  return findMappingColon(content) >= 0;
}

function findMappingColon(s: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === ":" && !inSingle && !inDouble) {
      if (i + 1 >= s.length || s[i + 1] === " " || s[i + 1] === "\t") {
        return i;
      }
    }
  }
  return -1;
}

function parseMapping(ctx: ParseCtx, baseIndent: number): Record<string, YAMLValue> {
  const result: Record<string, YAMLValue> = {};

  while (true) {
    skipBlanks(ctx);
    if (ctx.pos >= ctx.lines.length) break;

    const line = ctx.lines[ctx.pos];
    const indent = getIndent(line);
    if (indent !== baseIndent) break;

    const content = line.slice(indent);
    if (content.startsWith("- ") || content === "-") break;

    const colonIdx = findMappingColon(content);
    if (colonIdx < 0) break;

    ctx.pos++;
    const key = unquoteStr(content.substring(0, colonIdx).trim());
    const valueStr = content.substring(colonIdx + 1).trim();

    if (valueStr === "") {
      skipBlanks(ctx);
      const next = ctx.pos < ctx.lines.length ? ctx.lines[ctx.pos] : null;
      if (next !== null && getIndent(next) > baseIndent) {
        result[key] = parseNode(ctx, baseIndent) ?? null;
      } else {
        result[key] = null;
      }
    } else {
      result[key] = parseScalar(removeInlineComment(valueStr));
    }
  }

  return result;
}

function parseSequence(ctx: ParseCtx, baseIndent: number): YAMLValue[] {
  const result: YAMLValue[] = [];

  while (true) {
    skipBlanks(ctx);
    if (ctx.pos >= ctx.lines.length) break;

    const line = ctx.lines[ctx.pos];
    const indent = getIndent(line);
    if (indent !== baseIndent) break;

    const content = line.slice(indent);
    if (!content.startsWith("- ") && content !== "-") break;

    ctx.pos++;

    const afterDash = content.substring(2).trim();
    if (afterDash === "") {
      skipBlanks(ctx);
      const next = ctx.pos < ctx.lines.length ? ctx.lines[ctx.pos] : null;
      if (next && getIndent(next) > baseIndent) {
        result.push(parseNode(ctx, baseIndent) ?? null);
      } else {
        result.push(null);
      }
    } else if (hasMappingColon(afterDash)) {
      result.push(parseSeqMapItem(ctx, afterDash, baseIndent));
    } else {
      result.push(parseScalar(removeInlineComment(afterDash)));
    }
  }

  return result;
}

function parseSeqMapItem(ctx: ParseCtx, firstPair: string, seqIndent: number): Record<string, YAMLValue> {
  const result: Record<string, YAMLValue> = {};

  parsePairInto(ctx, firstPair, seqIndent, result);

  while (true) {
    skipBlanks(ctx);
    if (ctx.pos >= ctx.lines.length) break;

    const line = ctx.lines[ctx.pos];
    const indent = getIndent(line);
    if (indent <= seqIndent) break;

    const content = line.slice(indent);
    if (content.startsWith("- ") || content === "-") break;

    const colonIdx = findMappingColon(content);
    if (colonIdx < 0) break;

    ctx.pos++;
    const key = unquoteStr(content.substring(0, colonIdx).trim());
    const valueStr = content.substring(colonIdx + 1).trim();

    if (valueStr === "") {
      skipBlanks(ctx);
      const next = ctx.pos < ctx.lines.length ? ctx.lines[ctx.pos] : null;
      if (next && getIndent(next) > indent) {
        result[key] = parseNode(ctx, indent) ?? null;
      } else {
        result[key] = null;
      }
    } else {
      result[key] = parseScalar(removeInlineComment(valueStr));
    }
  }

  return result;
}

function parsePairInto(ctx: ParseCtx, content: string, parentIndent: number, result: Record<string, YAMLValue>): void {
  const colonIdx = findMappingColon(content);
  if (colonIdx < 0) return;

  const key = unquoteStr(content.substring(0, colonIdx).trim());
  const valueStr = content.substring(colonIdx + 1).trim();

  if (valueStr === "") {
    skipBlanks(ctx);
    const next = ctx.pos < ctx.lines.length ? ctx.lines[ctx.pos] : null;
    if (next && getIndent(next) > parentIndent) {
      result[key] = parseNode(ctx, parentIndent) ?? null;
    } else {
      result[key] = null;
    }
  } else {
    result[key] = parseScalar(removeInlineComment(valueStr));
  }
}

function unquoteStr(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

function removeInlineComment(s: string): string {
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === "#" && !inDouble && !inSingle && i > 0 && s[i - 1] === " ") {
      return s.substring(0, i).trim();
    }
  }
  return s;
}

function parseScalar(s: string): YAMLValue {
  if (s === "") return null;

  // Flow sequence
  if (s.startsWith("[") && s.endsWith("]")) {
    return parseFlowSequence(s);
  }

  // Quoted string
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }

  // Boolean
  const lower = s.toLowerCase();
  if (lower === "true" || lower === "yes" || lower === "on") return true;
  if (lower === "false" || lower === "no" || lower === "off") return false;

  // Null
  if (lower === "null" || s === "~") return null;

  // Integer
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);

  // Float
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);

  // Everything else: string (includes URLs, hex values like 0x1a62, paths, etc.)
  return s;
}

function parseFlowSequence(s: string): YAMLValue[] {
  const inner = s.slice(1, -1).trim();
  if (!inner) return [];

  const items: string[] = [];
  let depth = 0;
  let inDouble = false;
  let inSingle = false;
  let current = "";

  for (const c of inner) {
    if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === "[" || c === "{") {
      if (!inDouble && !inSingle) depth++;
    } else if (c === "]" || c === "}") {
      if (!inDouble && !inSingle) depth--;
    } else if (c === "," && depth === 0 && !inDouble && !inSingle) {
      items.push(current.trim());
      current = "";
      continue;
    }
    current += c;
  }
  if (current.trim()) items.push(current.trim());

  return items.map(parseScalar);
}
