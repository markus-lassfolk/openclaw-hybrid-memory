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

# openclaw.json — MiniMax-only QA config (no Maeve agent roster / absolute paths)
TIER_SNIPPET="$ROOT/benchmark/ab-maintenance/maeve-tier-snippet.json"
MINIMAX_KEY="${MINIMAX_API_KEY:-}"
python3 - <<PY
import json, os

tier_path = "$TIER_SNIPPET"
snippet = {}
if os.path.isfile(tier_path):
    with open(tier_path) as f:
        snippet = json.load(f)
snippet.pop("_comment", None)

agent_defaults = dict(snippet.get("agents") or {})
agent_defaults.setdefault("defaults", {}).setdefault("models", {})
agent_defaults["defaults"]["models"].setdefault("minimax/MiniMax-M3", {"alias": "minimax-m3"})
agent_defaults["defaults"]["models"].setdefault("minimax/MiniMax-M2.7-highspeed", {"alias": "minimax-fast"})

mem = {k: v for k, v in snippet.items() if k not in ("llm", "agents")}
# Omit sqlitePath/lanceDbPath — defaults use homedir()/.openclaw/memory/* (correct when HOME=sandbox-work)
mem["credentials"] = {"enabled": False}
mem["personaProposals"] = {"enabled": True}
mem["wal"] = {"enabled": False}
mem["verification"] = {"enabled": False}
mem["nightlyCycle"] = {"enabled": False}

minimax_key = os.environ.get("MINIMAX_API_KEY", "").strip()

llm = dict(snippet.get("llm") or {})
llm["maintenance"] = ["minimax/MiniMax-M3", "minimax/MiniMax-M2.7-highspeed"]
llm["heavy"] = ["minimax/MiniMax-M3"]
llm["default"] = ["minimax/MiniMax-M3"]
llm["nano"] = ["minimax/MiniMax-M2.7-highspeed"]
llm["maintenanceFallbackPolicy"] = "explicit-only"
llm["disabledProviders"] = ["openai", "azure-foundry", "azure-foundry-responses", "google", "anthropic"]
# API keys supplied via MINIMAX_API_KEY / OPENAI_API_KEY at runtime — not written to disk
providers = dict(llm.get("providers") or {})
if minimax_key:
    providers["minimax"] = {}
llm["providers"] = providers
mem["llm"] = llm

mem["embedding"] = {
    "provider": "openai",
    "model": "text-embedding-3-small",
    "apiKey": "env:OPENAI_API_KEY",
}

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
