/**
 * Authentication Failure Detection Service
 * FR-047: Auto-Recall on Authentication Failures
 * 
 * Detects authentication failures in tool results and extracts target identifiers
 * (hostname, IP, URL domain, service name) for memory recall.
 */

export type AuthFailurePattern = {
  regex: RegExp;
  type: "ssh" | "http" | "api" | "generic";
  hint: string;
};

/** Predefined auth failure patterns for common protocols */
export const DEFAULT_AUTH_FAILURE_PATTERNS: AuthFailurePattern[] = [
  // SSH patterns
  { regex: /Permission denied/i, type: "ssh", hint: "SSH permission denied" },
  { regex: /Authentication failed/i, type: "ssh", hint: "SSH authentication failed" },
  { regex: /publickey,password/i, type: "ssh", hint: "SSH auth methods exhausted" },
  { regex: /Host key verification failed/i, type: "ssh", hint: "SSH host key verification failed" },
  
  // HTTP patterns
  { regex: /\b401\b/, type: "http", hint: "HTTP 401 Unauthorized" },
  { regex: /\b403\b/, type: "http", hint: "HTTP 403 Forbidden" },
  { regex: /Unauthorized/i, type: "http", hint: "HTTP Unauthorized" },
  { regex: /Forbidden/i, type: "http", hint: "HTTP Forbidden" },
  
  // API patterns
  { regex: /Invalid API key/i, type: "api", hint: "Invalid API key" },
  { regex: /token expired/i, type: "api", hint: "Token expired" },
  { regex: /token invalid/i, type: "api", hint: "Token invalid" },
  { regex: /invalid_auth/i, type: "api", hint: "Invalid authentication" },
  { regex: /authentication.*(required|failed)/i, type: "api", hint: "Authentication required/failed" },
  { regex: /invalid.*(credentials|token|key)/i, type: "api", hint: "Invalid credentials" },
];

export type AuthFailureDetection = {
  detected: boolean;
  type?: "ssh" | "http" | "api" | "generic";
  hint?: string;
  target?: string; // hostname, IP, URL domain, service name
  // Note: originalText removed for security - could leak credential values from error messages
};

/**
 * Extract target identifier from tool result context.
 * Looks for:
 * - Hostnames/IPs (SSH, API endpoints)
 * - URLs and domains (HTTP APIs)
 * - Service names mentioned in context
 */
export function extractTarget(text: string, type: "ssh" | "http" | "api" | "generic"): string | undefined {
  // Try IP address first (highest priority) - this should match across all types
  // Note: Regex is intentionally loose (matches 999.999.999.999) for simplicity; 
  // invalid IPs will fail at connection time, not here
  const ipMatch = text.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/);
  if (ipMatch) return ipMatch[1];
  
  // Try URL/domain patterns (for http/api types)
  if (type === "http" || type === "api") {
    const urlMatch = text.match(/https?:\/\/([\w.-]+)/i);
    if (urlMatch) return urlMatch[1];
    
    // Try domain-like patterns without protocol
    const domainMatch = text.match(/(?:to|from|at|@)\s+([\w.-]+\.\w{2,})/i);
    if (domainMatch) return domainMatch[1];
  }
  
  // Try SSH patterns: user@host
  if (type === "ssh") {
    const sshUserHostMatch = text.match(/(?:ssh\s+)?[\w.-]+@([\w.-]+)/i);
    if (sshUserHostMatch && sshUserHostMatch[1]) return sshUserHostMatch[1];
  }
  
  // Try to find hostname-like strings (at least 3 chars, contains dot or dash)
  const hostnameMatch = text.match(/\b([\w-]{3,}(?:\.[\w-]+)+)\b/);
  if (hostnameMatch) return hostnameMatch[1];
  
  // Try to find service names mentioned after "to/from/at/for" (excluding common words)
  const serviceMatch = text.match(/(?:to|from|at|for)\s+["']?([\w-]{4,})["']?/i);
  if (serviceMatch && serviceMatch[1]) {
    const serviceName = serviceMatch[1].toLowerCase();
    // Filter out common words that aren't service names
    const commonWords = ["the", "this", "that", "with", "your", "from", "failed", "authentication", "connection"];
    if (!commonWords.includes(serviceName)) {
      return serviceName;
    }
  }
  
  return undefined;
}

/**
 * Detect authentication failures in tool result text.
 * Returns detection info including type, hint, and extracted target.
 */
export function detectAuthFailure(
  text: string,
  patterns: AuthFailurePattern[] = DEFAULT_AUTH_FAILURE_PATTERNS,
): AuthFailureDetection {
  if (!text || text.length < 10) {
    return { detected: false };
  }
  
  for (const pattern of patterns) {
    if (pattern.regex.test(text)) {
      const target = extractTarget(text, pattern.type);
      return {
        detected: true,
        type: pattern.type,
        hint: pattern.hint,
        target,
        // originalText removed for security (could leak credential values in error messages)
      };
    }
  }
  
  return { detected: false };
}

/**
 * Build search query for memory recall based on detected auth failure.
 * Combines target identifier with credential-related terms.
 */
export function buildCredentialQuery(detection: AuthFailureDetection): string | null {
  if (!detection.detected || !detection.target) return null;
  
  const target = detection.target;
  const terms = ["credential", "password", "token", "key", "auth"];
  
  // Build query with target + credential terms
  return `${target} ${terms.join(" ")}`;
}

/**
 * Format system hint for injection into agent context.
 * Returns a user-friendly message pointing to relevant credentials in memory.
 * 
 * SECURITY: Does not include fact.text to prevent credential leaks.
 * Shows only safe metadata (entity, category, key).
 */
export function formatCredentialHint(
  detection: AuthFailureDetection,
  facts: Array<{ text: string; category: string; entity?: string | null; key?: string | null }>,
): string {
  if (facts.length === 0) return "";
  
  const target = detection.target || "this service";
  const lines: string[] = [
    `💡 Memory has credentials for ${target}:`,
  ];
  
  for (let i = 0; i < Math.min(facts.length, 3); i++) {
    const f = facts[i];
    // Show only metadata to prevent credential leaks
    const parts: string[] = [];
    if (f.entity) parts.push(`entity: ${f.entity}`);
    if (f.key) parts.push(`key: ${f.key}`);
    if (f.category && f.category !== "technical") parts.push(`[${f.category}]`);
    
    const metadata = parts.length > 0 ? parts.join(", ") : "stored credential";
    lines.push(`  ${i + 1}. ${metadata}`);
  }
  
  return lines.join("\n");
}
