/**
 * CLI command for interactive demo and onboarding
 */

import type { Command } from "commander";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import { statusMessage } from "../utils/progress-indicators.js";

export function registerDemoCommand(
	program: Command,
	factsDb: FactsDB,
	vectorDb: VectorDB,
	embeddings: EmbeddingProvider,
): void {
	program
		.command("demo")
		.description(
			"Interactive demo showing memory capabilities (read-only overview)",
		)
		.action(async () => {
			console.log("\n🎯 OpenClaw Hybrid Memory Demo\n");
			console.log(
				"This demo explains how the hybrid memory system works.\n",
			);

			// Show current stats
			console.log("📊 Current Memory Status:\n");
			try {
				const factCount = factsDb.countFacts();
				const vectorIds = await vectorDb.getAllIds();
				const vectorCount = vectorIds.length;

				console.log(`  • Facts in SQLite: ${factCount}`);
				console.log(`  • Vectors in LanceDB: ${vectorCount}`);
				console.log(`  • Embedding provider: ${embeddings.provider || "configured"}\n`);
			} catch (error) {
				console.log("  ⚠️  Could not retrieve stats\n");
			}

			// Explain the system
			console.log("🔍 How Hybrid Memory Works:\n");
			console.log("1. Two-Tier Storage:");
			console.log("   • SQLite + FTS5: Fast exact keyword search, zero API cost");
			console.log("   • LanceDB: Semantic search that understands meaning\n");

			console.log("2. When You Store a Fact:");
			console.log("   • Text is saved in SQLite for fast retrieval");
			console.log("   • An embedding vector is generated and stored in LanceDB");
			console.log("   • Both can be searched independently or together\n");

			console.log("3. Search Modes:");
			console.log("   • Full-text search: Finds exact keyword matches");
			console.log("   • Semantic search: Finds conceptually similar content");
			console.log("   • Hybrid: Combines both and deduplicates results\n");

			console.log("📚 Example Use Cases:\n");
			console.log("✓ Store your preferences: 'I prefer TypeScript for large projects'");
			console.log("✓ Save code snippets: 'To format dates, use Intl.DateTimeFormat'");
			console.log("✓ Remember APIs: 'GitHub API rate limit is 5000 req/hour'");
			console.log("✓ Track learnings: 'React hooks can't be called conditionally'\n");

			console.log("🚀 Try It Yourself:\n");
			console.log("# Store your first memory");
			console.log("$ openclaw hybrid-mem store 'Python is great for data science'\n");

			console.log("# Search semantically");
			console.log("$ openclaw hybrid-mem search 'machine learning tools'\n");

			console.log("# List recent memories");
			console.log("$ openclaw hybrid-mem list --limit 10\n");

			console.log("# View all stats");
			console.log("$ openclaw hybrid-mem stats\n");

			console.log("💡 Next Steps:");
			console.log("• Learn more: openclaw hybrid-mem examples basics");
			console.log("• Quick setup: openclaw hybrid-mem setup --interactive");
			console.log("• Health check: openclaw hybrid-mem health\n");

			statusMessage("success", "Demo complete! Ready to start using hybrid memory.");
		});
}
