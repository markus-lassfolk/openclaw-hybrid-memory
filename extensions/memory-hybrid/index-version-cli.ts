/**
 * Root `--version` fast path for `hybrid-mem` (issue #2012).
 *
 * Matches only when `--version` is a leading flag directly after `hybrid-mem`, before any
 * subcommand token. This keeps `--version` out of the full Commander tree entirely, so it can
 * never shadow an identically-named option on a subcommand (e.g. `upgrade --json`, `list --json`)
 * the way a root-registered `--version`/`--json` option would (PR #2013 review). When a subcommand
 * is selected first (e.g. `hybrid-mem upgrade --version`), this returns false and the flag is left
 * for that subcommand's own parser to accept or reject.
 */
export function isHybridMemVersionOnlyInvocation(argv: string[]): boolean {
  const hybridIdx = argv.indexOf("hybrid-mem");
  if (hybridIdx === -1) return false;

  let sawVersion = false;
  for (let i = hybridIdx + 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") break;
    if (a === "--version") {
      sawVersion = true;
      continue;
    }
    if (a.startsWith("-")) continue;
    // First non-flag token is a subcommand/positional — stop scanning.
    break;
  }
  return sawVersion;
}
