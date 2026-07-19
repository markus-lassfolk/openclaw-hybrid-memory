/** Loom brief tool (Issue #2154) — pre-action synthesis compact enough to inject into a prompt. */
import { Type } from "@sinclair/typebox";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { LoomStore } from "../backends/loom-store.js";
import type { HybridMemoryConfig } from "../config.js";
import { capturePluginError } from "../services/error-reporter.js";
import { buildLoomBrief, renderLoomBriefMarkdown } from "../services/loom-brief.js";
import { stringEnum } from "../utils/typebox.js";

export interface LoomBriefToolsContext {
  loomStore: LoomStore;
  cfg: HybridMemoryConfig;
}

export function registerLoomBriefTools(ctx: LoomBriefToolsContext, api: ClawdbotPluginApi): void {
  const { loomStore, cfg } = ctx;
  const lc = cfg.loom;

  api.registerTool(
    {
      name: "memory_loom_brief",
      label: "Loom Brief",
      description:
        "Compose a bounded, prompt-safe pre-action briefing: relevant beliefs (labeled verified/stale/contradicted), open loops, recent evidence, drift warnings, attention priorities, live checks required before action, and safe next actions. Answers: what should I know before acting, and what must I verify live?",
      parameters: Type.Object({
        scope: Type.String({ description: 'Free-text scope, e.g. "Doris M365 auth". Empty string = workspace-wide.' }),
        task: Type.Optional(Type.String()),
        max_tokens: Type.Optional(
          Type.Number({ description: "Approximate token budget (converted to a character cap)." }),
        ),
        format: Type.Optional(stringEnum(["json", "md"] as const)),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (!lc.enabled || !lc.brief.enabled) {
          return {
            content: [
              { type: "text", text: "The Loom brief is disabled. Set loom.enabled and loom.brief.enabled: true." },
            ],
            details: { error: "loom_disabled" },
          };
        }
        try {
          const p = params as { scope?: string; task?: string; max_tokens?: number; format?: "json" | "md" };
          const maxChars = p.max_tokens ? Math.max(200, Math.min(50_000, p.max_tokens * 4)) : lc.brief.maxChars;
          const brief = buildLoomBrief({ loomStore }, { scope: p.scope ?? "", task: p.task, maxChars });
          const text = p.format === "md" ? renderLoomBriefMarkdown(brief) : JSON.stringify(brief, null, 2);
          return { content: [{ type: "text", text }], details: { brief } };
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "loom-brief",
            operation: "memory_loom_brief",
          });
          return { content: [{ type: "text", text: String(err) }], details: { error: String(err) } };
        }
      },
    },
    { name: "memory_loom_brief" },
  );
}
