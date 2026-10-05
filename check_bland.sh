#!/usr/bin/env bash
# Verifies the Bland API key in .env by calling GET /v1/me
set -euo pipefail
cd "$(dirname "$0")"
set -a; source .env; set +a
: "${BLAND_API_KEY:?Set BLAND_API_KEY in .env first}"
curl -sS https://api.bland.ai/v1/me -H "authorization: $BLAND_API_KEY"
echo
