/**
 * CLI command for interactive demo and onboarding
 */

import type { Command } from "commander";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { Embeddings } from "../services/embeddings.js";
import { ProgressSpinner, statusMessage } from "../utils/progress-indicators.js";

export function registerDemoCommand(
	program: Command,
	factsDb: FactsDB,
	vectorDb: VectorDB,
	embeddings: Embeddings,
): void {
	program
		.command("demo")
		.description(
			"Interactive demo showing memory capabilities with sample data",
		)
		.action(async () => {
			console.log("\n🎯 OpenClaw Hybrid Memory Demo\n");
			console.log(
				"This demo will show you how the hybrid memory system works.\n",
			);

			const demoFacts = [
				{
					text: "TypeScript is a statically typed superset of JavaScript that compiles to plain JavaScript",
					category: "technology",
				},
				{
					text: "React is a popular JavaScript library for building user interfaces",
					category: "technology",
				},
				{
					text: "Node.js is a JavaScript runtime built on Chrome's V8 engine",
					category: "technology",
				},
				{
					text: "Python is known for its simple syntax and is popular in data science and machine learning",
					category: "technology",
				},
				{
					text: "Git is a distributed version control system for tracking changes in source code",
					category: "tools",
				},
			];

			// Step 1: Store sample facts
			console.log("Step 1: Storing sample facts...\n");
			const spinner = new ProgressSpinner("Storing facts");
			spinner.start();

			const storedIds: string[] = [];
			try {
				for (const fact of demoFacts) {
					const embedding = await embeddings.embed(fact.text);
					const result = await factsDb.store({
						text: fact.text,
						category: fact.category,
						confidence: 0.9,
						embedding,
						tier: "hot",
						sourceDate: Date.now(),
					});
					storedIds.push(result.id);
				}
				spinner.success(`Stored ${demoFacts.length} sample facts`);
			} catch (error) {
				spinner.fail("Failed to store facts");
				console.error(error);
				return;
			}

			// Step 2: Demonstrate semantic search
			console.log("\nStep 2: Semantic Search Demo\n");
			console.log("Query: 'How do I build web applications?'\n");

			const searchSpinner = new ProgressSpinner("Searching memory");
			searchSpinner.start();

			try {
				const queryEmbedding = await embeddings.embed(
					"How do I build web applications?",
				);
				const results = await vectorDb.search(queryEmbedding, 3);

				searchSpinner.success("Found relevant memories");
				console.log("\nTop 3 Results:\n");

				for (let i = 0; i < results.length; i++) {
					const fact = factsDb.getById(results[i].id);
					if (fact) {
						console.log(
							`${i + 1}. [Similarity: ${(results[i].score * 100).toFixed(1)}%]`,
						);
						console.log(`   ${fact.text}`);
						console.log();
					}
				}
			} catch (error) {
				searchSpinner.fail("Search failed");
				console.error(error);
			}

			// Step 3: Show full-text search
			console.log("Step 3: Full-Text Search Demo\n");
			console.log("Query: 'javascript'\n");

			try {
				const ftsResults = factsDb.searchFts("javascript", { limit: 3 });
				console.log(`Found ${ftsResults.length} matches:\n`);

				for (let i = 0; i < ftsResults.length; i++) {
					console.log(`${i + 1}. ${ftsResults[i].text}`);
					console.log();
				}
			} catch (error) {
				console.error("FTS search failed:", error);
			}

			// Step 4: Show categories
			console.log("Step 4: Categories\n");
			const categories = factsDb.getCategories();
			console.log(`Categories in demo: ${categories.join(", ")}\n`);

			// Step 5: Cleanup offer
			console.log("Demo Complete! 🎉\n");
			console.log("What you learned:");
			console.log("✓ How to store facts in memory");
			console.log("✓ Semantic search finds conceptually similar content");
			console.log("✓ Full-text search finds exact keyword matches");
			console.log("✓ Facts are organized into categories\n");

			console.log("Next Steps:");
			console.log(
				"• Store your own fact: openclaw hybrid-mem store 'your fact here'",
			);
			console.log(
				"• Search your memory: openclaw hybrid-mem search 'your query'",
			);
			console.log("• View all facts: openclaw hybrid-mem list");
			console.log(
				"• Learn more commands: openclaw hybrid-mem examples\n",
			);

			// Ask to cleanup
			console.log(
				"💡 Demo facts are still in your memory. To remove them, run:",
			);
			console.log(
				`   openclaw hybrid-mem delete ${storedIds.slice(0, 3).join(" ")} ...\n`,
			);
		});
}
