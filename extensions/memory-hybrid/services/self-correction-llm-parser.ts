import { parseStructuredItemsAcceptingEmpty } from "../utils/llm-json-array.js";

function isSelfCorrectionRemediationItem(item: unknown): boolean {
  if (typeof item !== "object" || item === null) return false;
  const candidate = item as Record<string, unknown>;
  const remediationType = candidate.remediationType;
  if (typeof remediationType !== "string" || remediationType.trim().length === 0) return false;

  const isNoAction = remediationType.trim().toUpperCase() === "NO_ACTION";
  if ("remediationContent" in candidate) {
    const remediationContent = candidate.remediationContent;
    if (
      !(
        typeof remediationContent === "string" ||
        (typeof remediationContent === "object" && remediationContent !== null)
      )
    ) {
      return false;
    }
  } else if (!isNoAction) {
    return false;
  }

  if ("category" in candidate && typeof candidate.category !== "string") return false;
  if ("severity" in candidate && typeof candidate.severity !== "string") return false;
  if ("repeated" in candidate && typeof candidate.repeated !== "boolean") return false;
  if ("incidentIndex" in candidate) {
    const idx = candidate.incidentIndex;
    if (typeof idx !== "number" && typeof idx !== "string") return false;
  }

  return true;
}

/**
 * Parse the JSON array of remediation items from a self-correction LLM response.
 * Returns `null` when no valid array can be extracted.
 */
export function parseSelfCorrectionLLMResponse(content: string): unknown[] | null {
  return parseStructuredItemsAcceptingEmpty(content, isSelfCorrectionRemediationItem);
}
