/**
 * Auto-detect available embedding providers and their status
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

export interface ProviderStatus {
  provider: "openai" | "ollama" | "onnx";
  available: boolean;
  reason?: string;
  recommendation?: string;
  requiresApiKey: boolean;
  localOnly: boolean;
}

/**
 * Check if Ollama is running on localhost
 */
async function checkOllamaAvailable(): Promise<boolean> {
  try {
    const response = await fetch("http://localhost:11434/api/tags", {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Check if ONNX runtime is available
 */
function checkOnnxAvailable(): boolean {
  try {
    // Check if onnxruntime-node is installed
    require.resolve("onnxruntime-node");
    return true;
  } catch {
    return false;
  }
}

/**
 * Check OpenAI API availability (requires API key)
 */
function checkOpenAIConfigured(apiKey?: string): boolean {
  return Boolean(apiKey && apiKey.trim().length > 0);
}

/**
 * Detect all available embedding providers
 */
export async function detectAvailableProviders(currentApiKey?: string): Promise<ProviderStatus[]> {
  const ollamaAvailable = await checkOllamaAvailable();
  const onnxAvailable = checkOnnxAvailable();
  const openaiConfigured = checkOpenAIConfigured(currentApiKey);

  return [
    {
      provider: "ollama",
      available: ollamaAvailable,
      reason: ollamaAvailable
        ? "Ollama is running on localhost:11434"
        : "Ollama is not running. Start with: ollama serve",
      recommendation: ollamaAvailable
        ? "Best for local, private embedding without API costs"
        : "Install from https://ollama.ai and run: ollama pull nomic-embed-text",
      requiresApiKey: false,
      localOnly: true,
    },
    {
      provider: "onnx",
      available: onnxAvailable,
      reason: onnxAvailable ? "ONNX runtime is installed" : "onnxruntime-node is not installed",
      recommendation: onnxAvailable
        ? "Lightweight local embeddings, no dependencies"
        : "Install with: npm install onnxruntime-node",
      requiresApiKey: false,
      localOnly: true,
    },
    {
      provider: "openai",
      available: openaiConfigured,
      reason: openaiConfigured ? "API key is configured" : "No API key found. Requires OpenAI API key",
      recommendation: "High-quality embeddings, requires API key and incurs costs",
      requiresApiKey: true,
      localOnly: false,
    },
  ];
}

/**
 * Recommend the best available provider based on what's currently available
 */
export async function recommendProvider(currentApiKey?: string): Promise<"ollama" | "onnx" | "openai"> {
  const providers = await detectAvailableProviders(currentApiKey);

  // Prefer local providers to avoid API costs for new users
  const ollama = providers.find((p) => p.provider === "ollama");
  if (ollama?.available) {
    return "ollama";
  }

  const onnx = providers.find((p) => p.provider === "onnx");
  if (onnx?.available) {
    return "onnx";
  }

  // Fall back to OpenAI if configured
  const openai = providers.find((p) => p.provider === "openai");
  if (openai?.available) {
    return "openai";
  }

  // Default to ollama with instructions to set it up
  return "ollama";
}

/**
 * Format provider status for CLI display
 */
export function formatProviderStatus(status: ProviderStatus): string {
  const icon = status.available ? "✓" : "✗";
  const badge = status.localOnly ? "[Local]" : "[Cloud]";
  const apiKeyBadge = status.requiresApiKey ? "[API Key Required]" : "";

  const lines = [`${icon} ${status.provider.toUpperCase()} ${badge} ${apiKeyBadge}`, `   ${status.reason}`];

  if (status.recommendation) {
    lines.push(`   ${status.recommendation}`);
  }

  return lines.join("\n");
}
