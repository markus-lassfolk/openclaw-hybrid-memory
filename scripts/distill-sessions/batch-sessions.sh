#!/bin/bash
# batch-sessions.sh - Split session files into batches for distillation
#
# Lists all *.jsonl files in ~/.openclaw/agents/main/sessions/ (excluding .deleted.*)
# Sorts by date (oldest first) and splits into batches of ~50 sessions each.
# Creates batch manifest files: batch-001.txt, batch-002.txt, etc.

set -euo pipefail

# Configuration
SESSIONS_DIR="$HOME/.openclaw/agents/main/sessions"
BATCH_SIZE=50
OUTPUT_DIR="$(dirname "$0")/batches"

# Validate sessions directory exists
if [ ! -d "$SESSIONS_DIR" ]; then
    echo "Error: Sessions directory not found: $SESSIONS_DIR" >&2
    exit 1
fi

# Create output directory
mkdir -p "$OUTPUT_DIR"

echo "Scanning sessions in: $SESSIONS_DIR"
echo "Batch size: $BATCH_SIZE sessions"
echo ""

# Find all non-deleted JSONL files, sort by modification time (oldest first)
# Using find with -printf for reliable sorting
session_files=$(find "$SESSIONS_DIR" -maxdepth 1 -type f -name "*.jsonl" ! -name ".deleted.*" -printf "%T+ %p\n" | sort | cut -d' ' -f2-)

total_sessions=$(echo "$session_files" | wc -l)

if [ "$total_sessions" -eq 0 ]; then
    echo "Error: No session files found" >&2
    exit 1
fi

echo "Found $total_sessions session files"
echo ""

# Split into batches
batch_num=1
current_batch=""
count=0

while IFS= read -r session_file; do
    current_batch+="$session_file"$'\n'
    count=$((count + 1))
    
    # When batch is full or this is the last file
    if [ $count -eq $BATCH_SIZE ] || [ $count -eq $total_sessions ]; then
        batch_file="$OUTPUT_DIR/batch-$(printf "%03d" $batch_num).txt"
        echo -n "$current_batch" > "$batch_file"
        
        files_in_batch=$(echo -n "$current_batch" | wc -l)
        echo "Created: $batch_file ($files_in_batch sessions)"
        
        # Reset for next batch
        batch_num=$((batch_num + 1))
        current_batch=""
        count=0
    fi
done <<< "$session_files"

total_batches=$((batch_num - 1))
echo ""
echo "✓ Created $total_batches batch manifest files in: $OUTPUT_DIR"
echo ""
echo "Next steps:"
echo "  1. Process each batch with extract-text.sh"
echo "  2. Feed extracted text to Gemini using gemini-prompt.md"
echo "  3. Store extracted facts with store-facts.sh"
