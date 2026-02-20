/**
 * Credential Scanner Service
 * 
 * Scans tool call inputs for credential patterns (passwords, tokens, API keys, etc.)
 * and extracts them for secure storage in the vault.
 * 
 * SECURITY: Only scan tool *inputs*, never outputs (which may contain secrets from APIs).
 */

import type { CredentialType } from "../config.js";

export type ToolCallCredential = {
  service: string;     // e.g., "ssh://user@host", "github", "api.example.com"
  type: CredentialType;
  value: string;       // The actual secret
  url?: string;        // Optional URL for context
  notes?: string;      // Auto-generated notes
};

/**
 * Extract hostname from URL using URL constructor, with fallback regex.
 * Validates hostname to prevent injection of arbitrary strings.
 */
export function extractHostFromUrl(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    // Validate hostname: must contain at least one letter/digit, no path segments (../), no consecutive dots
    if (hostname && 
        /^[a-z0-9.-]+$/i.test(hostname) && 
        /[a-z0-9]/i.test(hostname) && 
        !hostname.includes('..') && 
        !hostname.startsWith('.') && 
        !hostname.endsWith('.')) {
      return hostname;
    }
  } catch {
    // Fallback: regex extraction with same validation
    const m = url.match(/https?:\/\/([a-z0-9.-]+)/i);
    if (m?.[1]) {
      const hostname = m[1];
      if (/[a-z0-9]/i.test(hostname) && 
          !hostname.includes('..') && 
          !hostname.startsWith('.') && 
          !hostname.endsWith('.')) {
        return hostname;
      }
    }
  }
  return "api"; // Safe default
}

/**
 * Slugify a string for use as a vault service name.
 * Lowercases, replaces spaces/underscores with dashes, strips non-alphanumeric chars.
 * Returns "imported" for slugs shorter than 2 chars.
 */
export function slugify(s: string): string {
  const slug = s.toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "");
  return slug.length >= 2 ? slug : "imported";
}

/** Derive CredentialType from an environment variable name suffix. */
export function typeFromVarName(varName: string): CredentialType {
  const lower = varName.toLowerCase();
  if (lower.endsWith("_password")) return "password";
  if (lower.endsWith("_token")) return "token";
  if (lower.endsWith("_key")) return "api_key";
  return "other";
}

/**
 * Credential extraction patterns for tool call inputs.
 * Each pattern has a regex and an extract function.
 */
export const TOOL_CALL_CREDENTIAL_PATTERNS: Array<{
  regex: RegExp;
  extract: (match: RegExpMatchArray, fullText: string) => ToolCallCredential | null;
}> = [
  // sshpass -p <password> ssh [options] <user>@<host>
  {
    regex: /sshpass[ \t]+-p[ \t]+(\S+)[ \t]+ssh(?:[ \t]+\S+)*[ \t]+([\w.-]+)@([\w.-]+)/i,
    extract(m) {
      const [, pass, user, host] = m;
      if (!pass || pass.length < 4) return null;
      return { service: `ssh://${user}@${host}`, type: "password", value: pass, notes: "auto-captured from sshpass tool call" };
    },
  },
  
  // curl -H "Authorization: Bearer <token>" [URL]
  // Fix #12: Constrain [\s\S]*? to prevent ReDoS - limit to 500 chars
  {
    regex: /curl\b[\s\S]{0,500}?-H\s+["']Authorization:\s+Bearer\s+([A-Za-z0-9_.~+/=-]{8,})/i,
    extract(m, fullText) {
      const urlMatch = fullText.match(/https?:\/\/[^\s'"]+/);
      const service = urlMatch ? extractHostFromUrl(urlMatch[0]) : "api";
      return { service, type: "bearer", value: m[1], url: urlMatch?.[0], notes: "auto-captured from curl Authorization Bearer tool call" };
    },
  },
  
  // curl -u <user>:<pass> [URL]
  // Fix #12: Constrain [\s\S]*? to prevent ReDoS - limit to 500 chars
  // Fix #13: Handle quoted values properly
  {
    regex: /curl\b[\s\S]{0,500}?-u\s+(?:["']([^"':]+):([^"']+)["']|([\w@.+-]+):([\S]+?)(?:\s|$))/,
    extract(m, fullText) {
      // m[1]:m[2] = quoted format, m[3]:m[4] = unquoted format
      const user = m[1] || m[3];
      const pass = m[2] || m[4];
      if (!pass || pass.length < 4) return null;
      const urlMatch = fullText.match(/https?:\/\/[^\s'"]+/);
      const service = urlMatch ? extractHostFromUrl(urlMatch[0]) : slugify(user);
      return { service, type: "password", value: pass, url: urlMatch?.[0], notes: `auto-captured from curl -u ${user} tool call` };
    },
  },
  
  // -H "X-API-Key: <key>" (standalone or in curl)
  {
    regex: /-H\s+["']X-API-Key:\s+([A-Za-z0-9_-]{8,})["']/i,
    extract(m, fullText) {
      const urlMatch = fullText.match(/https?:\/\/[^\s'"]+/);
      const service = urlMatch ? extractHostFromUrl(urlMatch[0]) : "api";
      return { service, type: "api_key", value: m[1], url: urlMatch?.[0], notes: "auto-captured from X-API-Key header tool call" };
    },
  },
  
  // Connection strings: postgres/mysql/mongodb/redis://user:pass@host/db
  {
    regex: /(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|mssql):\/\/([\w.-]+):([\S]+?)@([\w.-]+(?::\d+)?)\/([\w-]*)/i,
    extract(m) {
      const [, proto, user, pass, host, db] = m;
      if (!pass || pass.length < 4) return null;
      const service = db ? `${proto.toLowerCase()}://${host}/${db}` : `${proto.toLowerCase()}://${host}`;
      const url = `${proto.toLowerCase()}://${host}/${db ?? ""}`;
      return { service, type: "password", value: pass, url, notes: `auto-captured connection string (user: ${user})` };
    },
  },
  
  // export VAR=value where VAR matches *_KEY, *_TOKEN, *_PASSWORD, *_SECRET
  // Fix #13: Handle quoted values with spaces properly
  {
    regex: /\bexport\s+([A-Z][A-Z0-9_]*_(?:KEY|TOKEN|PASSWORD|SECRET))\s*=\s*(?:"([^"]{8,})"|'([^']{8,})'|([^\s"';\n]{8,}))/i,
    extract(m) {
      const [, varName, doubleQuoted, singleQuoted, unquoted] = m;
      const val = doubleQuoted || singleQuoted || unquoted;
      if (!val) return null;
      const type = typeFromVarName(varName);
      const service = slugify(varName.replace(/_(?:KEY|TOKEN|PASSWORD|SECRET)$/i, "").replace(/_/g, "-"));
      return { service, type, value: val, notes: `auto-captured from export ${varName} tool call` };
    },
  },
  
  // .env-style KEY=value (credential-like var names only)
  // Fix #16: Remove negative lookbehind (not compatible with all Node versions)
  // Instead, filter out lines that start with 'export ' in post-processing
  {
    regex: /(?:^|\n)\s*([A-Z][A-Z0-9_]*_(?:KEY|TOKEN|PASSWORD|SECRET))\s*=\s*(?:"([^"]{8,})"|'([^']{8,})'|([^\s"';\n]{8,}))/i,
    extract(m, fullText) {
      // Check if this match is preceded by 'export' on the same line
      const matchIndex = fullText.indexOf(m[0]);
      if (matchIndex > 0) {
        const lineStart = fullText.lastIndexOf('\n', matchIndex) + 1;
        const linePrefix = fullText.slice(lineStart, matchIndex).trim().toLowerCase();
        if (linePrefix === 'export') {
          return null; // Skip, already handled by export pattern
        }
      }
      
      const [, varName, doubleQuoted, singleQuoted, unquoted] = m;
      const val = doubleQuoted || singleQuoted || unquoted;
      if (!val) return null;
      const type = typeFromVarName(varName);
      const service = slugify(varName.replace(/_(?:KEY|TOKEN|PASSWORD|SECRET)$/i, "").replace(/_/g, "-"));
      return { service, type, value: val, notes: `auto-captured from env assignment ${varName}` };
    },
  },
];

/**
 * Scan a tool call input string for credential patterns.
 * Returns a deduplicated list of extracted credentials (by service+type).
 * Only tool *inputs* should be passed here — never outputs.
 * 
 * Fix #15: Add try/catch around pattern extraction to prevent one bad regex from breaking the entire scan.
 */
export function extractCredentialsFromToolCalls(text: string): ToolCallCredential[] {
  const results: ToolCallCredential[] = [];
  const seen = new Set<string>();
  
  for (const { regex, extract } of TOOL_CALL_CREDENTIAL_PATTERNS) {
    try {
      // Use a global copy of the regex so we find all occurrences, not just the first.
      const globalRegex = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : regex.flags + "g");
      for (const match of text.matchAll(globalRegex)) {
        try {
          const cred = extract(match, text);
          if (!cred || cred.value.length < 4) continue;
          const key = `${cred.service}:${cred.type}`;
          if (!seen.has(key)) {
            seen.add(key);
            results.push(cred);
          }
        } catch (extractErr) {
          // Skip this match if extraction fails, continue with others
          continue;
        }
      }
    } catch (regexErr) {
      // Skip this pattern if regex fails, continue with others
      continue;
    }
  }
  
  return results;
}
