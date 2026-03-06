/**
 * Victron VRM CSV/JSON Converter
 *
 * Converts Victron VRM energy data exports (CSV or JSON) into structured Markdown.
 * Handles large CSVs by summarising rather than dumping all rows.
 */

import { basename, extname } from "node:path";
import type { Converter, ConversionResult } from "./index.js";

// Known Victron CSV header fragments
const VICTRON_CSV_HEADERS = [
  "Battery Voltage",
  "PV Power",
  "AC Output",
  "SOC",
  "Grid Power",
  "Battery Current",
  "Yield Today",
  "Yield Total",
  "DC Power",
];

const MAX_ROWS_FULL = 50; // above this, summarise

interface ParsedCSV {
  headers: string[];
  rows: string[][];
}

function parseCSV(content: string): ParsedCSV {
  const lines = content.trim().split(/\r?\n/);
  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = splitCSVLine(lines[0] ?? "");
  const rows = lines.slice(1).map((line) => splitCSVLine(line));
  return { headers, rows };
}

function splitCSVLine(line: string): string[] {
  const results: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      results.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  results.push(current.trim());
  return results;
}

function isVictronCSV(headers: string[]): boolean {
  const headerStr = headers.join(" ");
  return VICTRON_CSV_HEADERS.some((h) => headerStr.includes(h));
}

function colIndex(headers: string[], ...candidates: string[]): number {
  for (const c of candidates) {
    const idx = headers.findIndex((h) => h.toLowerCase().includes(c.toLowerCase()));
    if (idx !== -1) return idx;
  }
  return -1;
}

function parseNum(val: string | undefined): number | null {
  if (val === undefined || val === "") return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

function summariseCSV(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "*No data rows*";

  const dateIdx = colIndex(headers, "timestamp", "datetime", "date", "time");
  const socIdx = colIndex(headers, "SOC", "state of charge");
  const pvIdx = colIndex(headers, "PV Power", "pv_power", "solar power");
  const acOutIdx = colIndex(headers, "AC Output", "ac_output");
  const voltIdx = colIndex(headers, "Battery Voltage", "batt_voltage");

  const firstDate = dateIdx !== -1 ? (rows[0]?.[dateIdx] ?? "unknown") : "unknown";
  const lastDate = dateIdx !== -1 ? (rows[rows.length - 1]?.[dateIdx] ?? "unknown") : "unknown";

  const lines: string[] = [`- Date range: ${firstDate} → ${lastDate}`, `- Total rows: ${rows.length}`];

  // Compute averages/peaks for numeric columns
  if (socIdx !== -1) {
    const vals = rows.map((r) => parseNum(r[socIdx])).filter((v): v is number => v !== null);
    if (vals.length > 0) {
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      const min = Math.min(...vals);
      lines.push(`- SOC: avg ${avg.toFixed(1)}%, min ${min.toFixed(1)}%`);
    }
  }

  if (pvIdx !== -1) {
    const vals = rows.map((r) => parseNum(r[pvIdx])).filter((v): v is number => v !== null);
    if (vals.length > 0) {
      const peak = Math.max(...vals);
      const total = vals.reduce((a, b) => a + b, 0);
      lines.push(`- PV Power: peak ${peak.toFixed(0)} W, sum ${total.toFixed(0)} W·intervals`);
    }
  }

  if (acOutIdx !== -1) {
    const vals = rows.map((r) => parseNum(r[acOutIdx])).filter((v): v is number => v !== null);
    if (vals.length > 0) {
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      lines.push(`- AC Output: avg ${avg.toFixed(0)} W`);
    }
  }

  if (voltIdx !== -1) {
    const vals = rows.map((r) => parseNum(r[voltIdx])).filter((v): v is number => v !== null);
    if (vals.length > 0) {
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      lines.push(`- Battery Voltage: avg ${avg.toFixed(2)} V, min ${min.toFixed(2)} V, max ${max.toFixed(2)} V`);
    }
  }

  return lines.join("\n");
}

function renderCSVRows(headers: string[], rows: string[][]): string {
  const header = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const dataRows = rows.slice(0, MAX_ROWS_FULL).map((r) => {
    const padded = headers.map((_, i) => r[i] ?? "");
    return `| ${padded.join(" | ")} |`;
  });
  return [header, sep, ...dataRows].join("\n");
}

// --- JSON handling ---

interface VictronRecord {
  [key: string]: unknown;
}

interface VictronJSON {
  records?: VictronRecord[];
  data?: VictronRecord[];
  [key: string]: unknown;
}

function isVictronJSON(obj: unknown): obj is VictronJSON {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  // Accept if it has records/data arrays, or Victron-style fields
  if (Array.isArray(o["records"]) || Array.isArray(o["data"])) return true;
  // Check for Victron-style top-level keys
  const keys = Object.keys(o).join(" ").toLowerCase();
  return keys.includes("soc") || keys.includes("pv") || keys.includes("battery") || keys.includes("victron");
}

function summariseJSONRecords(records: VictronRecord[]): string {
  if (records.length === 0) return "*No records*";
  const lines: string[] = [`- Total records: ${records.length}`];

  // Sample keys from first record
  const firstRec = records[0];
  if (firstRec) {
    lines.push(`- Fields: ${Object.keys(firstRec).join(", ")}`);
  }

  // Numeric summaries
  const numericFields: Record<string, number[]> = {};
  for (const rec of records) {
    for (const [k, v] of Object.entries(rec)) {
      if (typeof v === "number") {
        (numericFields[k] ??= []).push(v);
      }
    }
  }
  for (const [field, vals] of Object.entries(numericFields)) {
    if (vals.length === 0) continue;
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    lines.push(`- ${field}: avg ${avg.toFixed(2)}, min ${min.toFixed(2)}, max ${max.toFixed(2)}`);
  }

  return lines.join("\n");
}

export const victronVrmConverter: Converter = {
  extensions: [".csv", ".json"],

  convert(content: string, filePath: string): ConversionResult {
    const fileName = basename(filePath);
    const ext = extname(filePath).toLowerCase();
    const title = `Victron Energy Data: ${fileName}`;
    const sections: string[] = [`# ${title}\n`];

    const metadata: Record<string, unknown> = {
      source: "victron-vrm-converter",
      filePath,
    };

    if (ext === ".csv") {
      const { headers, rows } = parseCSV(content);

      if (!isVictronCSV(headers)) {
        sections.push(`*Note: CSV may not be a Victron VRM export (unrecognised headers)*\n`);
      }

      sections.push(`## Summary\n\n${summariseCSV(headers, rows)}\n`);

      if (rows.length <= MAX_ROWS_FULL) {
        sections.push(`## Key Metrics\n\n${renderCSVRows(headers, rows)}\n`);
      } else {
        sections.push(
          `## Key Metrics\n\n*${rows.length} rows — showing first ${MAX_ROWS_FULL} rows*\n\n${renderCSVRows(headers, rows)}\n`,
        );
      }

      metadata["rowCount"] = rows.length;
      metadata["headers"] = headers;
    } else {
      // JSON
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        sections.push(`*Error: Could not parse JSON*\n`);
        return { markdown: sections.join("\n"), title, metadata };
      }

      if (!isVictronJSON(parsed)) {
        sections.push(`*Note: JSON may not be a Victron VRM export*\n`);
      }

      const obj = parsed as VictronJSON;
      const records: VictronRecord[] = Array.isArray(obj["records"])
        ? obj["records"]
        : Array.isArray(obj["data"])
          ? obj["data"]
          : [];

      if (records.length > 0) {
        sections.push(`## Summary\n\n${summariseJSONRecords(records)}\n`);
        metadata["recordCount"] = records.length;
      } else {
        // Flat JSON object
        const keys = Object.keys(obj).filter((k) => k !== "records" && k !== "data");
        const summary = keys.map((k) => `- ${k}: ${JSON.stringify(obj[k])}`).join("\n");
        sections.push(`## Summary\n\n${summary || "*No data*"}\n`);
      }
    }

    return {
      markdown: sections.join("\n"),
      title,
      metadata,
    };
  },
};
