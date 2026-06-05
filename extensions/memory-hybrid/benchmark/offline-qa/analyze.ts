import type { QaTaskClassification, QaTaskSpec } from "./qa-tasks.js";

export type ParsedCounts = {
  sessionsScanned?: number;
  stored?: number;
  factsExtracted?: number;
  patternsStored?: number;
  rulesStored?: number;
  metaStored?: number;
  incidentsFound?: number;
  analysed?: number;
  created?: number;
  pruned?: number;
  languagesAdded?: number;
  signalsExtracted?: number;
  factsAnalyzed?: number;
};

export type TaskAnalysis = {
  classification: QaTaskClassification;
  exitCode: number;
  durationMs: number;
  counts: ParsedCounts;
  providerLeak: boolean;
  providerLeakDetail?: string;
  errors: string[];
  warnings: string[];
  usefulness: string;
  optimizations: string[];
  notes: string[];
};

const PROVIDER_LEAK_PATTERNS = [
  /azure-foundry/i,
  /\bgpt-[45]/i,
  /openai\/gpt/i,
  /anthropic\/claude/i,
  /google\/gemini/i,
  /fallback.*gpt/i,
  /routing to gateway.*azure/i,
];

const ERROR_PATTERNS = [
  /error:/i,
  /exit code [1-9]/i,
  /LLM request timeout/i,
  /UnconfiguredProviderError/i,
  /finishReason=length/i,
  /parse fail/i,
  /ECONNREFUSED/i,
];

function parseEmbedFailureCount(log: string): number {
  const m = log.match(/(\d+) embed failure\(s\)/i);
  return m ? Number.parseInt(m[1], 10) : 0;
}

export function parseCountsFromLog(log: string): ParsedCounts {
  const counts: ParsedCounts = {};
  const patterns: Array<[keyof ParsedCounts, RegExp]> = [
    ["sessionsScanned", /Sessions scanned:\s*(\d+)/i],
    ["sessionsScanned", /(\d+)\s+sessions?\s+scanned/i],
    ["stored", /stored[=:\s]+(\d+)/i],
    ["stored", /stored (\d+) (?:directives|rules|meta-patterns?|patterns?|facts?)\b/i],
    ["stored", /(?:extracted|finished:)\s*(\d+)\s+rule\(s\) stored/i],
    ["stored", /Reflection \(meta\) complete:.*stored (\d+)/i],
    ["stored", /Reflection complete:.*stored (\d+)/i],
    ["rulesStored", /(\d+) rule\(s\) stored/i],
    ["factsExtracted", /extract(?:ed)?[=:\s]+(\d+)/i],
    ["factsExtracted", /Would extract (\d+) facts/i],
    ["patternsStored", /patternsStored[=:\s]+(\d+)/i],
    ["patternsStored", /(\d+)\s+patterns?\s+stored/i],
    ["rulesStored", /rulesStored[=:\s]+(\d+)/i],
    ["rulesStored", /(\d+)\s+rules?\s+stored/i],
    ["metaStored", /metaStored[=:\s]+(\d+)/i],
    ["incidentsFound", /incidentsFound[=:\s]+(\d+)/i],
    ["analysed", /analysed[=:\s]+(\d+)/i],
    ["created", /created[=:\s]+(\d+)/i],
    ["pruned", /[Pp]runed (\d+)/],
    ["languagesAdded", /languagesAdded[=:\s]+(\d+)/i],
    ["languagesAdded", /(\d+)\s+languages?\s+added/i],
    ["signalsExtracted", /signalsExtracted[=:\s]+(\d+)/i],
    ["factsAnalyzed", /analyzed (\d+) facts/i],
    ["factsAnalyzed", /factsAnalyzed[=:\s]+(\d+)/i],
  ];
  for (const [key, re] of patterns) {
    const m = log.match(re);
    if (m) counts[key] = Number.parseInt(m[1], 10);
  }
  return counts;
}

export function detectProviderLeak(log: string, llmTask: boolean): { leak: boolean; detail?: string } {
  if (!llmTask) return { leak: false };
  // Config/help lines listing disabled providers are not runtime routing.
  const runtimeLog = log
    .split("\n")
    .filter(
      (line) =>
        !/disabledProviders|config-set|Example \(/.test(line) &&
        !/distill store failed for.*azure-foundry/i.test(line) &&
        !/using llm\.providers\["azure-foundry"\] for embeddings/i.test(line) &&
        !(
          /azure-foundry/i.test(line) &&
          /embed|embedding|Embedding provider|reflection-rules-embed|loadReflectionDedupeCorpusVectors/i.test(line)
        ) &&
        !/embedding\.endpoint|test-embeddings|Embedding provider/i.test(line),
    )
    .join("\n");
  for (const re of PROVIDER_LEAK_PATTERNS) {
    const m = runtimeLog.match(re);
    if (m) return { leak: true, detail: m[0] };
  }
  if (llmTask && !/minimax/i.test(runtimeLog) && /chat\.completions|starting with model|model tier/i.test(runtimeLog)) {
    return { leak: true, detail: "LLM task log lacks minimax model reference" };
  }
  return { leak: false };
}

export function analyzeTaskResult(task: QaTaskSpec, log: string, exitCode: number, durationMs: number): TaskAnalysis {
  const counts = parseCountsFromLog(log);
  const errors: string[] = [];
  const warnings: string[] = [];
  const optimizations: string[] = [];
  const notes: string[] = [];

  if (exitCode !== 0) errors.push(`Process exit code ${exitCode}`);
  if (/error: unknown option/i.test(log)) errors.push("Unknown CLI option — fix qa-tasks args");
  for (const re of ERROR_PATTERNS) {
    if (re.test(log)) warnings.push(`Log matches error pattern: ${re.source}`);
  }
  if (/401 Access denied/i.test(log)) {
    if (/embedding|distill store failed/i.test(log)) {
      warnings.push("Embedding API 401 — vector-dependent steps may be degraded");
    } else {
      warnings.push("Log matches error pattern: 401 Access denied");
    }
  }

  const { leak, detail } = detectProviderLeak(log, !!task.llmTask);
  if (leak) errors.push(`Provider leak: ${detail ?? "non-MiniMax provider detected"}`);

  if (/skipped/i.test(log)) notes.push("Task reported skip");
  if (/timeout after/i.test(log)) {
    errors.push("Timeout");
    optimizations.push("Increase OPENCLAW_HYBRID_MEM_MAINTENANCE_TIMEOUT_MS for full phase");
  }
  if (/finishReason=length/i.test(log)) {
    optimizations.push("Output truncated — increase max tokens or reduce batch size");
  }
  if (/401 Access denied.*embedding/i.test(log) || /distill store failed.*401 Access denied/i.test(log)) {
    warnings.push("Embedding API 401 — vector-dependent steps may be degraded");
  }

  let classification: QaTaskClassification = "ok";
  const embeddingDegraded = /401 Access denied|401 status code|distill store failed|embed failure/i.test(log);
  const distillLlmOk = /(\d+) extracted from (\d+) sessions/i.test(log);
  const distillExtracted = Number.parseInt(log.match(/(\d+) extracted from (\d+) sessions/i)?.[1] ?? "0", 10);

  if (/unknown command|not a command|Cannot find/i.test(log) && task.skipIfCommandMissing) {
    classification = "skipped";
    errors.length = 0;
    notes.push("CLI subcommand not registered — expected skip");
  } else if (exitCode !== 0 || errors.length > 0) {
    if (task.id === "distill" && embeddingDegraded && distillLlmOk) {
      classification = /timeout after/i.test(log) ? "needs-fix" : "data-gap";
      if (classification === "data-gap") {
        errors.length = 0;
        errors.push("Distill LLM succeeded but embedding store failed — check AZURE_OPENAI_API_KEY / secrets.env");
      }
    } else {
      classification = "needs-fix";
    }
  } else if (task.id === "distill" && embeddingDegraded && distillExtracted > 0 && (counts.stored ?? 0) === 0) {
    classification = "needs-fix";
    errors.push("Distill extracted facts but stored 0 — embedding auth or store path failure");
  } else if (task.id === "distill" && embeddingDegraded && distillLlmOk && (counts.stored ?? 0) === 0) {
    classification = "needs-fix";
    errors.push("Distill LLM succeeded; sqlite store blocked by embedding failure");
  } else if (task.id === "extract-daily" && /401|vector store failed/i.test(log) && (counts.factsExtracted ?? 0) > 0) {
    classification = "needs-fix";
    errors.push("Daily facts extracted but vector store failed");
  } else if (task.id === "reflect-meta" && parseEmbedFailureCount(log) > 0 && (counts.stored ?? 0) === 0) {
    classification = "needs-fix";
    errors.push("Meta-patterns parsed but embedding failures prevented storage");
  } else if (task.id === "reflect" && (counts.stored ?? 0) > 0) {
    classification = "ok";
    notes.push(`Stored ${counts.stored} reflection patterns`);
  } else if (
    task.id === "distill" &&
    (counts.sessionsScanned ?? 0) === 0 &&
    !/\d+ extracted from \d+ sessions/i.test(log)
  ) {
    classification = "test-bug";
    errors.push("Distill scanned 0 sessions — sandbox HOME or session paths wrong");
  } else if (
    task.id === "extract-daily" &&
    !/20\d{2}-\d{2}-\d{2}\.md/.test(log) &&
    (counts.stored ?? 0) === 0 &&
    (counts.factsExtracted ?? 0) === 0
  ) {
    classification = "data-gap";
    notes.push("No daily log activity — check memory/YYYY-MM-DD.md copies");
  } else if (task.id === "extract-reinforcement") {
    const incidentsFound = Number.parseInt(log.match(/reinforcement incidents found:\s*(\d+)/i)?.[1] ?? "0", 10);
    const annotated = Number.parseInt(log.match(/Annotated (\d+) facts/i)?.[1] ?? "0", 10);
    if (incidentsFound > 0) {
      classification = annotated > 0 ? "ok" : "by-design-zero";
      notes.push(
        annotated > 0
          ? `${annotated} fact(s) annotated from ${incidentsFound} incident(s)`
          : `${incidentsFound} incident(s) found; 0 annotated (noRecalledIds — expected without memory_recall in sessions)`,
      );
    } else if ((counts.sessionsScanned ?? 0) === 0) {
      classification = "data-gap";
      notes.push("RE=0 in corpus — known Maeve data gap");
    }
  } else if (task.id === "reflect" && (counts.factsAnalyzed ?? 0) === 0 && (counts.stored ?? 0) === 0) {
    if (/analyzed 0 facts, extracted 0/i.test(log) && !/facts in window/i.test(log)) {
      classification = "needs-fix";
      errors.push("Reflection disabled or misconfigured — sandbox should use mode=enhanced with reflection.enabled");
    } else {
      classification = "data-gap";
      notes.push("0 facts in reflection window — check fact timestamps vs window");
    }
  } else if (task.id === "generate-proposals" && /semantic_empty_with_gaps=true/i.test(log)) {
    classification = "needs-fix";
    notes.push("semantic_empty despite identity gaps — check proposal pipeline wiring");
  } else if (task.id === "generate-proposals") {
    const gapMatch = log.match(/identity_gap_score=([0-9.]+)/i);
    const gapScore = gapMatch ? Number.parseFloat(gapMatch[1]) : 0;
    if (/semantic_empty/i.test(log) && gapScore >= 0.25) {
      classification = "needs-fix";
      notes.push(`semantic_empty with identity_gap_score=${gapScore.toFixed(2)} — proposals pipeline gap`);
    } else if (/semantic_empty|parse_success=false created=0/i.test(log) || (counts.created ?? 0) === 0) {
      classification = "by-design-zero";
      errors.length = 0;
      notes.push("Zero proposals — model parse empty or no patterns meeting confidence gate");
    }
  } else if (task.id === "reflect-rules" || task.id === "reflect-meta") {
    const storedN = counts.rulesStored ?? counts.metaStored ?? counts.stored ?? 0;
    if (storedN === 0) {
      if (/invalid_response_format|zero_rules_reason=invalid/i.test(log)) {
        const minimalRetryOk = /minimal JSON retry succeeded/i.test(log);
        classification =
          exitCode === 0 && !minimalRetryOk ? "needs-fix" : exitCode === 0 ? "by-design-zero" : "needs-fix";
        notes.push(
          minimalRetryOk
            ? "Rules recovered via minimal JSON retry"
            : "LLM returned unparseable rules format — retry or model swap (known MiniMax flake)",
        );
      } else {
        classification = exitCode === 0 ? "by-design-zero" : "needs-fix";
        notes.push(task.runAllGate ?? "Pattern gate may block output");
      }
    } else {
      classification = "ok";
    }
  } else if (task.id === "build-languages" && /skip/i.test(log)) {
    classification = "by-design-zero";
    notes.push(task.runAllGate ?? "Keywords file recently updated");
  } else if (
    ["extract-directives", "extract-implicit", "self-correction-run", "generate-proposals"].includes(task.id) &&
    Object.values(counts).every((v) => v === undefined || v === 0)
  ) {
    classification = "by-design-zero";
    notes.push("Zero output — may be expected for this corpus window");
  }

  const usefulness =
    classification === "skipped"
      ? "Command not registered — skip on live unless wired"
      : classification === "ok"
        ? "Task completed with expected signal"
        : classification === "by-design-zero"
          ? "Zero output likely by design — verify gate/data expectations"
          : classification === "data-gap"
            ? "Tooling ran but corpus lacks signal — not a code bug"
            : classification === "needs-fix"
              ? "Fix errors before live deploy"
              : "Investigate harness or plugin";

  return {
    classification,
    exitCode,
    durationMs,
    counts,
    providerLeak: leak,
    providerLeakDetail: detail,
    errors,
    warnings,
    usefulness,
    optimizations,
    notes,
  };
}

export function renderTaskAnalysisMarkdown(task: QaTaskSpec, analysis: TaskAnalysis): string {
  return [
    `### ${task.id}`,
    "",
    `- **Classification:** ${analysis.classification}`,
    `- **Exit:** ${analysis.exitCode} | **Duration:** ${(analysis.durationMs / 1000).toFixed(1)}s`,
    `- **Usefulness:** ${analysis.usefulness}`,
    analysis.errors.length ? `- **Errors:** ${analysis.errors.join("; ")}` : null,
    analysis.warnings.length ? `- **Warnings:** ${analysis.warnings.join("; ")}` : null,
    analysis.notes.length ? `- **Notes:** ${analysis.notes.join("; ")}` : null,
    analysis.optimizations.length ? `- **Optimizations:** ${analysis.optimizations.join("; ")}` : null,
    `- **Counts:** \`${JSON.stringify(analysis.counts)}\``,
    "",
  ]
    .filter(Boolean)
    .join("\n");
}
