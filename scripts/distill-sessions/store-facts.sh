#!/bin/bash
# store-facts.sh - Store extracted facts via OpenClaw CLI
#
# Usage: ./store-facts.sh <facts.jsonl>
#
# Takes a JSONL file of extracted facts and generates memory_store commands.
# Currently outputs commands for review rather than executing directly.

set -euo pipefail

if [ $# -ne 1 ]; then
    echo "Usage: $0 <facts.jsonl>" >&2
    echo "" >&2
    echo "Processes extracted facts and generates memory_store commands." >&2
    exit 1
fi

FACTS_FILE="$1"

if [ ! -f "$FACTS_FILE" ]; then
    echo "Error: Facts file not found: $FACTS_FILE" >&2
    exit 1
fi

# Initialize stats
declare -A category_counts
total_facts=0
skipped=0

echo "# Memory Store Commands"
echo "# Generated from: $FACTS_FILE"
echo "# Review these commands before executing"
echo ""

# Process each fact
while IFS= read -r line; do
    # Skip empty lines
    [ -z "$line" ] && continue
    
    total_facts=$((total_facts + 1))
    
    # Parse JSON fields using jq
    category=$(echo "$line" | jq -r '.category // "other"')
    text=$(echo "$line" | jq -r '.text // ""')
    entity=$(echo "$line" | jq -r '.entity // ""')
    key=$(echo "$line" | jq -r '.key // ""')
    value=$(echo "$line" | jq -r '.value // ""')
    
    # Validate required fields
    if [ -z "$text" ]; then
        echo "# Warning: Skipped fact with no text (line $total_facts)" >&2
        skipped=$((skipped + 1))
        continue
    fi
    
    # Count by category
    category_counts[$category]=$((${category_counts[$category]:-0} + 1))
    
    # Generate openclaw CLI command
    # Format: openclaw memory store --text "..." --category "..." [--entity "..."] [--key "..."] [--value "..."]
    cmd="openclaw memory store"
    cmd+=" --text $(printf '%q' "$text")"
    cmd+=" --category $(printf '%q' "$category")"
    
    [ -n "$entity" ] && cmd+=" --entity $(printf '%q' "$entity")"
    [ -n "$key" ] && cmd+=" --key $(printf '%q' "$key")"
    [ -n "$value" ] && cmd+=" --value $(printf '%q' "$value")"
    
    echo "$cmd"
    
done < "$FACTS_FILE"

echo ""
echo "# === STATS ==="
echo "# Total facts: $total_facts"
echo "# Skipped: $skipped"
echo "# Valid: $((total_facts - skipped))"
echo ""
echo "# By category:"
for category in "${!category_counts[@]}"; do
    printf "#   %-12s %d\n" "$category:" "${category_counts[$category]}"
done | sort

echo ""
echo "# To execute these commands:"
echo "#   1. Review the output above carefully"
echo "#   2. Redirect to a file: ./store-facts.sh facts.jsonl > commands.sh"
echo "#   3. Make executable: chmod +x commands.sh"
echo "#   4. Run: ./commands.sh"
echo "#   5. Or pipe directly: ./store-facts.sh facts.jsonl | bash"
