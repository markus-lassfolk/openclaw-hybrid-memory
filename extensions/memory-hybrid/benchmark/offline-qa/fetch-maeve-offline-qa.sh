#!/usr/bin/env bash
# Copy real Maeve data for local offline QA (gitignored .offline-qa/).
# Does NOT sync credentials, vault, WAL, or API keys.
#
# Modes:
#   OFFLINE_QA_FULL=1   — copy everything needed for run-all parity (default)
#   OFFLINE_QA_FULL=0   — lite: facts + 3 agents + sidecars only
#
# Other env:
#   OFFLINE_QA_FACTS=full|sample
#   OFFLINE_QA_LANCE=1|0  (default 1 when FULL=1)
#   OFFLINE_QA_SESSION_DAYS=45
#   OFFLINE_QA_SESSION_CAP=400  (per agent; ignored when OFFLINE_QA_AGENTS=all)
#   OFFLINE_QA_AGENTS=all|main,scholar,...  (default: all agents with recent sessions)
set -euo pipefail

MAEVE="${MAEVE_SSH:-markus@192.168.1.224}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
QA_ROOT="$ROOT/.offline-qa"
RAW="$QA_ROOT/raw"
SESSIONS="$RAW/sessions"
MEMORY="$RAW/memory"
WORKSPACE="$RAW/workspace"
CONFIG="$RAW/config"
LOGS="$RAW/logs"
FULL="${OFFLINE_QA_FULL:-1}"
DAYS="${OFFLINE_QA_SESSION_DAYS:-45}"
CAP="${OFFLINE_QA_SESSION_CAP:-400}"
FACTS_MODE="${OFFLINE_QA_FACTS:-full}"
LANCE="${OFFLINE_QA_LANCE:-$([ "$FULL" = "1" ] && echo 1 || echo 0)}"
CRON_LOGS="${OFFLINE_QA_CRON_LOGS:-1}"
AGENTS="${OFFLINE_QA_AGENTS:-all}"
DAILY_LOG_DAYS="${OFFLINE_QA_DAILY_LOG_DAYS:-14}"

mkdir -p "$SESSIONS" "$MEMORY" "$WORKSPACE/memory" "$CONFIG" "$LOGS"

echo "==> Offline QA fetch (FULL=$FULL FACTS=$FACTS_MODE LANCE=$LANCE AGENTS=$AGENTS)"

# --- Sessions ---
echo "==> [1/7] Session JSONL (last ${DAYS}d)..."
if [ "$AGENTS" = "all" ]; then
  mapfile -t AGENT_LIST < <(
    ssh -o BatchMode=yes "$MAEVE" "
      for d in \"\$HOME/.openclaw/agents\"/*/; do
        [ -d \"\${d}sessions\" ] || continue
        n=\$(find \"\${d}sessions\" -maxdepth 1 -type f -name '*.jsonl' -mtime -${DAYS} 2>/dev/null | wc -l)
        [ \"\$n\" -gt 0 ] && basename \"\$d\"
      done
    "
  )
else
  IFS=',' read -ra AGENT_LIST <<< "$AGENTS"
fi

total_session_files=0
for agent in "${AGENT_LIST[@]}"; do
  [ -n "$agent" ] || continue
  dest="$SESSIONS/$agent"
  mkdir -p "$dest"
  mapfile -t files < <(
    ssh -o BatchMode=yes "$MAEVE" "
      find \"\$HOME/.openclaw/agents/$agent/sessions\" -maxdepth 1 -type f -name '*.jsonl' \\
        ! -name '*.trajectory.jsonl' \\
        ! -name '*.codex-app-server.json' \\
        ! -name '*.deleted*' \\
        ! -name '*.checkpoint*' \\
        ! -name '*.tmp' \\
        -mtime -${DAYS} -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -${CAP} | cut -d' ' -f2-
    "
  )
  for remote in "${files[@]}"; do
    [ -n "$remote" ] || continue
    rsync -az "$MAEVE:$remote" "$dest/$(basename "$remote")"
  done
  echo "    $agent: ${#files[@]} files"
  total_session_files=$((total_session_files + ${#files[@]}))
done

# --- Facts DB ---
echo "==> [2/7] Facts DB (${FACTS_MODE})..."
if [ "$FACTS_MODE" = "sample" ]; then
  remote_tmp=$(ssh -o BatchMode=yes "$MAEVE" 'python3 - <<'"'"'PY'"'"'
import os, shutil, sqlite3, tempfile
src = os.path.expanduser("~/.openclaw/memory/facts.db")
fd, tmp = tempfile.mkstemp(suffix=".db", dir=os.path.expanduser("~/.openclaw/memory"))
os.close(fd)
shutil.copy2(src, tmp)
con = sqlite3.connect(tmp)
con.execute("""
  CREATE TABLE facts_keep AS
  SELECT id FROM facts
  WHERE superseded_at IS NULL
  ORDER BY created_at DESC LIMIT 5000
""")
for tbl in ("fact_tags", "fact_links"):
    try:
        con.execute(f"DELETE FROM {tbl} WHERE fact_id NOT IN (SELECT id FROM facts_keep)")
    except sqlite3.OperationalError:
        pass
con.execute("DELETE FROM facts WHERE id NOT IN (SELECT id FROM facts_keep)")
con.execute("DROP TABLE facts_keep")
con.execute("VACUUM")
con.commit()
con.close()
print(tmp)
PY')
  rsync -az "$MAEVE:$remote_tmp" "$MEMORY/facts.db"
  ssh -o BatchMode=yes "$MAEVE" "rm -f '$remote_tmp'"
else
  ssh -o BatchMode=yes "$MAEVE" \
    "sqlite3 \"\$HOME/.openclaw/memory/facts.db\" \".backup '\$HOME/.openclaw/memory/.offline-qa-facts-backup.db'\""
  rsync -az "$MAEVE:~/.openclaw/memory/.offline-qa-facts-backup.db" "$MEMORY/facts.db"
  ssh -o BatchMode=yes "$MAEVE" "rm -f ~/.openclaw/memory/.offline-qa-facts-backup.db"
fi

# --- Supporting memory DBs (full QA) ---
echo "==> [3/7] Supporting memory DBs + sidecars..."
SIDEcars=(
  .language-keywords.json
  .adaptive-llm-limits.json
  .distill_last_run
  .reflect_last_run
  .compact_last_run
  .discovered-categories.last-run.json
  .discovered-categories.json
)
for f in "${SIDEcars[@]}"; do
  rsync -az "$MAEVE:~/.openclaw/memory/$f" "$MEMORY/$f" 2>/dev/null || true
done

if [ "$FULL" = "1" ]; then
  for db in proposals.db identity-reflections.db persona-state.db edicts.db provenance.db narratives.db; do
    rsync -az "$MAEVE:~/.openclaw/memory/$db" "$MEMORY/$db" 2>/dev/null || true
  done
fi

# --- Lance ---
if [ "$LANCE" = "1" ]; then
  echo "==> [4/7] Lance vectors..."
  mkdir -p "$MEMORY/lancedb"
  rsync -az "$MAEVE:~/.openclaw/memory/lancedb/" "$MEMORY/lancedb/" || echo "    (lancedb rsync failed — OK)"
else
  echo "==> [4/7] Lance vectors skipped (OFFLINE_QA_LANCE=1 for full vector QA)"
fi

# --- Workspace identity + daily logs ---
echo "==> [5/7] Workspace identity + daily logs..."
for f in SOUL.md IDENTITY.md USER.md TOOLS.md AGENTS.md; do
  rsync -az "$MAEVE:~/.openclaw/workspace/$f" "$WORKSPACE/$f" 2>/dev/null || true
done
mkdir -p "$WORKSPACE/memory"
ssh -o BatchMode=yes "$MAEVE" "
  find \"\$HOME/.openclaw/workspace/memory\" -maxdepth 1 -type f -name '20*.md' -mtime -${DAILY_LOG_DAYS} 2>/dev/null
" | while read -r remote; do
  [ -n "$remote" ] || continue
  rsync -az "$MAEVE:$remote" "$WORKSPACE/memory/$(basename "$remote")"
done
daily_count=$(find "$WORKSPACE/memory" -name '20*.md' 2>/dev/null | wc -l)
echo "    daily logs: $daily_count files (last ${DAILY_LOG_DAYS}d)"

# Also copy self-correction report samples (read-only context)
if [ "$FULL" = "1" ]; then
  mkdir -p "$WORKSPACE/memory/reports"
  ssh -o BatchMode=yes "$MAEVE" "
    find \"\$HOME/.openclaw/workspace/memory/reports\" -maxdepth 1 -type f -name 'self-correction-*.md' -mtime -30 2>/dev/null | head -5
  " | while read -r remote; do
    [ -n "$remote" ] || continue
    rsync -az "$MAEVE:$remote" "$WORKSPACE/memory/reports/$(basename "$remote")" 2>/dev/null || true
  done
fi

# --- Redacted config + facts sample ---
echo "==> [6/7] Redacted config + facts sample..."
ssh -o BatchMode=yes "$MAEVE" 'python3 - <<'"'"'PY'"'"'
import json, os

def redact(obj):
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            lk = k.lower()
            if any(x in lk for x in ("apikey", "api_key", "token", "secret", "password", "credential")):
                out[k] = "REDACTED" if v else v
            else:
                out[k] = redact(v)
        return out
    if isinstance(obj, list):
        return [redact(x) for x in obj]
    return obj

home = os.path.expanduser("~")
oc = os.path.join(home, ".openclaw", "openclaw.json")
cfg = json.load(open(oc)) if os.path.isfile(oc) else {}
plugins = cfg.get("plugins") or {}
entries = plugins.get("entries") if isinstance(plugins.get("entries"), dict) else {}
mem_key = next((k for k in entries if "hybrid" in k.lower() and "memory" in k.lower()), None)
if mem_key:
    entry = entries.get(mem_key) or {}
    mem_cfg = redact(entry.get("config") if isinstance(entry, dict) else entry)
else:
    mem_key = next((k for k in plugins if isinstance(k, str) and "hybrid" in k.lower() and "memory" in k.lower()), None)
    mem_cfg = redact(plugins.get(mem_key, {})) if mem_key else {}
gw_providers = {}
models = cfg.get("models") or {}
if isinstance(models, dict) and isinstance(models.get("providers"), dict):
    gw_providers = redact(models["providers"])
print(json.dumps({
    "openclawPath": oc,
    "pluginId": mem_key,
    "memoryHybrid": mem_cfg,
    "modelsProviders": gw_providers,
    "llm": redact(cfg.get("llm") or {}),
    "agents": redact(cfg.get("agents") or {}),
}, indent=2))
PY' > "$CONFIG/openclaw.redacted.json"

ssh -o BatchMode=yes "$MAEVE" 'python3 - <<'"'"'PY'"'"'
import json, sqlite3, os
db = os.path.expanduser("~/.openclaw/memory/facts.db")
con = sqlite3.connect(db)
con.row_factory = sqlite3.Row
facts = [dict(r) for r in con.execute("""
  SELECT id, text, category, entity, key, importance, created_at
  FROM facts WHERE superseded_at IS NULL AND length(trim(text)) >= 20
  ORDER BY created_at DESC LIMIT 120
""")]
clusters = []
rows = con.execute("""
  SELECT f1.id id1, f1.text t1, f1.category c1,
         f2.id id2, f2.text t2, f2.category c2
  FROM facts f1 JOIN facts f2 ON f1.id < f2.id
  WHERE f1.superseded_at IS NULL AND f2.superseded_at IS NULL
    AND length(f1.text) > 30 AND length(f2.text) > 30
  LIMIT 12
""").fetchall()
for r in rows:
    clusters.append([
        {"id": r["id1"], "text": r["t1"], "category": r["c1"]},
        {"id": r["id2"], "text": r["t2"], "category": r["c2"]},
    ])
print(json.dumps({"facts": facts, "consolidationClusters": clusters[:6]}, indent=2))
PY' > "$RAW/facts-sample.json"

# --- Cron logs ---
if [ "$CRON_LOGS" = "1" ]; then
  echo "==> [7/7] Recent maintenance cron logs..."
  mkdir -p "$LOGS/cron-hybrid-mem"
  mapfile -t logfiles < <(
    ssh -o BatchMode=yes "$MAEVE" "
      find \"\$HOME/.openclaw/logs/cron-hybrid-mem\" -type f -mtime -14 2>/dev/null | head -20
    " || true
  )
  for remote in "${logfiles[@]}"; do
    [ -n "$remote" ] || continue
    rsync -az "$MAEVE:$remote" "$LOGS/cron-hybrid-mem/$(basename "$remote")" || true
  done
  echo "    copied ${#logfiles[@]} log files"
else
  echo "==> [7/7] Cron logs skipped"
fi

facts_bytes=$(stat -c%s "$MEMORY/facts.db" 2>/dev/null || stat -f%z "$MEMORY/facts.db")
lance_bytes=0
[ -d "$MEMORY/lancedb" ] && lance_bytes=$(du -sb "$MEMORY/lancedb" 2>/dev/null | cut -f1 || echo 0)

manifest="$QA_ROOT/manifest.json"
python3 - <<PY
import json, os
from datetime import datetime, timezone
agents = $(printf '%s\n' "${AGENT_LIST[@]}" | python3 -c 'import json,sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))')
manifest = {
  "fetchedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
  "maeve": "$MAEVE",
  "fullMode": "$FULL" == "1",
  "sessionDays": $DAYS,
  "sessionCapPerAgent": $CAP,
  "sessionFiles": $total_session_files,
  "agents": agents,
  "factsMode": "$FACTS_MODE",
  "factsDbBytes": $facts_bytes,
  "lanceCopied": "$LANCE" == "1",
  "lanceBytes": $lance_bytes,
  "dailyLogFiles": $daily_count,
  "paths": {
    "raw": ".offline-qa/raw",
    "sandbox": ".offline-qa/sandbox",
    "abFixtures": ".ab-fixtures"
  }
}
json.dump(manifest, open("$manifest", "w"), indent=2)
PY

AB="$ROOT/.ab-fixtures"
mkdir -p "$AB/sessions"
rsync -a --delete "$SESSIONS/" "$AB/sessions/"
cp -f "$RAW/facts-sample.json" "$AB/facts-sample.json"

echo "==> [7/7] Maeve APIM secrets (gitignored)..."
bash "$(dirname "$0")/fetch-maeve-secrets.sh" || echo "    (secrets fetch skipped — run fetch-maeve-secrets.sh manually)"

echo ""
echo "==> Done."
echo "    Manifest: $manifest"
echo "    Agents: ${AGENT_LIST[*]}"
echo "    Sessions: $total_session_files files"
echo "    Facts DB: $MEMORY/facts.db ($(numfmt --to=iec "$facts_bytes" 2>/dev/null || echo "${facts_bytes}B"))"
echo "    Daily logs: $daily_count"
echo "    Next: npm run offline-qa:setup && npm run offline-qa:verify -- --sandbox"
