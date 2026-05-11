/**
 * Auto-detect available embedding providers and their status
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface ProviderStatus {
  provider: "openai" | "ollama" | "onnx" | "google";
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
function hasConfiguredApiKey(apiKey?: string): boolean {
  return Boolean(apiKey && apiKey.trim().length > 0);
}

/**
 * Detect all available embedding providers
 */
export async function detectAvailableProviders(
  currentApiKey?: string,
  googleApiKey?: string,
): Promise<ProviderStatus[]> {
  const ollamaAvailable = await checkOllamaAvailable();
  const onnxAvailable = checkOnnxAvailable();
  const openaiConfigured = hasConfiguredApiKey(currentApiKey);
  const googleConfigured = hasConfiguredApiKey(googleApiKey ?? currentApiKey);

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
    {
      provider: "google",
      available: googleConfigured,
      reason: googleConfigured ? "Google API key is configured" : "No API key found. Requires Google/Gemini API key",
      recommendation: "Google embeddings via configured Gemini/Google API key",
      requiresApiKey: true,
      localOnly: false,
    },
  ];
}

/**
 * Recommend the best available provider based on what's currently available
 */
export async function recommendProvider(
  currentApiKey?: string,
  googleApiKey?: string,
): Promise<"ollama" | "onnx" | "openai" | "google"> {
  const providers = await detectAvailableProviders(currentApiKey, googleApiKey);

  // Prefer local providers to avoid API costs for new users
  const ollama = providers.find((p) => p.provider === "ollama");
  if (ollama?.available) {
    return "ollama";
  }

  const onnx = providers.find((p) => p.provider === "onnx");
  if (onnx?.available) {
    return "onnx";
  }

  // Fall back to configured cloud providers.
  const openai = providers.find((p) => p.provider === "openai");
  if (openai?.available) return "openai";
  const google = providers.find((p) => p.provider === "google");
  if (google?.available) return "google";

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
