/**
 * Reference sidecars: telemetry, TOC for long files.
 */

import { utf8ByteLength } from "../config/skill-size-limits.js";

const TOC_LINE_THRESHOLD = 100;

export function addTableOfContentsIfLong(markdown: string, threshold = TOC_LINE_THRESHOLD): string {
  const lines = markdown.split(/\r?\n/);
  if (lines.length <= threshold) return markdown;
  if (markdown.includes("## Table of contents")) return markdown;

  const headings: Array<{ level: number; text: string; anchor: string }> = [];
  for (const line of lines) {
    const m = line.match(/^(#{1,3})\s+(.+)$/);
    if (!m) continue;
    const level = m[1].length;
    const text = m[2].trim();
    const anchor = text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    headings.push({ level, text, anchor });
  }
  if (headings.length < 3) return markdown;

  const toc = [
    "## Table of contents",
    "",
    ...headings.map((h) => `${"  ".repeat(Math.max(0, h.level - 1))}- [${h.text}](#${h.anchor})`),
    "",
  ].join("\n");

  const firstHeading = lines.findIndex((l) => /^#\s/.test(l));
  const insertAt = firstHeading >= 0 ? firstHeading + 1 : 0;
  const out = [...lines.slice(0, insertAt), toc, ...lines.slice(insertAt)];
  return out.join("\n");
}

export function buildTelemetryReferenceMd(input: {
  slug: string;
  telemetryCommand: string;
  telemetryRequestSummaryArg: string;
}): string {
  return `# Telemetry and operator commands

## Record activation
When this skill is selected:
\`\`\`bash
${input.telemetryCommand} --decision selected --request-summary ${input.telemetryRequestSummaryArg} --outcome success
\`\`\`

When skipped (near-miss):
\`\`\`bash
${input.telemetryCommand} --decision skipped --request-summary ${input.telemetryRequestSummaryArg} --reason "near-miss summary"
\`\`\`

## False-positive feedback
\`\`\`bash
openclaw hybrid-mem skills correct <activation-id> --reason "user rejected skill"
\`\`\`

## Rollback / disable
Leave generated skills disabled until verification or human approval. Remove from the enabled skill path or keep in quarantine/draft storage.
`;
}

export function lintNestedReferences(skillMd: string): string[] {
  const violations: string[] = [];
  const nested = skillMd.match(/references\/[^)\s]+\.md[^)\s]*\s*→\s*references\//gi);
  if (nested && nested.length > 0) {
    violations.push("nested references (references/x.md → references/y.md) are not allowed");
  }
  return violations;
}

export { utf8ByteLength };
