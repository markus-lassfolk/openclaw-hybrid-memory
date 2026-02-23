#!/usr/bin/env bash
# Fetch issues from a GlitchTip (Sentry-compatible) instance for the openclaw project.
# Used to review reported errors and map them to code fixes in this repo.
#
# Prerequisites:
#   - Create an Auth Token in GlitchTip: Profile → Auth Tokens (read scope is enough).
#
# Usage:
#   export GLITCHTIP_BASE_URL="http://192.168.1.99:8000"
#   export GLITCHTIP_AUTH_TOKEN="your-token"
#   ./scripts/fetch-glitchtip-issues.sh
#
# Optional: override project. GlitchTip API uses org_slug and project_slug; if your
# project ID is 1, try GLITCHTIP_PROJECT=1 (script will try projects/1/issues/ and
# projects/1/1/issues/). For org/project slugs: GLITCHTIP_ORG=myorg GLITCHTIP_PROJECT=openclaw
set -e

BASE="${GLITCHTIP_BASE_URL:-http://192.168.1.99:8000}"
TOKEN="${GLITCHTIP_AUTH_TOKEN:-}"
ORG="${GLITCHTIP_ORG:-openclaw}"
PROJECT="${GLITCHTIP_PROJECT:-hybrid-memory}"

if [ -z "$TOKEN" ]; then
  echo "GLITCHTIP_AUTH_TOKEN is not set. Create a token in GlitchTip: Profile → Auth Tokens." >&2
  echo "Then: export GLITCHTIP_AUTH_TOKEN=your-token && $0" >&2
  exit 1
fi

# Security warning: Bearer token over HTTP
if [[ "$BASE" =~ ^https?:// && ! "$BASE" =~ ^https:// ]]; then
  echo "WARNING: Using HTTP URL ($BASE) with Bearer token - auth token will be sent in cleartext!" >&2
  echo "Consider using HTTPS: export GLITCHTIP_BASE_URL=https://your-domain.com" >&2
fi

# Sentry-style: /api/0/projects/{org}/{project}/issues/
# Try numeric first (org=1, project=1), then org/1/project/1
URL1="${BASE}/api/0/projects/${ORG}/${PROJECT}/issues/?query=&statsPeriod=14d"
URL2="${BASE}/api/0/projects/1/issues/?query=&statsPeriod=14d"

echo "Fetching issues from GlitchTip (base: $BASE)..." >&2
if response=$(curl -s -w "\n%{http_code}" -H "Accept: application/json" -H "Authorization: Bearer $TOKEN" "$URL1"); then
  code=$(echo "$response" | tail -n1)
  body=$(echo "$response" | sed '$d')
  if [ "$code" = "200" ]; then
    echo "$body" | jq . 2>/dev/null || echo "$body"
    exit 0
  fi
  if [ "$code" = "404" ] && [ "$URL1" != "$URL2" ]; then
    response=$(curl -s -w "\n%{http_code}" -H "Accept: application/json" -H "Authorization: Bearer $TOKEN" "$URL2")
    code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')
    if [ "$code" = "200" ]; then
      echo "$body" | jq . 2>/dev/null || echo "$body"
      exit 0
    fi
  fi
  echo "HTTP $code" >&2
  echo "$body" | head -c 500 >&2
  echo "" >&2
  exit 1
fi
exit 1
