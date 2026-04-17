/**
 * Read `hybrid-mem -v/--verbose` from the parent Commander command chain.
 */

/** Minimal Commander command shape for reading inherited opts (hybrid-mem --verbose). */
export type CommanderOptsParent = {
	opts: () => { verbose?: boolean };
	parent?: CommanderOptsParent | null;
};

export function readHybridMemVerbose(
	cmd: CommanderOptsParent | undefined,
): boolean {
	let c: CommanderOptsParent | undefined = cmd;
	while (c) {
		const o = c.opts() as { verbose?: boolean };
		if (o.verbose) return true;
		c = c.parent ?? undefined;
	}
	return false;
}
