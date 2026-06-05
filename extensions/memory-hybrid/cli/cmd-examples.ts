/**
 * CLI command showing common task examples
 */

import type { Chainable } from "./shared.js";

const EXAMPLE_CATEGORIES = {
  basics: {
    title: "Basic Operations",
    examples: [
      {
        name: "Store a fact",
        command: "openclaw hybrid-mem store 'Python is my favorite language'",
        description: "Add a new fact to memory",
      },
      {
        name: "Search memory",
        command: "openclaw hybrid-mem search 'programming languages'",
        description: "Find relevant facts using semantic search",
      },
      {
        name: "List recent facts",
        command: "openclaw hybrid-mem list --limit 10",
        description: "Show the 10 most recent facts",
      },
      {
        name: "View memory stats",
        command: "openclaw hybrid-mem storage stats",
        description: "See memory usage and statistics",
      },
    ],
  },
  setup: {
    title: "Setup & Configuration",
    examples: [
      {
        name: "Initial setup",
        command: "openclaw hybrid-mem setup --interactive",
        description: "Guided setup wizard for first-time configuration",
      },
      {
        name: "Check provider status",
        command: "openclaw hybrid-mem providers",
        description: "See which embedding providers are available",
      },
      {
        name: "Switch to Ollama",
        command: "openclaw hybrid-mem config-set embedding.provider ollama",
        description: "Use local Ollama for embeddings",
      },
      {
        name: "Verify installation",
        command: "openclaw hybrid-mem verify --fix",
        description: "Check system health and fix common issues",
      },
    ],
  },
  maintenance: {
    title: "Maintenance Tasks",
    examples: [
      {
        name: "Run all maintenance",
        command: "openclaw hybrid-mem maintenance run-all",
        description: "Execute all maintenance tasks in optimal order",
      },
      {
        name: "Backup memory",
        command: "openclaw hybrid-mem backup",
        description: "Create a backup of your memory databases",
      },
      {
        name: "Optimize database",
        command: "openclaw hybrid-mem storage optimize",
        description: "Compact LanceDB and reclaim disk space",
      },
      {
        name: "Health check",
        command: "openclaw hybrid-mem doctor",
        description: "Run diagnostics to detect issues",
      },
    ],
  },
  advanced: {
    title: "Advanced Operations",
    examples: [
      {
        name: "Extract from sessions",
        command: "openclaw hybrid-mem distill run --days 7 --model sonnet --dry-run",
        description: "Preview fact extraction from last 7 days",
      },
      {
        name: "Find duplicates",
        command: "openclaw hybrid-mem quality duplicates --threshold 0.85",
        description: "Detect near-duplicate facts",
      },
      {
        name: "Re-index vectors",
        command: "openclaw hybrid-mem storage re-index",
        description: "Rebuild vector database (after model change)",
      },
      {
        name: "Export memory",
        command: "openclaw hybrid-mem export --output ./memory-backup",
        description: "Export facts to Markdown files",
      },
    ],
  },
  troubleshooting: {
    title: "Troubleshooting",
    examples: [
      {
        name: "Run diagnostics",
        command: "openclaw hybrid-mem doctor",
        description: "Check for common issues",
      },
      {
        name: "Check sync status",
        command: "openclaw hybrid-mem verify --reconcile",
        description: "Verify SQLite and LanceDB are synchronized",
      },
      {
        name: "View configuration",
        command: "openclaw hybrid-mem config",
        description: "Show current configuration settings",
      },
      {
        name: "Test memory system",
        command: "openclaw hybrid-mem test",
        description: "Run memory diagnostics and tests",
      },
    ],
  },
};

export function registerExamplesCommand(program: Chainable): void {
  program
    .command("examples [category]")
    .description("Show common command examples (categories: basics, setup, maintenance, advanced, troubleshooting)")
    .action((category?: string) => {
      if (category && Object.hasOwn(EXAMPLE_CATEGORIES, category)) {
        // Show specific category
        const cat = EXAMPLE_CATEGORIES[category as keyof typeof EXAMPLE_CATEGORIES];
        console.log(`\n📚 ${cat.title}\n`);

        for (const example of cat.examples) {
          console.log(`${example.name}:`);
          console.log(`   ${example.description}`);
          console.log(`   $ ${example.command}\n`);
        }
      } else {
        // Show all categories
        console.log("\n📚 Hybrid Memory Command Examples\n");

        for (const [key, cat] of Object.entries(EXAMPLE_CATEGORIES)) {
          console.log(`${cat.title} (openclaw hybrid-mem examples ${key})`);
          console.log(`   ${cat.examples.length} examples available\n`);
        }

        console.log("Usage: openclaw hybrid-mem examples <category>\n");
      }
    });
}
