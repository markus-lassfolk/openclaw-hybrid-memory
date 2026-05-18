/** Exported for tests. Stops at `--` so `hybrid-mem store -- --help` is not treated as plugin-level help. */
export function isHybridMemHelpInvocation(argv: string[]): boolean {
  const hybridIdx = argv.indexOf("hybrid-mem");
  if (hybridIdx === -1) return false;
  for (let i = hybridIdx + 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") break;
    if (a === "--help" || a === "-h") return true;
  }
  return false;
