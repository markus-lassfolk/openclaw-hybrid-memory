import { resolveSecretRef } from "../../../config/parsers/core.js";
import {
  type EmbeddingConfig,
  GOOGLE_EMBED_DEFAULT_DIMENSIONS,
  GOOGLE_EMBED_DEFAULT_MODEL,
  OPENAI_ONLY_EMBED_MODELS,
  createEmbeddingProvider,
} from "../../../services/embeddings.js";
import { formatOpenAiEmbeddingDisplayLabel } from "../../../services/embeddings/shared.js";
import { capturePluginError } from "../../../services/error-reporter.js";

import type { VerifyRunState } from "../verify-run-state.js";
import {
  credentialSource,
  ensureRawPluginConfigOnState,
  rawDistillApiKey,
  rawEmbeddingApiKey,
  rawLlmProviderApiKey,
} from "../plugin-config-credentials.js";

export async function runVerifyEmbeddingsSection(state: VerifyRunState): Promise<void> {
  ensureRawPluginConfigOnState(state);
  const {
    ctx,
    opts,
    cfg,
    factsDb,
    vectorDb,
    embeddings,
    credentialsDb,
    resolvedSqlitePath,
    resolvedLancePath,
    openai,
    log,
    tableLog,
    OK,
    FAIL,
    PAUSE,
    WARN_LINE,
    noEmoji,
    issues,
    fixes,
    warnings,
    loadBlocking,
    extDir,
    defaultConfigPath,
    openclawDir,
    openclawConfigRead,
    recommendedEmbedding,
    dashboardUrl,
    rawPluginConfig,
  } = state;

  // ───── Embeddings Tests (Critical) ─────
  tableLog("\n───── Embeddings Tests (Critical) ─────");
  const hasOpenAiKey =
    typeof cfg.embedding.apiKey === "string" &&
    cfg.embedding.apiKey.length >= 10 &&
    cfg.embedding.apiKey !== "YOUR_OPENAI_API_KEY" &&
    cfg.embedding.apiKey !== "<OPENAI_API_KEY>";
  // Google key may be in embedding.googleApiKey (parsed from distill/llm) or only in raw config
  const cfgGoogleKey = (cfg.embedding as Record<string, unknown>).googleApiKey as string | undefined;
  const llmProviders = (rawPluginConfig?.llm as Record<string, unknown> | undefined)?.providers as
    | Record<string, unknown>
    | undefined;
  const rawGoogleKeyForHasKey =
    (rawPluginConfig?.distill as Record<string, unknown> | undefined)?.apiKey ??
    (llmProviders?.google as Record<string, unknown> | undefined)?.apiKey;
  const resolvedGoogleKeyForHasKey =
    typeof cfgGoogleKey === "string" && cfgGoogleKey.length >= 10
      ? cfgGoogleKey
      : typeof rawGoogleKeyForHasKey === "string" && rawGoogleKeyForHasKey.trim()
        ? resolveSecretRef(rawGoogleKeyForHasKey.trim())
        : undefined;
  const hasGoogleKey = Boolean(resolvedGoogleKeyForHasKey && resolvedGoogleKeyForHasKey.length >= 10);
  const embProvidersToShow: ("openai" | "ollama" | "onnx" | "google")[] =
    cfg.embedding.preferredProviders && cfg.embedding.preferredProviders.length > 0
      ? [...new Set(cfg.embedding.preferredProviders)]
      : [cfg.embedding.provider];
  const embTableRows: {
    label: string;
    oauth: boolean;
    api: string;
    source: string;
    success?: boolean;
    error?: string;
  }[] = [];
  for (const p of embProvidersToShow) {
    const oauth = false;
    const api =
      p === "openai" ? (hasOpenAiKey ? "True" : "False") : p === "google" ? (hasGoogleKey ? "True" : "False") : "Local";
    const source =
      p === "openai"
        ? hasOpenAiKey
          ? credentialSource(rawEmbeddingApiKey(state))
          : "—"
        : p === "google"
          ? hasGoogleKey
            ? (credentialSource(rawDistillApiKey(state)) !== "plugin"
                ? credentialSource(rawDistillApiKey(state))
                : credentialSource(rawLlmProviderApiKey(state, "google"))) || "plugin"
            : "—"
          : "local";
    // For Google with an OpenAI-only model name, show the effective model we use (gemini-embedding-001)
    const embModel =
      cfg.embedding.model ||
      (p === "openai"
        ? "text-embedding-3-small"
        : p === "google"
          ? "text-embedding-004"
          : p === "ollama"
            ? "nomic-embed-text"
            : "all-MiniLM-L6-v2");
    const effectiveGoogleModel =
      p === "google" && embModel && OPENAI_ONLY_EMBED_MODELS.has(embModel) ? GOOGLE_EMBED_DEFAULT_MODEL : embModel;
    // Detect Azure / APIM / Foundry so the label is (Azure)OpenAI/… not OpenAI/…
    const embeddingEndpoint =
      typeof (cfg.embedding as Record<string, unknown>).endpoint === "string"
        ? ((cfg.embedding as Record<string, unknown>).endpoint as string)
        : "";
    const label =
      p === "openai"
        ? formatOpenAiEmbeddingDisplayLabel(embModel, embeddingEndpoint || undefined)
        : p === "google"
          ? `Google/${effectiveGoogleModel}`
          : p === "ollama"
            ? `Local/Ollama (${embModel})`
            : `Local/ONNX (${embModel})`;
    let success: boolean | undefined;
    let embError: string | undefined;
    if (!opts.testLlm && (api === "True" || api === "Local")) {
      state.embeddingOk = true;
    }
    if (opts.testLlm) {
      try {
        // For Google with an OpenAI-only model name, use gemini-embedding-001 and 768 dims (same as factory)
        const modelForTest =
          p === "google" && embModel && OPENAI_ONLY_EMBED_MODELS.has(embModel)
            ? GOOGLE_EMBED_DEFAULT_MODEL
            : cfg.embedding.model ||
              (p === "openai"
                ? "text-embedding-3-small"
                : p === "google"
                  ? "text-embedding-004"
                  : p === "ollama"
                    ? "nomic-embed-text"
                    : "all-MiniLM-L6-v2");
        const dimensionsForTest =
          p === "google" && embModel && OPENAI_ONLY_EMBED_MODELS.has(embModel)
            ? GOOGLE_EMBED_DEFAULT_DIMENSIONS
            : cfg.embedding.dimensions;
        // Use resolved Google key (from cfg or raw distill/llm) so test works when key is only in raw config
        const minimalEmbCfg: EmbeddingConfig = {
          provider: p,
          model: modelForTest,
          dimensions: dimensionsForTest,
          batchSize: cfg.embedding.batchSize ?? 32,
          ...(typeof cfg.embedding.deployment === "string" && cfg.embedding.deployment.trim()
            ? { deployment: cfg.embedding.deployment.trim() }
            : {}),
          ...(cfg.embedding.models?.length ? { models: cfg.embedding.models } : {}),
          ...(p === "openai" && {
            apiKey: cfg.embedding.apiKey,
            ...(typeof cfg.embedding.endpoint === "string" && cfg.embedding.endpoint.trim()
              ? { endpoint: cfg.embedding.endpoint.trim() }
              : {}),
          }),
          ...(p === "google" && {
            googleApiKey:
              resolvedGoogleKeyForHasKey ?? ((cfg.embedding as Record<string, unknown>).googleApiKey as string),
          }),
          ...(p === "ollama" && { endpoint: cfg.embedding.endpoint }),
        };
        const singleEmb = createEmbeddingProvider(minimalEmbCfg);
        await singleEmb.embed("verify test");
        success = true;
      } catch (e) {
        capturePluginError(e as Error, { subsystem: "cli", operation: "runVerifyForCli:embedding-test", phase: p });
        success = false;
        embError = (e instanceof Error ? e.message : String(e)).slice(0, 120);
      }
      if (success) state.embeddingOk = true;
    }
    embTableRows.push({ label, oauth, api, source, success, error: embError });
  }
  const embCols = ["Model", "Credentials Available", "Source", ...(opts.testLlm ? ["Test Result"] : [])];
  const embW1 = Math.max(8, ...embTableRows.map((r) => r.label.length), 20);
  const embW2 = Math.max(20, 35);
  const embW3 = 8;
  const embW4 = opts.testLlm ? 12 : 0;
  tableLog(
    `  ${embCols[0].padEnd(embW1)}  ${embCols[1].padEnd(embW2)}  ${embCols[2].padEnd(embW3)}${opts.testLlm ? `  ${embCols[3]}` : ""}`,
  );
  tableLog(`  ${"-".repeat(embW1 + embW2 + embW3 + 4 + (opts.testLlm ? embW4 + 2 : 0))}`);
  for (const row of embTableRows) {
    const credStr = `OAuth:${row.oauth ? "True" : "False"} / API:${row.api}`;
    const line = `  ${row.label.padEnd(embW1)}  ${credStr.padEnd(embW2)}  ${row.source.padEnd(embW3)}${
      opts.testLlm ? `  ${row.success ? (noEmoji ? "Success" : "✅ Success") : noEmoji ? "Failed" : "❌ Failed"}` : ""
    }`;
    tableLog(line);
  }
  const failedEmbRows = opts.testLlm ? embTableRows.filter((r) => r.success === false && r.error) : [];
  if (failedEmbRows.length > 0) {
    tableLog("  Embedding test failures:");
    for (const row of failedEmbRows) {
      tableLog(`    ${row.label}: ${row.error}`);
    }
  }
  state.anyEmbOk = opts.testLlm
    ? embTableRows.some((r) => r.success)
    : embTableRows.some((r) => r.api === "True" || r.api === "Local");
  if (!state.anyEmbOk && opts.testLlm) {
    state.issues.push("No supported providers with Embedding support available");
    state.loadBlocking.push("No supported providers with Embedding support available");
    const WARN = noEmoji ? "[WARNING]" : "⚠️";
    log(`\n${WARN} No supported providers with Embedding support available. Plugin disabled.`);
    state.fixes.push(
      "Configure at least one embedding provider: embedding.apiKey (OpenAI), llm.providers.google.apiKey or distill.apiKey (Google), or use Local/Ollama or Local/ONNX. See docs/LLM-AND-PROVIDERS.md.",
    );
  }
  tableLog(
    state.anyEmbOk
      ? "  Embeddings: OK — at least one provider has credentials."
      : "  Embeddings: no working provider — see fixes below if listed.",
  );

  // ───── Embedding ↔ Lance alignment (dimensions) ─────
  tableLog("\n───── Embedding ↔ vector store (dimensions) ─────");
  if (!state.sqliteOk || !state.lanceOk || !vectorDb.isLanceDbAvailable()) {
    const WARN = noEmoji ? "[WARN]" : "⚠️";
    tableLog(
      `${WARN}  Skipped — SQLite and LanceDB must be healthy to compare embedding size vs index. Fix errors above, then re-run verify.`,
    );
  } else {
    try {
      await vectorDb.ensureInitialized();
      const providerDims = embeddings.dimensions;
      const lanceDims = vectorDb.getVectorDim();
      const configDims = cfg.embedding.dimensions;
      const schemaOk = vectorDb.isMemoriesVectorSchemaValid();
      tableLog(`  Active embedding provider: ${providerDims} dimensions (model: ${embeddings.modelName})`);
      tableLog(`  Config embedding.dimensions: ${configDims ?? "(default from model/catalog)"}`);
      tableLog(`  LanceDB (this process): expects ${lanceDims}-dim vectors`);
      if (configDims !== undefined && configDims !== providerDims) {
        const WARN = noEmoji ? "[WARN]" : "⚠️";
        tableLog(
          `${WARN}  Config embedding.dimensions (${configDims}) differs from runtime provider (${providerDims}) — runtime size is used for the index.`,
        );
      }
      if (!schemaOk) {
        state.embeddingAlignmentOk = false;
        log(
          `${FAIL} Lance memories table: schema not valid for vector search (missing vector column or on-disk dimension mismatch).`,
        );
        log(
          "  Fix: Set embedding.model / embedding.dimensions to match the table you need, enable vector.autoRepair=true to rebuild the empty table, or remove the LanceDB directory and restart. Then run: openclaw hybrid-mem re-index",
        );
        state.issues.push("LanceDB memories table schema invalid for vectors (dimension mismatch or missing column)");
        state.fixes.push(
          "Align embedding.model and embedding.dimensions with your Lance table, or delete the LanceDB data directory and re-index. See plugin config vector.autoRepair.",
        );
      } else {
        const probeText = "openclaw hybrid-mem verify dimension probe";
        const probeVec = await embeddings.embed(probeText);
        const probeLen = probeVec.length;
        tableLog(`  Probe embedding: API returned ${probeLen}-dim vector`);
        if (probeLen !== providerDims) {
          const WARN = noEmoji ? "[WARN]" : "⚠️";
          tableLog(
            `${WARN}  Provider reports ${providerDims} dimensions but probe returned ${probeLen} — using probe length as truth for this run.`,
          );
        }
        if (probeLen === lanceDims) {
          log(`${OK} Embedding ↔ Lance: OK (${probeLen} dimensions; index matches API output)`);
        } else {
          state.embeddingAlignmentOk = false;
          log(
            `${FAIL} Embedding ↔ Lance: MISMATCH — API returned ${probeLen} dimensions but LanceDB expects ${lanceDims}-dim vectors. Semantic search will return no results until fixed.`,
          );
          log(
            "  What to do: (1) Set embedding.model to the model you want as primary (same output size as your index).",
          );
          log("  (2) Set embedding.dimensions to that size if it differs from the catalog default.");
          log(
            `  (3) If you use a provider chain, set embedding.preferredProviders so only providers with the same vector size are listed (e.g. ["openai"] only).`,
          );
          log(
            "  (4) Run: openclaw hybrid-mem re-index — rebuilds vectors from SQLite with the current embedding config.",
          );
          state.issues.push(
            `Embedding dimension mismatch: API probe ${probeLen} vs Lance index ${lanceDims} (provider.dimensions=${providerDims})`,
          );
          state.fixes.push(
            'Match embedding model/dimensions to the LanceDB vector width, then run `openclaw hybrid-mem re-index`. Prefer embedding.preferredProviders: ["openai"] if a Google key accidentally forced a different chain size.',
          );
        }
      }
    } catch (e) {
      state.embeddingAlignmentOk = false;
      const msg = e instanceof Error ? e.message : String(e);
      log(`${FAIL} Embedding ↔ Lance: check failed — ${msg}`);
      state.issues.push(`Embedding alignment probe failed: ${msg}`);
      state.fixes.push(
        "Ensure embedding credentials and model are valid, then re-run verify. If you changed embedding settings, run `openclaw hybrid-mem re-index` after fixing config.",
      );
      capturePluginError(e instanceof Error ? e : new Error(String(e)), {
        subsystem: "cli",
        operation: "runVerifyForCli:embedding-alignment",
      });
    }
  }
}
