#!/usr/bin/env bash
# Copy bounded real session JSONL + facts sample from Maeve for local A/B runs.
set -euo pipefail

MAEVE="${MAEVE_SSH:-markus@192.168.1.224}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FIXTURES="$ROOT/.ab-fixtures"
SESSIONS="$FIXTURES/sessions"
DAYS="${AB_SESSION_DAYS:-45}"
CAP="${AB_SESSION_CAP:-400}"

mkdir -p "$SESSIONS" "$FIXTURES"

echo "==> Fetching session JSONL from Maeve (last ${DAYS}d, cap ${CAP} per agent)..."
for agent in main scholar hybrid-cron; do
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
done

echo "==> Exporting facts sample from Maeve..."
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
PY' > "$FIXTURES/facts-sample.json"

total_sessions=$(find "$SESSIONS" -name '*.jsonl' 2>/dev/null | wc -l)
echo "==> Done. Sessions: $total_sessions files | Facts: $FIXTURES/facts-sample.json"
