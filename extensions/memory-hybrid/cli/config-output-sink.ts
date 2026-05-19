import type { VerifyCliSink } from "./types.js";

export function createConfigOutputSink(format: "text" | "json"): VerifyCliSink {
  if (format === "json") {
    return {
      log: (s: string) => {
        try {
          JSON.parse(s);
          process.stdout.write(`${s}\n`);
          return;
        } catch {
          // Route non-JSON diagnostics away from machine-readable stdout.
        }
        console.error(s);
      },
      error: (s: string) => console.error(s),
    };
  }
  return { log: (s: string) => console.log(s), error: (s: string) => console.error(s) };
}
