/**
 * GeneratedSkillLifecycleService — owns all lifecycle-policy decisions for
 * generated/promoted skills (Issue #1409).
 *
 * This service is the high-level façade for generated-skill lifecycle operations.
 * The backing module (`backends/facts-db/generated-skills.ts`) still owns the
 * concrete SQLite mutations and compatibility policy hooks used by existing DB
 * methods; callers should prefer this service when they need policy-scoped
 * telemetry recording, refreshes, reports, or disk reconciliation.
 *
 * Multiple instances with different policies can coexist (e.g. a "strict" policy
 * for production skills, a "permissive" policy for sandbox environments, or custom
 * policies in tests).
 */

import type { DatabaseSync } from "node:sqlite";
import type {
	GeneratedSkillLifecycleState,
	ProcedureEntry,
} from "../types/memory.js";
import type { GeneratedSkillTelemetryEntry } from "../types/memory.js";
import {
	type GeneratedSkillDoctorReport,
	type GeneratedSkillLifecyclePolicy,
	type GeneratedSkillTelemetryRecordInput,
	type GeneratedSkillTelemetryReport,
	DEFAULT_GENERATED_SKILL_LIFECYCLE_POLICY,
	buildGeneratedSkillTelemetryReport,
	getGeneratedSkillByName,
	listGeneratedSkillTelemetry,
	markGeneratedSkillTelemetryFalsePositive,
	reconcileGeneratedSkillDiskState,
	recordGeneratedSkillTelemetry,
	refreshGeneratedSkillLifecycleState,
	setGeneratedSkillLifecycleState,
} from "../backends/facts-db/generated-skills.js";

export type { GeneratedSkillLifecyclePolicy };

export class GeneratedSkillLifecycleService {
	private readonly policy: GeneratedSkillLifecyclePolicy;

	constructor(
		private readonly db: DatabaseSync,
		policy?: Partial<GeneratedSkillLifecyclePolicy>,
	) {
		this.policy = {
			...DEFAULT_GENERATED_SKILL_LIFECYCLE_POLICY,
			...(policy ?? {}),
		};
	}

	// ---------------------------------------------------------------------------
	// Telemetry recording
	// ---------------------------------------------------------------------------

	/**
	 * Record an activation / near-miss for a generated skill and automatically
	 * evaluate the lifecycle policy to determine if a state transition is needed.
	 */
	recordTelemetry(
		input: GeneratedSkillTelemetryRecordInput,
	): GeneratedSkillTelemetryEntry {
		return recordGeneratedSkillTelemetry(this.db, input, this.policy);
	}

	/**
	 * Mark a previously recorded activation as a false-positive and re-evaluate
	 * the lifecycle policy.
	 */
	markFalsePositive(
		activationId: string,
		correctionReason: string,
	): GeneratedSkillTelemetryEntry | null {
		return markGeneratedSkillTelemetryFalsePositive(
			this.db,
			activationId,
			correctionReason,
			this.policy,
		);
	}

	/**
	 * List recent telemetry entries for a skill (or all skills).
	 */
	listTelemetry(
		skillName?: string,
		limit = 50,
	): GeneratedSkillTelemetryEntry[] {
		return listGeneratedSkillTelemetry(this.db, skillName, limit);
	}

	// ---------------------------------------------------------------------------
	// State management
	// ---------------------------------------------------------------------------

	/**
	 * Explicitly set the lifecycle state of a skill (operator-driven).
	 * Use `reset()` for the common demoted → experimental case.
	 */
	setState(
		skillName: string,
		state: GeneratedSkillLifecycleState,
		reason: string | null,
		at?: number,
	): ProcedureEntry | null {
		return setGeneratedSkillLifecycleState(
			this.db,
			skillName,
			state,
			reason,
			at,
		);
	}

	/**
	 * Re-evaluate the lifecycle policy for a skill and apply any pending transition.
	 */
	refresh(skillName: string, now?: number): ProcedureEntry | null {
		return refreshGeneratedSkillLifecycleState(
			this.db,
			skillName,
			this.policy,
			now,
		);
	}

	/**
	 * Retrieve the current skill record by name.
	 */
	getSkill(skillName: string): ProcedureEntry | null {
		return getGeneratedSkillByName(this.db, skillName);
	}

	// ---------------------------------------------------------------------------
	// Reporting
	// ---------------------------------------------------------------------------

	/**
	 * Build a full telemetry report (uses the service's policy for thresholds).
	 */
	buildReport(options?: {
		skillName?: string;
		recentActivationLimit?: number;
		now?: number;
	}): GeneratedSkillTelemetryReport {
		return buildGeneratedSkillTelemetryReport(this.db, {
			...options,
			policy: this.policy,
		});
	}

	// ---------------------------------------------------------------------------
	// Disk reconciliation (#1391)
	// ---------------------------------------------------------------------------

	/**
	 * Scan for promoted skill DB rows whose SKILL.md no longer exists on disk.
	 * When `fix` is true, transitions missing rows to the `uninstalled` state.
	 */
	reconcileDiskState(opts?: {
		workspaceRoot?: string;
		fix?: boolean;
		now?: number;
	}): GeneratedSkillDoctorReport {
		return reconcileGeneratedSkillDiskState(this.db, opts);
	}
}
