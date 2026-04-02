/**
 * Lifecycle: credential hint injection (Phase 2.3).
 * Reads credentials-pending.json and injects hint on before_agent_start when enabled.
 */

import { access, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { capturePluginError } from "../services/error-reporter.js";
import type { LifecycleContext } from "./types.js";

const PENDING_TTL_MS = 5 * 60 * 1000; // 5 min

export function registerCredentialHint(api: ClawdbotPluginApi, ctx: LifecycleContext): void {
  if (!ctx.cfg.credentials.enabled || !ctx.cfg.credentials.autoDetect || ctx.cfg.verbosity === "silent") return;

  const pendingPath = join(dirname(ctx.resolvedSqlitePath), "credentials-pending.json");

  api.on("before_agent_start", async () => {
    try {
      await access(pendingPath);
    } catch {
      return;
    }
    try {
      const raw = await readFile(pendingPath, "utf-8");
      const data = JSON.parse(raw) as { hints?: string[]; at?: number };
      const at = typeof data.at === "number" ? data.at : 0;
      if (Date.now() - at > PENDING_TTL_MS) {
        await unlink(pendingPath).catch(() => {});
        return;
      }
      const hints = Array.isArray(data.hints) ? data.hints : [];
      if (hints.length === 0) {
        await unlink(pendingPath).catch(() => {});
        return;
      }
      await unlink(pendingPath).catch(() => {});
      const hintText = hints.join(", ");
      return {
        prependContext: `\n<credential-hint>\nA credential may have been shared in the previous exchange (${hintText}). Consider asking the user if they want to store it securely with credential_store.\n</credential-hint>\n`,
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "credential-hint-read",
          subsystem: "credentials",
        });
      }
      await unlink(pendingPath).catch(() => {});
    }
  });
}
