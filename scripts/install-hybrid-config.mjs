#!/usr/bin/env node
/**
 * Standalone script: merge full Hybrid Memory defaults into openclaw.json
 * so you can get a complete config before the first gateway start.
 *
 * Usage (from repo root):
 *   OPENCLAW_HOME=~/.openclaw node scripts/install-hybrid-config.mjs
 *   # or
 *   node scripts/install-hybrid-config.mjs
 *
 * Then set your OpenAI API key in the config and start the gateway.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const openclawDir = process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
const configPath = join(openclawDir, "openclaw.json");

const fullDefaults = {
  memory: { backend: "builtin", citations: "auto" },
  plugins: {
    slots: { memory: "memory-hybrid" },
    entries: {
      "memory-core": { enabled: true },
      "memory-hybrid": {
        enabled: true,
        config: {
          embedding: { apiKey: "YOUR_OPENAI_API_KEY", model: "text-embedding-3-small" },
          autoCapture: true,
          autoRecall: true,
          captureMaxChars: 5000,
          store: { fuzzyDedupe: false },
          autoClassify: { enabled: true, model: "gpt-4o-mini", batchSize: 20 },
          categories: [],
          credentials: { enabled: false, store: "sqlite", encryptionKey: "", autoDetect: false, expiryWarningDays: 7 },
        },
      },
    },
  },
  agents: {
    defaults: {
      bootstrapMaxChars: 15000,
      bootstrapTotalMaxChars: 50000,
      memorySearch: {
        enabled: true,
        sources: ["memory"],
        provider: "openai",
        model: "text-embedding-3-small",
        sync: { onSessionStart: true, onSearch: true, watch: true },
        chunking: { tokens: 500, overlap: 50 },
        query: { maxResults: 8, minScore: 0.3, hybrid: { enabled: true } },
      },
      compaction: {
        mode: "default",
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 4000,
          systemPrompt: "Session nearing compaction. You MUST save all important context NOW using BOTH memory systems before it is lost. This is your last chance to preserve this information.",
          prompt: "URGENT: Context is about to be compacted. Scan the full conversation and:\n1. Use memory_store for each important fact, preference, decision, or entity (structured storage survives compaction)\n2. Write a session summary to memory/YYYY-MM-DD.md with key topics, decisions, and open items\n3. Update any relevant memory/ files if project state or technical details changed\n\nDo NOT skip this. Reply NO_REPLY only if there is truly nothing worth saving.",
        },
      },
      pruning: { ttl: "30m" },
    },
  },
  jobs: [
    {
      name: "nightly-memory-sweep",
      schedule: "0 2 * * *",
      channel: "system",
      message: "Run nightly session distillation: last 3 days, Gemini model, isolated session. Log to scripts/distill-sessions/nightly-logs/YYYY-MM-DD.log",
      isolated: true,
      model: "gemini",
    },
    {
      name: "weekly-reflection",
      schedule: "0 3 * * 0",
      channel: "system",
      message: "Run memory reflection: analyze facts from the last 14 days, extract behavioral patterns, store as pattern-category facts. Use memory_reflect tool.",
      isolated: true,
      model: "gemini",
    },
  ],
};

function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];
    if (srcVal !== null && typeof srcVal === "object" && !Array.isArray(srcVal) && tgtVal !== null && typeof tgtVal === "object" && !Array.isArray(tgtVal)) {
      deepMerge(tgtVal, srcVal);
    } else if (key === "jobs" && Array.isArray(srcVal)) {
      const arr = Array.isArray(tgtVal) ? [...tgtVal] : [];
      for (const def of ["nightly-memory-sweep", "weekly-reflection"]) {
        if (!arr.some((j) => j?.name === def)) {
          const job = srcVal.find((j) => j?.name === def);
          if (job) arr.push(job);
        }
      }
      target[key] = arr;
    } else if (!Array.isArray(srcVal)) {
      target[key] = srcVal;
    }
  }
}

mkdirSync(openclawDir, { recursive: true });
mkdirSync(join(openclawDir, "memory"), { recursive: true });

let config = {};
if (existsSync(configPath)) {
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (e) {
    console.error("Could not read config:", e.message);
    process.exit(1);
  }
}

if (!config.plugins || typeof config.plugins !== "object") config.plugins = {};
if (!config.agents || typeof config.agents !== "object") config.agents = { defaults: {} };

deepMerge(config, fullDefaults);

writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
console.log("Wrote", configPath);
console.log("Applied: memory-hybrid slot, full plugin config (all features), memorySearch, compaction prompts, bootstrap limits, pruning, autoClassify, nightly-memory-sweep job.");
console.log("\nNext steps:");
console.log("  1. Set plugins.entries[\"memory-hybrid\"].config.embedding.apiKey to your OpenAI key (replace YOUR_OPENAI_API_KEY).");
console.log("  2. Copy extensions/memory-hybrid/ to your OpenClaw extensions dir and run npm install there.");
console.log("  3. Start the gateway, then run: openclaw hybrid-mem verify [--fix]");
console.log("\nTo revert later: openclaw hybrid-mem uninstall");
