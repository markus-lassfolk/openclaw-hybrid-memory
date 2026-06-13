/** Credentials subcommands that only need parsed config + CredentialsDB (issue #1883). */
const CREDENTIALS_FAST_PATH_SUBCOMMANDS = new Set([
  "get",
  "list",
  "vault-status",
  "audit",
  "encrypt-vault",
  "rekey-vault",
  "prune",
]);

/**
 * Detect vault-only CLI invocations that should skip full hybrid-memory bootstrap.
 * Exported for tests. Stops at `--` to avoid false positives.
 */
export function isHybridMemCredentialsOnlyInvocation(argv: string[]): boolean {
  const hybridIdx = argv.indexOf("hybrid-mem");
  if (hybridIdx === -1) return false;

  let sawCredentials = false;
  for (let i = hybridIdx + 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") break;
    if (a === "credentials") {
      sawCredentials = true;
      continue;
    }
    if (!sawCredentials) continue;
    if (a.startsWith("-")) continue;
    return CREDENTIALS_FAST_PATH_SUBCOMMANDS.has(a);
  }
  return false;
}
