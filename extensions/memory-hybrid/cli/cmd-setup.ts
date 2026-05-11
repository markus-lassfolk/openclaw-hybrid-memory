/**
 * Interactive setup wizard for first-time configuration
 */

import type { Chainable } from "./shared.js";
import type { HybridMemoryConfig } from "../config.js";
import { detectAvailableProviders, recommendProvider } from "../utils/provider-detection.js";
import { ProgressSpinner } from "../utils/progress-indicators.js";

// Simple readline alternative for getting user input
async function prompt(question: string): Promise<string> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function promptHidden(question: string): Promise<string> {
  const readline = await import("node:readline");
  const mutableOutput = process.stdout as NodeJS.WriteStream & { muted?: boolean };
  const rl = readline.createInterface({ input: process.stdin, output: mutableOutput });
  const originalWrite = mutableOutput.write.bind(mutableOutput);
  mutableOutput.muted = false;
  mutableOutput.write = ((chunk: unknown, encoding?: BufferEncoding, cb?: (err?: Error | null) => void) => {
    if (!mutableOutput.muted) return originalWrite(chunk as string | Uint8Array, encoding, cb);
    if (typeof cb === "function") cb();
    return true;
  }) as typeof mutableOutput.write;
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      mutableOutput.muted = false;
      mutableOutput.write = originalWrite as typeof mutableOutput.write;
      process.stdout.write("\n");
      rl.close();
      resolve(answer.trim());
    });
    mutableOutput.muted = true;
  });
}

export function registerSetupCommand(
  program: Chainable,
  cfg: HybridMemoryConfig,
  runConfigSet?: (
    key: string,
    value: string,
  ) => { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }>,
): void {
  program
    .command("setup")
    .description("Interactive setup wizard for first-time configuration")
    .option("--interactive", "Run in interactive mode (ask questions)")
    .action(async (opts: { interactive?: boolean }) => {
      console.log("\n🚀 Hybrid Memory Setup Wizard\n");
      console.log("This wizard will help you configure the hybrid memory system.\n");

      // Step 1: Detect available providers
      console.log("Step 1: Detecting available embedding providers...\n");
      const spinner = new ProgressSpinner("Checking providers");
      spinner.start();

      const providers = await detectAvailableProviders(cfg.embedding?.apiKey);
      spinner.success("Provider detection complete");

      console.log("\nAvailable providers:\n");
      for (const provider of providers) {
        const icon = provider.available ? "✓" : "✗";
        const badge = provider.localOnly ? "[Local]" : "[Cloud]";
        console.log(`  ${icon} ${provider.provider.toUpperCase()} ${badge}`);
        console.log(`     ${provider.recommendation}\n`);
      }

      // Step 2: Choose provider
      let selectedProvider: string;

      if (opts.interactive) {
        const recommended = await recommendProvider(cfg.embedding?.apiKey);
        console.log(`\nRecommended provider: ${recommended.toUpperCase()}\n`);

        const answer = await prompt(`Choose provider (ollama/onnx/openai/google) [${recommended}]: `);
        selectedProvider = answer || recommended;
      } else {
        selectedProvider = await recommendProvider(cfg.embedding?.apiKey);
        console.log(`\nUsing recommended provider: ${selectedProvider}\n`);
      }

      // Step 3: Configure provider
      const configUpdates: Record<string, string> = {
        "embedding.provider": selectedProvider,
      };

      if (selectedProvider === "openai") {
        console.log("\n⚠️  OpenAI requires an API key and incurs costs.\n");

        if (opts.interactive) {
          const apiKey = await promptHidden("Enter your OpenAI API key (input hidden): ");
          if (apiKey) {
            configUpdates["embedding.apiKey"] = apiKey;
          }
        } else {
          console.log("Set your API key with: openclaw hybrid-mem config-set embedding.apiKey YOUR_KEY\n");
        }

        // Set default model
        configUpdates["embedding.model"] = "text-embedding-3-small";
      } else if (selectedProvider === "ollama") {
        configUpdates["embedding.model"] = "nomic-embed-text";
        console.log("\n💡 Make sure Ollama is running: ollama serve");
        console.log("   And pull the model: ollama pull nomic-embed-text\n");
      } else if (selectedProvider === "onnx") {
        configUpdates["embedding.model"] = "all-MiniLM-L6-v2";
      } else if (selectedProvider === "google") {
        configUpdates["embedding.model"] = "text-embedding-004";
        if (opts.interactive) {
          const apiKey = await promptHidden("Enter your Google API key (input hidden): ");
          if (apiKey) configUpdates["embedding.googleApiKey"] = apiKey;
        } else {
          console.log("Set your API key with: openclaw hybrid-mem config-set embedding.googleApiKey YOUR_KEY\n");
        }
      }

      // Step 4: Apply configuration
      console.log("\nApplying configuration...\n");

      if (!runConfigSet) {
        throw new Error("setup cannot persist configuration: config writer is unavailable in this CLI context");
      }

      for (const [key, value] of Object.entries(configUpdates)) {
        const displayValue = key.toLowerCase().includes("key") ? "[hidden]" : value;
        console.log(`  Setting ${key} = ${displayValue}`);
        const result = await runConfigSet(key, value);
        if (!result.ok) throw new Error(result.error || `Failed to set ${key}`);
      }

      // Step 5: Run verification
      console.log("\n✓ Configuration complete!\n");
      console.log("Next steps:\n");
      console.log("  1. Verify setup: openclaw hybrid-mem verify");
      console.log("  2. Try the demo: openclaw hybrid-mem demo");
      console.log("  3. Store your first fact: openclaw hybrid-mem store 'your text here'\n");

      // Show onboarding checklist
      console.log("📋 Onboarding Checklist:\n");
      console.log("  ✓ Configure embedding provider");
      console.log("  ⃞ Run verification (openclaw hybrid-mem verify)");
      console.log("  ⃞ Store your first memory");
      console.log("  ⃞ Try a semantic search");
      console.log("  ⃞ Set up backup automation\n");

      console.log("💡 For more help: openclaw hybrid-mem examples basics\n");
    });
}
