import { appendFileSync } from "node:fs";
import type { JobRunEvent } from "./types.js";

export function appendJobRunEvent(eventsPath: string, event: JobRunEvent): void {
  appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, "utf-8");
}

export function parseJobRunEvents(content: string): JobRunEvent[] {
  const events: JobRunEvent[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as JobRunEvent);
    } catch {
      /* skip malformed lines */
    }
  }
  return events;
}
