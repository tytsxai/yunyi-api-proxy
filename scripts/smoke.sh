#!/bin/bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3456}"

echo "[smoke] GET ${BASE_URL}/health"
curl -fsS "${BASE_URL}/health" > /dev/null

echo "[smoke] GET ${BASE_URL}/ready"
curl -fsS "${BASE_URL}/ready" > /dev/null

echo "[smoke] ok"
