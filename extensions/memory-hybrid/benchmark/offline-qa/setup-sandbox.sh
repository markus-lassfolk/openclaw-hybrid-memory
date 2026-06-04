#!/usr/bin/env bash
# Lay out a fake HOME with ~/.openclaw/* pointing at fetched offline-qa raw data.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
QA_ROOT="$ROOT/.offline-qa"
RAW="$QA_ROOT/raw"
SANDBOX="$QA_ROOT/sandbox"
OC="$SANDBOX/.openclaw"

if [ ! -f "$QA_ROOT/manifest.json" ]; then
  echo "Missing $QA_ROOT/manifest.json — run fetch-maeve-offline-qa.sh first." >&2
  exit 1
fi

echo "==> Building sandbox HOME at $SANDBOX"
rm -rf "$SANDBOX"
mkdir -p "$OC/agents" "$OC/memory" "$OC/workspace/memory/reports" "$OC/logs"

# Sessions: all agents present in raw
if [ -d "$RAW/sessions" ]; then
  for agent_dir in "$RAW/sessions"/*/; do
    [ -d "$agent_dir" ] || continue
    agent=$(basename "$agent_dir")
    mkdir -p "$OC/agents/$agent/sessions"
    rsync -a "$agent_dir/" "$OC/agents/$agent/sessions/"
  done
fi

# Memory DB + lance + supporting DBs
cp -f "$RAW/memory/facts.db" "$OC/memory/facts.db"
if [ -d "$RAW/memory/lancedb" ]; then
  rsync -a "$RAW/memory/lancedb/" "$OC/memory/lancedb/"
fi
for f in "$RAW/memory"/*; do
  base=$(basename "$f")
  case "$base" in
    facts.db|lancedb) continue ;;
    credentials.db|memory.wal|*.bak*|facts-before-*) continue ;;
  esac
  cp -f "$f" "$OC/memory/$base" 2>/dev/null || true
done

# Sidecar dotfiles
for f in .discovered-categories.json .discovered-categories.last-run.json \
         .language-keywords.json .adaptive-llm-limits.json \
         .distill_last_run .reflect_last_run .compact_last_run; do
  [ -f "$RAW/memory/$f" ] && cp -f "$RAW/memory/$f" "$OC/memory/$f" || true
done

# Workspace identity files
for f in SOUL.md IDENTITY.md USER.md TOOLS.md AGENTS.md; do
  [ -f "$RAW/workspace/$f" ] && cp -f "$RAW/workspace/$f" "$OC/workspace/$f" || true
done

# Daily logs: workspace/memory + copy into memory/ for extract-daily CLI path
if [ -d "$RAW/workspace/memory" ]; then
  rsync -a "$RAW/workspace/memory/" "$OC/workspace/memory/"
  for log in "$RAW/workspace/memory"/20*.md; do
    [ -f "$log" ] || continue
    cp -f "$log" "$OC/memory/$(basename "$log")"
  done
fi

# Skills auto dir (generate-auto-skills writes here)
mkdir -p "$OC/workspace/skills/auto"

# openclaw.json — MiniMax-only maintenance LLM; Azure Foundry embeddings (Maeve live parity)
TIER_SNIPPET="$ROOT/benchmark/ab-maintenance/maeve-tier-snippet.json"
REDACTED_CFG="$RAW/config/openclaw.redacted.json"
MINIMAX_KEY="${MINIMAX_API_KEY:-}"
python3 - <<PY
import json, os

tier_path = "$TIER_SNIPPET"
redacted_path = "$REDACTED_CFG"
snippet = {}
if os.path.isfile(tier_path):
    with open(tier_path) as f:
        snippet = json.load(f)
snippet.pop("_comment", None)

def read_maeve_embedding():
    """Reuse Maeve live embedding model + Azure gateway URL from fetched redacted config."""
    embed = {"provider": "openai", "model": "text-embedding-3-large"}
    af_base = os.environ.get("AZURE_FOUNDRY_BASE_URL", "").strip()
    if not os.path.isfile(redacted_path):
        return embed, af_base
    red = json.load(open(redacted_path))
    mh = red.get("memoryHybrid") or {}
    if isinstance(mh, dict):
        mh_embed = mh.get("embedding") if isinstance(mh.get("embedding"), dict) else {}
        if mh_embed.get("provider") in ("openai", "ollama", "onnx", "google"):
            embed["provider"] = mh_embed["provider"]
        if isinstance(mh_embed.get("model"), str) and mh_embed["model"].strip():
            embed["model"] = mh_embed["model"].strip()
        if isinstance(mh_embed.get("deployment"), str) and mh_embed["deployment"].strip():
            embed["deployment"] = mh_embed["deployment"].strip()
        if isinstance(mh_embed.get("dimensions"), int):
            embed["dimensions"] = mh_embed["dimensions"]
    ms = ((red.get("agents") or {}).get("defaults") or {}).get("memorySearch") or {}
    if isinstance(ms.get("model"), str) and ms["model"].strip() and "model" not in embed:
        embed["model"] = ms["model"].strip()
    remote = ms.get("remote") if isinstance(ms.get("remote"), dict) else {}
    if not af_base:
        af_base = (remote.get("baseUrl") or remote.get("baseURL") or "").strip()
    gw = red.get("modelsProviders") or {}
    af_gw = gw.get("azure-foundry") if isinstance(gw, dict) else {}
    if isinstance(af_gw, dict):
        if not af_base:
            af_base = (af_gw.get("baseUrl") or af_gw.get("baseURL") or "").strip()
    llm_red = red.get("llm") or {}
    llm_prov = llm_red.get("providers") if isinstance(llm_red.get("providers"), dict) else {}
    af_llm = llm_prov.get("azure-foundry") if isinstance(llm_prov, dict) else {}
    if isinstance(af_llm, dict) and not af_base:
        af_base = (af_llm.get("baseUrl") or af_llm.get("baseURL") or "").strip()
    return embed, af_base

agent_defaults = dict(snippet.get("agents") or {})
agent_defaults.setdefault("defaults", {}).setdefault("models", {})
agent_defaults["defaults"]["models"].setdefault("minimax/MiniMax-M3", {"alias": "minimax-m3"})
agent_defaults["defaults"]["models"].setdefault("minimax/MiniMax-M2.7-highspeed", {"alias": "minimax-fast"})

mem = {k: v for k, v in snippet.items() if k not in ("llm", "agents")}
# Omit sqlitePath/lanceDbPath — defaults use homedir()/.openclaw/memory/* (correct when HOME=sandbox-work)
# Use enhanced mode so reflection/procedures/self-correction are enabled (local preset disables them).
mem["mode"] = "enhanced"
mem["credentials"] = {"enabled": False}
mem["personaProposals"] = {"enabled": True}
mem["wal"] = {"enabled": False}
mem["verification"] = {"enabled": False}
mem["nightlyCycle"] = {"enabled": False}
mem["reflection"] = {
    **(mem.get("reflection") or {}),
    "enabled": True,
    "defaultWindow": 14,
    "minObservations": 5,
}
mem["procedures"] = {"enabled": True, "requireApprovalForPromote": False}
mem["identityReflection"] = {"enabled": True}
mem["selfCorrection"] = {
    **(mem.get("selfCorrection") or {}),
    "enabled": True,
}
mem["implicitFeedback"] = {
    **(mem.get("implicitFeedback") or {}),
    "enabled": True,
}
mem["languageKeywords"] = {
    **(mem.get("languageKeywords") or {}),
    "autoBuild": True,
}
mem["distill"] = {
    **(mem.get("distill") or {}),
    "extractReinforcement": True,
    "extractDirectives": True,
}

minimax_key = os.environ.get("MINIMAX_API_KEY", "").strip()
maeve_embed, maeve_af_base = read_maeve_embedding()
if not maeve_af_base:
    maeve_af_base = os.environ.get("AZURE_OPENAI_BASE_URL", "https://rnd-api-gateway.azure-api.net/ai").strip()

llm = dict(snippet.get("llm") or {})
llm["maintenance"] = ["minimax/MiniMax-M3", "minimax/MiniMax-M2.7-highspeed"]
llm["heavy"] = ["minimax/MiniMax-M3"]
llm["default"] = ["minimax/MiniMax-M3"]
llm["nano"] = ["minimax/MiniMax-M2.7-highspeed"]
llm["maintenanceFallbackPolicy"] = "explicit-only"
# Block Azure/OpenAI for maintenance LLM tiers — embeddings use llm.providers.azure-foundry separately.
llm["disabledProviders"] = ["openai", "azure-foundry", "azure-foundry-responses", "google", "anthropic"]
providers = dict(llm.get("providers") or {})
if minimax_key:
    providers["minimax"] = {}
# Azure Foundry: same APIM gateway as Maeve live (keys via AZURE_OPENAI_API_KEY at runtime).
providers["azure-foundry"] = {
    "apiKey": "env:AZURE_OPENAI_API_KEY",
    "baseURL": maeve_af_base,
}
llm["providers"] = providers
mem["llm"] = llm

# No embedding.apiKey — parser inherits azure-foundry provider (see docs/LLM-AND-PROVIDERS.md).
mem["embedding"] = maeve_embed

oc = {
    "plugins": {
        "enabled": True,
        "bundledDiscovery": "compat",
        "allow": ["openclaw-hybrid-memory"],
        "load": {"paths": ["$ROOT"]},
        "slots": {"memory": "openclaw-hybrid-memory"},
        "entries": {
            "openclaw-hybrid-memory": {
                "enabled": True,
                "config": mem,
            }
        },
    },
    "agents": agent_defaults,
}
json.dump(oc, open("$OC/openclaw.json", "w"), indent=2)
PY

# Symlink local plugin into sandbox extensions dir (openclaw discovers plugins here)
mkdir -p "$OC/extensions"
ln -sfn "$ROOT" "$OC/extensions/openclaw-hybrid-memory"

# Cron logs
if [ -d "$RAW/logs/cron-hybrid-mem" ]; then
  mkdir -p "$OC/logs/cron-hybrid-mem"
  rsync -a "$RAW/logs/cron-hybrid-mem/" "$OC/logs/cron-hybrid-mem/" || true
fi

session_count=$(find "$OC/agents" -name '*.jsonl' 2>/dev/null | wc -l)
daily_in_memory=$(find "$OC/memory" -maxdepth 1 -name '20*.md' 2>/dev/null | wc -l)
echo "==> Sandbox template ready (read-only baseline — do not run live tests here)."
echo "    HOME=$SANDBOX"
echo "    Sessions: $session_count (agents: $(ls "$OC/agents" 2>/dev/null | tr '\n' ' '))"
echo "    Facts:    $OC/memory/facts.db"
echo "    Lance:    $([ -d "$OC/memory/lancedb" ] && echo yes || echo no)"
echo "    Daily logs in memory/: $daily_in_memory (for extract-daily)"
echo ""
echo "Clone for mutable test runs:"
echo "  npm run offline-qa:clone"
echo "Verify:  npm run offline-qa:verify -- --sandbox"
