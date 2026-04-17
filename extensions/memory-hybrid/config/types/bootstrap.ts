/** Ordered startup phases used by internal bootstrap and registration manifests. */
export const BOOTSTRAP_PHASES = ["core", "optional"] as const;

/** `core` must succeed before any `optional` subsystem is installed. */
export type BootstrapPhase = (typeof BOOTSTRAP_PHASES)[number];

/** Shared manifest metadata for phased bootstrap and tool installers. */
export type BootstrapPhaseConfig = {
	bootstrapPhase: BootstrapPhase;
};
