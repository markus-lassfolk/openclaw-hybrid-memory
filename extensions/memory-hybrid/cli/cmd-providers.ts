/**
 * CLI command to show available embedding providers
 */

import type { Chainable } from "./shared.js";
import type { HybridMemoryConfig } from "../config.js";
import { detectAvailableProviders, formatProviderStatus, recommendProvider } from "../utils/provider-detection.js";
import { withExit } from "./shared.js";

export function registerProvidersCommand(program: Chainable, cfg: HybridMemoryConfig): void {
  program
    .command("providers")
    .description("List available embedding providers and their status (✓ available, ✗ needs setup)")
    .action(async () => {
      try {
        console.log("\n📡 Embedding Provider Status\n");

        const currentApiKey = cfg.embedding?.apiKey;
        const providers = await detectAvailableProviders(currentApiKey);

        for (const provider of providers) {
          console.log(formatProviderStatus(provider));
          console.log();
        }

        const currentProvider = cfg.embedding?.provider || "none";
        console.log(`Current provider: ${currentProvider}\n`);

        // Show recommendation if current provider is unavailable
        const currentStatus = providers.find((p) => p.provider === currentProvider);
        if (!currentStatus?.available) {
          const recommended = await recommendProvider(currentApiKey);
          console.log(`💡 Recommended: Switch to ${recommended.toUpperCase()}`);
          console.log(`   Run: openclaw hybrid-mem config-set embedding.provider ${recommended}\n`);
        }
      } catch (error) {
        console.error("Error checking providers:", error);
        process.exit(1);
      }
    });
}
