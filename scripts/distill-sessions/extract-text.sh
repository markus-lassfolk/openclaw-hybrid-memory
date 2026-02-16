#!/bin/bash
# extract-text.sh - Extract human-readable text from OpenClaw session JSONL files
#
# Usage: ./extract-text.sh file1.jsonl file2.jsonl ... > batch.txt
#
# Extracts only user and assistant text messages, skipping tool calls/results
# and system messages. Outputs clean text with session markers.

set -euo pipefail

if [ $# -eq 0 ]; then
    echo "Usage: $0 <session-file.jsonl> [<session-file.jsonl> ...]" >&2
    echo "" >&2
    echo "Extracts human-readable conversation text from OpenClaw session files." >&2
    exit 1
fi

for session_file in "$@"; do
    if [ ! -f "$session_file" ]; then
        echo "Warning: File not found: $session_file" >&2
        continue
    fi
    
    # Output session marker
    basename="$(basename "$session_file")"
    echo ""
    echo "--- SESSION: $basename ---"
    echo ""
    
    # Extract text from user and assistant messages
    # Skip tool_calls, tool_result, and system messages
    # jq processes each line independently (JSONL format)
    jq -r '
        # Only process lines with type=="message"
        select(.type == "message") |
        # Extract the nested message object
        .message |
        # Only process user and assistant roles
        select(.role == "user" or .role == "assistant") |
        # Extract text content from content array
        if .content then
            .content[] | 
            # Only text blocks (skip tool_use, tool_result, etc.)
            select(.type == "text") |
            .text
        else
            empty
        end
    ' "$session_file" 2>/dev/null || {
        echo "Warning: Failed to parse $session_file" >&2
    }
done
