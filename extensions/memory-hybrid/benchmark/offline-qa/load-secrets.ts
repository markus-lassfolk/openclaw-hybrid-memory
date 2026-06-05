import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Keys fetched from Maeve — always prefer secrets.env over stale shell env for offline QA. */
const QA_SECRET_KEYS = new Set(["AZURE_OPENAI_API_KEY", "AZURE_FOUNDRY_BASE_URL", "AZURE_OPENAI_BASE_URL"]);

/** Load `.offline-qa/secrets.env` into process.env (QA secret keys always override). */
export function loadOfflineQaSecrets(qaRoot: string): boolean {
  const path = join(qaRoot, "secrets.env");
  if (!existsSync(path)) return false;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (QA_SECRET_KEYS.has(key) || process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = val;
    }
  }
  return true;
}
