import { describe, it, expect } from "vitest";
import { victronVrmConverter } from "../../tools/converters/victron-vrm-converter.js";

const SAMPLE_CSV_HEADERS = "Timestamp,Battery Voltage (V),SOC (%),PV Power (W),AC Output (W)";
const makeCsvRow = (ts: string, bv: number, soc: number, pv: number, ac: number) => `${ts},${bv},${soc},${pv},${ac}`;

function makeCsv(rowCount: number): string {
  const rows = [SAMPLE_CSV_HEADERS];
  for (let i = 0; i < rowCount; i++) {
    const date = `2024-01-${String(i + 1).padStart(2, "0")} 12:00`;
    rows.push(makeCsvRow(date, 48 + Math.random(), 80 + i, 1000 + i * 10, 500 + i * 5));
  }
  return rows.join("\n");
}

describe("victronVrmConverter (CSV)", () => {
  it("parses a small CSV with Victron headers", () => {
    const csv = makeCsv(5);
    const result = victronVrmConverter.convert(csv, "/exports/victron_data.csv");
    expect(result.title).toBe("Victron Energy Data: victron_data.csv");
    expect(result.markdown).toContain("## Summary");
    expect(result.markdown).toContain("Date range");
    expect(result.markdown).toContain("Total rows: 5");
    expect(result.markdown).toContain("## Key Metrics");
    expect(result.metadata["rowCount"]).toBe(5);
  });

  it("summarises a large CSV without dumping all rows", () => {
    const csv = makeCsv(200);
    const result = victronVrmConverter.convert(csv, "/exports/large.csv");
    expect(result.markdown).toContain("200 rows");
    expect(result.markdown).toContain("## Summary");
    // Should not contain 200 data rows in output (summary instead)
    const lineCount = result.markdown.split("\n").length;
    expect(lineCount).toBeLessThan(200);
  });

  it("includes SOC statistics", () => {
    const csv = [
      SAMPLE_CSV_HEADERS,
      "2024-01-01,48.0,50,800,400",
      "2024-01-02,48.5,60,900,450",
      "2024-01-03,49.0,70,1000,500",
    ].join("\n");

    const result = victronVrmConverter.convert(csv, "/exports/stats.csv");
    expect(result.markdown).toContain("SOC:");
    expect(result.markdown).toContain("60.0%"); // avg
  });

  it("includes PV power statistics", () => {
    const csv = [SAMPLE_CSV_HEADERS, "2024-01-01,48.0,80,1000,400", "2024-01-02,48.5,85,2000,450"].join("\n");

    const result = victronVrmConverter.convert(csv, "/exports/pv.csv");
    expect(result.markdown).toContain("PV Power:");
    expect(result.markdown).toContain("2000"); // peak
  });

  it("notes when CSV headers are not Victron-specific", () => {
    const csv = "Name,Value,Date\nfoo,1,2024-01-01\n";
    const result = victronVrmConverter.convert(csv, "/exports/generic.csv");
    expect(result.markdown).toContain("may not be a Victron VRM export");
  });

  it("handles empty CSV gracefully", () => {
    const result = victronVrmConverter.convert("", "/exports/empty.csv");
    expect(result.title).toContain("empty.csv");
    // Should not throw
  });
});

describe("victronVrmConverter (JSON)", () => {
  it("parses a Victron-style JSON with records array", () => {
    const json = JSON.stringify({
      records: [
        { timestamp: "2024-01-01T12:00:00", soc: 80, pv_power: 1000, battery_voltage: 48.5 },
        { timestamp: "2024-01-01T13:00:00", soc: 85, pv_power: 1200, battery_voltage: 49.0 },
        { timestamp: "2024-01-01T14:00:00", soc: 90, pv_power: 800, battery_voltage: 49.5 },
      ],
    });

    const result = victronVrmConverter.convert(json, "/exports/victron.json");
    expect(result.title).toBe("Victron Energy Data: victron.json");
    expect(result.markdown).toContain("## Summary");
    expect(result.markdown).toContain("Total records: 3");
    expect(result.metadata["recordCount"]).toBe(3);
  });

  it("parses a Victron-style JSON with data array", () => {
    const json = JSON.stringify({
      data: [
        { soc: 75, pv_power: 500 },
        { soc: 80, pv_power: 600 },
      ],
    });

    const result = victronVrmConverter.convert(json, "/exports/data.json");
    expect(result.markdown).toContain("Total records: 2");
  });

  it("handles malformed JSON gracefully", () => {
    const result = victronVrmConverter.convert("{not valid json", "/exports/bad.json");
    expect(result.markdown).toContain("Could not parse JSON");
  });

  it("shows field names from first record", () => {
    const json = JSON.stringify({
      records: [{ battery_voltage: 48.5, soc: 80, pv_power: 1000 }],
    });

    const result = victronVrmConverter.convert(json, "/exports/fields.json");
    expect(result.markdown).toContain("battery_voltage");
    expect(result.markdown).toContain("soc");
    expect(result.markdown).toContain("pv_power");
  });

  it("handles flat JSON object (no records/data array)", () => {
    const json = JSON.stringify({
      device_name: "Cerbo GX",
      firmware: "3.14",
      soc: 85,
    });

    const result = victronVrmConverter.convert(json, "/exports/device_info.json");
    expect(result.markdown).toContain("## Summary");
    expect(result.markdown).toContain("device_name");
  });
});
