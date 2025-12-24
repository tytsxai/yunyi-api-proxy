#!/bin/bash
set -euo pipefail

BASE_URL="${CLAUDE_BASE_URL:-http://localhost:3457}"

echo "[smoke] checking ${BASE_URL}/health"
curl -fsS "${BASE_URL}/health" > /dev/null

echo "[smoke] checking ${BASE_URL}/ready"
curl -fsS "${BASE_URL}/ready" > /dev/null

if [ "${SMOKE_CLAUDE_MESSAGES:-0}" != "1" ]; then
  echo "[smoke] skipping /v1/messages (set SMOKE_CLAUDE_MESSAGES=1 to enable)"
  echo "[smoke] ok"
  exit 0
fi

echo "[smoke] sending non-stream message with tool blocks"
TMP_JSON="$(mktemp -t claude-proxy-smoke.XXXXXX)"
trap 'rm -f "$TMP_JSON"' EXIT
cat > "$TMP_JSON" <<'JSON'
{
  "model": "gpt-5.2-codex",
  "max_tokens": 128,
  "stream": false,
  "system": "Claude Code workflow test. AskUserQuestion must be used.",
  "tools": [
    {
      "name": "AskUserQuestion",
      "description": "Ask the user a question and wait for their reply.",
      "input_schema": {
        "type": "object",
        "properties": { "question": { "type": "string" } },
        "required": ["question"]
      }
    }
  ],
  "tool_choice": { "type": "auto" },
  "messages": [
    {
      "role": "assistant",
      "content": [
        { "type": "text", "text": "I will run a tool." },
        { "type": "tool_use", "id": "toolu_1", "name": "ReadFile", "input": { "path": "README.md" } }
      ]
    },
    {
      "role": "user",
      "content": [
        { "type": "tool_result", "tool_use_id": "toolu_1", "is_error": false, "content": "README contents..." },
        { "type": "text", "text": "Now summarize in one sentence." }
      ]
    }
  ]
}
JSON

curl -fsS "${BASE_URL}/v1/messages" \
  -H 'Content-Type: application/json' \
  --data-binary @"$TMP_JSON" \
  | head -c 300

echo
echo "[smoke] ok"
