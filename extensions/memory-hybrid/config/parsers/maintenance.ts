import type {
	CouncilConfig,
	CouncilProvenanceMode,
	CronReliabilityConfig,
	HealthConfig,
	MaintenanceConfig,
	MonthlyReviewConfig,
	NightlyCycleConfig,
	ProvenanceConfig,
	VerificationConfig,
} from "../types/maintenance.js";

export function parseVerificationConfig(
	cfg: Record<string, unknown>,
): VerificationConfig {
	const verifRaw = cfg.verification as Record<string, unknown> | undefined;
	return {
		enabled: verifRaw?.enabled === true,
		backupPath:
			typeof verifRaw?.backupPath === "string" &&
			verifRaw.backupPath.trim().length > 0
				? verifRaw.backupPath.trim()
				: "~/.openclaw/verified-facts.json",
		reverificationDays:
			typeof verifRaw?.reverificationDays === "number" &&
			verifRaw.reverificationDays > 0
				? Math.floor(verifRaw.reverificationDays)
				: 30,
		autoClassify: verifRaw?.autoClassify !== false,
		continuousVerification: verifRaw?.continuousVerification === true,
		cycleDays:
			typeof verifRaw?.cycleDays === "number" && verifRaw.cycleDays > 0
				? Math.floor(verifRaw.cycleDays)
				: 30,
		verificationModel:
			typeof verifRaw?.verificationModel === "string" &&
			verifRaw.verificationModel.trim().length > 0
				? verifRaw.verificationModel.trim()
				: undefined,
	};
}

export function parseProvenanceConfig(
	cfg: Record<string, unknown>,
): ProvenanceConfig {
	const provRaw = cfg.provenance as Record<string, unknown> | undefined;
	return {
		enabled: provRaw?.enabled === true,
		retentionDays:
			typeof provRaw?.retentionDays === "number" && provRaw.retentionDays > 0
				? Math.floor(provRaw.retentionDays)
				: 365,
	};
}

export function parseNightlyCycleConfig(
	cfg: Record<string, unknown>,
): NightlyCycleConfig {
	const nightlyCycleRaw = cfg.nightlyCycle as
		| Record<string, unknown>
		| undefined;
	return {
		enabled: nightlyCycleRaw?.enabled === true,
		schedule:
			typeof nightlyCycleRaw?.schedule === "string" &&
			nightlyCycleRaw.schedule.trim().length > 0
				? nightlyCycleRaw.schedule.trim()
				: "45 2 * * *",
		reflectWindowDays:
			typeof nightlyCycleRaw?.reflectWindowDays === "number" &&
			nightlyCycleRaw.reflectWindowDays >= 1
				? Math.min(90, Math.floor(nightlyCycleRaw.reflectWindowDays))
				: 7,
		pruneMode:
			nightlyCycleRaw?.pruneMode === "expired" ||
			nightlyCycleRaw?.pruneMode === "decay" ||
			nightlyCycleRaw?.pruneMode === "both"
				? (nightlyCycleRaw.pruneMode as "expired" | "decay" | "both")
				: "both",
		model:
			typeof nightlyCycleRaw?.model === "string" &&
			nightlyCycleRaw.model.trim().length > 0
				? nightlyCycleRaw.model.trim()
				: undefined,
		consolidateAfterDays:
			typeof nightlyCycleRaw?.consolidateAfterDays === "number" &&
			nightlyCycleRaw.consolidateAfterDays >= 1
				? Math.min(365, Math.floor(nightlyCycleRaw.consolidateAfterDays))
				: 7,
		maxUnconsolidatedAgeDays:
			typeof nightlyCycleRaw?.maxUnconsolidatedAgeDays === "number" &&
			nightlyCycleRaw.maxUnconsolidatedAgeDays >= 1
				? Math.min(3650, Math.floor(nightlyCycleRaw.maxUnconsolidatedAgeDays))
				: 90,
		logRetentionDays:
			typeof nightlyCycleRaw?.logRetentionDays === "number" &&
			nightlyCycleRaw.logRetentionDays >= 0
				? Math.min(3650, Math.floor(nightlyCycleRaw.logRetentionDays))
				: 30,
		vacuumOnCycle: nightlyCycleRaw?.vacuumOnCycle !== false,
		eventLogArchivalDays:
			typeof nightlyCycleRaw?.eventLogArchivalDays === "number" &&
			nightlyCycleRaw.eventLogArchivalDays >= 0
				? Math.floor(nightlyCycleRaw.eventLogArchivalDays)
				: undefined,
		eventLogArchivePath:
			typeof nightlyCycleRaw?.eventLogArchivePath === "string" &&
			nightlyCycleRaw.eventLogArchivePath.trim().length > 0
				? nightlyCycleRaw.eventLogArchivePath.trim()
				: undefined,
	};
}

export function parseHealthConfig(cfg: Record<string, unknown>): HealthConfig {
	const healthRaw = cfg.health as Record<string, unknown> | undefined;
	return {
		enabled: healthRaw?.enabled !== false,
		authenticated: healthRaw?.authenticated !== false,
	};
}

function parseCouncilConfig(cfg: Record<string, unknown>): CouncilConfig {
	const councilRaw = (cfg.maintenance as Record<string, unknown> | undefined)
		?.council as Record<string, unknown> | undefined;
	const validModes: CouncilProvenanceMode[] = [
		"meta+receipt",
		"meta",
		"receipt",
		"none",
	];
	const provenance: CouncilProvenanceMode =
		typeof councilRaw?.provenance === "string" &&
		validModes.includes(councilRaw.provenance as CouncilProvenanceMode)
			? (councilRaw.provenance as CouncilProvenanceMode)
			: "meta+receipt";
	const sessionKeyPrefix =
		typeof councilRaw?.sessionKeyPrefix === "string" &&
		councilRaw.sessionKeyPrefix.trim().length > 0
			? councilRaw.sessionKeyPrefix.trim()
			: "council-review";
	return { provenance, sessionKeyPrefix };
}

function parseCronReliabilityConfig(
	cfg: Record<string, unknown>,
): CronReliabilityConfig {
	const maintenanceRaw = cfg.maintenance as Record<string, unknown> | undefined;
	const reliabilityRaw = maintenanceRaw?.cronReliability as
		| Record<string, unknown>
		| undefined;
	return {
		nightlyCron:
			typeof reliabilityRaw?.nightlyCron === "string" &&
			reliabilityRaw.nightlyCron.trim().length > 0
				? reliabilityRaw.nightlyCron.trim()
				: "0 3 * * *",
		weeklyBackupCron:
			typeof reliabilityRaw?.weeklyBackupCron === "string" &&
			reliabilityRaw.weeklyBackupCron.trim().length > 0
				? reliabilityRaw.weeklyBackupCron.trim()
				: "0 4 * * 0",
		verifyOnBoot: reliabilityRaw?.verifyOnBoot !== false,
		staleThresholdHours:
			typeof reliabilityRaw?.staleThresholdHours === "number" &&
			reliabilityRaw.staleThresholdHours > 0
				? Math.floor(reliabilityRaw.staleThresholdHours)
				: 28,
	};
}

export function parseMaintenanceConfig(
	cfg: Record<string, unknown>,
): MaintenanceConfig {
	const maintenanceRaw = cfg.maintenance as Record<string, unknown> | undefined;
	const monthlyReviewRaw = maintenanceRaw?.monthlyReview as
		| Record<string, unknown>
		| undefined;
	const monthlyReview: MonthlyReviewConfig = {
		enabled: monthlyReviewRaw?.enabled === true,
		model:
			typeof monthlyReviewRaw?.model === "string" &&
			monthlyReviewRaw.model.trim().length > 0
				? monthlyReviewRaw.model.trim()
				: undefined,
		dayOfMonth:
			typeof monthlyReviewRaw?.dayOfMonth === "number" &&
			Number.isFinite(monthlyReviewRaw.dayOfMonth)
				? Math.min(31, Math.max(1, Math.floor(monthlyReviewRaw.dayOfMonth)))
				: 1,
	};
	return {
		monthlyReview,
		cronReliability: parseCronReliabilityConfig(cfg),
		council: parseCouncilConfig(cfg),
	};
}
