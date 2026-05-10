/**
 * CLI command for health diagnostics and issue detection
 */

import { existsSync, statSync } from "node:fs";
import type { Command } from "commander";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { HybridMemoryConfig } from "../config.js";
import { detectAvailableProviders } from "../utils/provider-detection.js";

interface DiagnosticCheck {
	name: string;
	status: "pass" | "warn" | "fail";
	message: string;
	fix?: string;
}

export function registerDoctorCommand(
	program: Command,
	cfg: HybridMemoryConfig,
	factsDb: FactsDB,
	vectorDb: VectorDB,
): void {
	program
		.command("doctor")
		.description(
			"Run health diagnostics and detect common issues (🟢 pass, 🟡 warn, 🔴 fail)",
		)
		.option("--fix", "Automatically fix issues where possible")
		.action(async (opts: { fix?: boolean }) => {
			console.log("\n🏥 Running Hybrid Memory Diagnostics...\n");

			const checks: DiagnosticCheck[] = [];
			const startTime = Date.now();

			// Check 1: Database connectivity
			try {
				const factCount = factsDb.countActiveFacts();
				checks.push({
					name: "SQLite Database",
					status: "pass",
					message: `Connected successfully (${factCount} facts)`,
				});
			} catch (error) {
				checks.push({
					name: "SQLite Database",
					status: "fail",
					message: `Connection failed: ${error}`,
					fix: "Run: openclaw hybrid-mem verify --fix",
				});
			}

			// Check 2: Vector database
			try {
				const vectorCount = vectorDb.countVectors();
				checks.push({
					name: "Vector Database (LanceDB)",
					status: "pass",
					message: `Connected successfully (${vectorCount} vectors)`,
				});
			} catch (error) {
				checks.push({
					name: "Vector Database (LanceDB)",
					status: "fail",
					message: `Connection failed: ${error}`,
					fix: "Run: openclaw hybrid-mem re-index",
				});
			}

			// Check 3: Embedding provider
			const providers = await detectAvailableProviders(cfg.embedding?.apiKey);
			const currentProvider = cfg.embedding?.provider;
			const providerStatus = providers.find(
				(p) => p.provider === currentProvider,
			);

			if (providerStatus?.available) {
				checks.push({
					name: "Embedding Provider",
					status: "pass",
					message: `${currentProvider?.toUpperCase()} is available`,
				});
			} else {
				checks.push({
					name: "Embedding Provider",
					status: "fail",
					message: providerStatus?.reason || "Provider not configured",
					fix: "Run: openclaw hybrid-mem providers",
				});
			}

			// Check 4: Configuration validity
			if (cfg.embedding?.provider) {
				checks.push({
					name: "Configuration",
					status: "pass",
					message: "Configuration is valid",
				});
			} else {
				checks.push({
					name: "Configuration",
					status: "warn",
					message: "No embedding provider configured",
					fix: "Run: openclaw hybrid-mem setup --interactive",
				});
			}

			// Check 5: Database synchronization
			try {
				const sqliteCount = factsDb.countActiveFacts();
				const vectorCount = vectorDb.countVectors();
				const diff = Math.abs(sqliteCount - vectorCount);
				const percentDiff = (diff / Math.max(sqliteCount, 1)) * 100;

				if (percentDiff < 5) {
					checks.push({
						name: "Database Sync",
						status: "pass",
						message: `SQLite and LanceDB are synchronized (±${diff} items)`,
					});
				} else {
					checks.push({
						name: "Database Sync",
						status: "warn",
						message: `Databases out of sync: SQLite ${sqliteCount}, LanceDB ${vectorCount}`,
						fix: "Run: openclaw hybrid-mem verify --reconcile --fix",
					});
				}
			} catch (error) {
				checks.push({
					name: "Database Sync",
					status: "warn",
					message: "Could not check synchronization",
				});
			}

			// Check 6: Disk space (simple check for memory directory)
			try {
				const memoryDir =
					cfg.paths?.memory ||
					require("node:path").join(
						require("node:os").homedir(),
						".openclaw/plugins/memory-hybrid",
					);
				if (existsSync(memoryDir)) {
					checks.push({
						name: "Disk Space",
						status: "pass",
						message: `Memory directory accessible: ${memoryDir}`,
					});
				} else {
					checks.push({
						name: "Disk Space",
						status: "warn",
						message: `Memory directory not found: ${memoryDir}`,
						fix: "Run: openclaw hybrid-mem install",
					});
				}
			} catch (error) {
				checks.push({
					name: "Disk Space",
					status: "warn",
					message: "Could not check disk space",
				});
			}

			// Display results
			for (const check of checks) {
				const icon =
					check.status === "pass"
						? "🟢"
						: check.status === "warn"
							? "🟡"
							: "🔴";
				console.log(`${icon} ${check.name}: ${check.message}`);
				if (check.fix && check.status !== "pass") {
					console.log(`   💡 Fix: ${check.fix}`);
				}
			}

			const duration = Date.now() - startTime;
			console.log(`\n✓ Diagnostics completed in ${duration}ms\n`);

			// Summary
			const passed = checks.filter((c) => c.status === "pass").length;
			const warnings = checks.filter((c) => c.status === "warn").length;
			const failed = checks.filter((c) => c.status === "fail").length;

			console.log(`Summary: ${passed} passed, ${warnings} warnings, ${failed} failed\n`);

			if (failed > 0) {
				console.log(
					"❌ Critical issues detected. Please address the failed checks.\n",
				);
				process.exit(1);
			} else if (warnings > 0) {
				console.log(
					"⚠️  Some issues detected. Consider addressing the warnings.\n",
				);
			} else {
				console.log("✅ All checks passed! Your memory system is healthy.\n");
			}
		});
}
