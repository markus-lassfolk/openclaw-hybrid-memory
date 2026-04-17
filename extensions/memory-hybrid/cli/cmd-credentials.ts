/**
 * Credentials CLI Handlers
 *
 * Implements the vault-related CLI commands:
 *   - migrate-to-vault   — migrate plain-text credential facts into the encrypted vault
 *   - credentials audit  — flag suspicious or duplicate vault entries
 *   - credentials list   — list vault metadata without decryption
 *   - credentials get    — retrieve a single vault entry by service
 *   - credentials prune  — remove flagged entries (dry-run by default)
 */

import { dirname, join } from "node:path";

import type { CredentialType } from "../config.js";
import {
	CREDENTIAL_REDACTION_MIGRATION_FLAG,
	migrateCredentialsToVault,
} from "../services/credential-migration.js";
import {
	auditCredentialValue,
	auditServiceName,
	normalizeServiceForDedup,
} from "../services/credential-validation.js";
import { capturePluginError } from "../services/error-reporter.js";
import type { HandlerContext } from "./handlers.js";
import type {
	CredentialsAuditResult,
	CredentialsPruneResult,
	MigrateToVaultResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// migrate-to-vault
// ---------------------------------------------------------------------------

/**
 * Migrate plain-text credential facts into the encrypted vault.
 * Returns null when the credentials vault is disabled.
 */
export async function runMigrateToVaultForCli(
	ctx: HandlerContext,
): Promise<MigrateToVaultResult | null> {
	const {
		factsDb,
		vectorDb,
		embeddings,
		credentialsDb,
		aliasDb,
		resolvedSqlitePath,
	} = ctx;
	if (!credentialsDb) return null;
	const migrationFlagPath = join(
		dirname(resolvedSqlitePath),
		CREDENTIAL_REDACTION_MIGRATION_FLAG,
	);
	try {
		return await migrateCredentialsToVault({
			factsDb,
			vectorDb,
			embeddings,
			credentialsDb,
			aliasDb,
			migrationFlagPath,
			markDone: true,
		});
	} catch (err) {
		capturePluginError(err as Error, {
			subsystem: "cli",
			operation: "runMigrateToVaultForCli",
		});
		throw err;
	}
}

// ---------------------------------------------------------------------------
// credentials audit
// ---------------------------------------------------------------------------

/**
 * Audit credentials vault: list entries and flag suspicious ones (value/service heuristics).
 */
export function runCredentialsAuditForCli(
	ctx: HandlerContext,
): CredentialsAuditResult {
	const { credentialsDb } = ctx;
	const entries: Array<{
		service: string;
		type: string;
		url: string | null;
		flags: string[];
	}> = [];
	if (!credentialsDb) return { entries, total: 0 };
	const list = credentialsDb.listAll();
	// Group entries by canonical value and by normalized service name so we can flag
	// older duplicates in each group. Each item carries its `updated` timestamp so we
	// can sort newest-first and keep only group[0] (the newest) un-flagged.
	const valueToEntries = new Map<
		string,
		Array<{ service: string; type: string; updated: number }>
	>();
	const normKeyToEntries = new Map<
		string,
		Array<{ service: string; type: string; updated: number }>
	>();
	for (const row of list) {
		const value = row.value;
		const updated = row.updated;
		const flags = [
			...auditCredentialValue(value, row.type),
			...auditServiceName(row.service),
		];
		const normKey = `${normalizeServiceForDedup(row.service)}:${row.type}`;
		if (!valueToEntries.has(value)) valueToEntries.set(value, []);
		valueToEntries
			.get(value)
			?.push({ service: row.service, type: row.type, updated });
		if (!normKeyToEntries.has(normKey)) normKeyToEntries.set(normKey, []);
		normKeyToEntries
			.get(normKey)
			?.push({ service: row.service, type: row.type, updated });
		entries.push({ service: row.service, type: row.type, url: row.url, flags });
	}
	for (const [, group] of valueToEntries) {
		if (group.length > 1) {
			// Sort newest-first so that group[0] is the most recently updated entry.
			// Only the older copies (i >= 1) are flagged, preserving the newest credential.
			const sorted = [...group].sort((a, b) => b.updated - a.updated);
			for (let i = 1; i < sorted.length; i++) {
				const { service, type } = sorted[i];
				const e = entries.find((x) => x.service === service && x.type === type);
				if (e && !e.flags.includes("duplicate_value"))
					e.flags.push("duplicate_value");
			}
		}
	}
	for (const [, group] of normKeyToEntries) {
		if (group.length > 1) {
			// Sort newest-first; only flag the older normalized-service duplicates (i >= 1).
			const sorted = [...group].sort((a, b) => b.updated - a.updated);
			for (let i = 1; i < sorted.length; i++) {
				const { service, type } = sorted[i];
				const e = entries.find((x) => x.service === service && x.type === type);
				if (e && !e.flags.includes("duplicate_normalized_service"))
					e.flags.push("duplicate_normalized_service");
			}
		}
	}
	return { entries, total: entries.length };
}

// ---------------------------------------------------------------------------
// credentials list
// ---------------------------------------------------------------------------

/**
 * List credentials metadata (service, type, url) without decryption.
 * Used by the `credentials list` CLI command.
 */
export function runCredentialsListForCli(
	ctx: HandlerContext,
): Array<{ service: string; type: string; url: string | null }> {
	const { credentialsDb } = ctx;
	if (!credentialsDb) return [];
	return credentialsDb.list();
}

// ---------------------------------------------------------------------------
// credentials get
// ---------------------------------------------------------------------------

/**
 * Get a single credential value by service (and optional type). Used by the `credentials get` CLI command.
 * Returns null if vault is disabled or no matching entry exists.
 */
export function runCredentialsGetForCli(
	ctx: HandlerContext,
	opts: { service: string; type?: string },
): {
	service: string;
	type: string;
	value: string;
	url: string | null;
	notes: string | null;
} | null {
	const { credentialsDb } = ctx;
	if (!credentialsDb) return null;
	const type = opts.type as CredentialType | undefined;
	const entry = credentialsDb.get(opts.service.trim(), type);
	if (!entry) return null;
	return {
		service: entry.service,
		type: entry.type,
		value: entry.value,
		url: entry.url ?? null,
		notes: entry.notes ?? null,
	};
}

// ---------------------------------------------------------------------------
// credentials prune
// ---------------------------------------------------------------------------

/**
 * Prune credentials vault: remove entries flagged by audit. Default dry-run; use --yes to apply.
 */
export function runCredentialsPruneForCli(
	ctx: HandlerContext,
	opts: { dryRun: boolean; yes?: boolean; onlyFlags?: string[] },
): CredentialsPruneResult {
	const { credentialsDb } = ctx;
	const removed: Array<{ service: string; type: string }> = [];
	const apply = opts.yes === true && !opts.dryRun;
	if (!credentialsDb) return { removed: 0, entries: [], dryRun: !apply };
	const audit = runCredentialsAuditForCli(ctx);
	const flagsToPrune =
		opts.onlyFlags && opts.onlyFlags.length > 0
			? new Set(opts.onlyFlags)
			: null;
	for (const e of audit.entries) {
		if (e.flags.length === 0) continue;
		const match = !flagsToPrune || e.flags.some((f) => flagsToPrune.has(f));
		if (!match) continue;
		if (apply) {
			credentialsDb.delete(e.service, e.type as CredentialType);
			removed.push({ service: e.service, type: e.type });
		} else {
			removed.push({ service: e.service, type: e.type });
		}
	}
	return { removed: removed.length, entries: removed, dryRun: !apply };
}
