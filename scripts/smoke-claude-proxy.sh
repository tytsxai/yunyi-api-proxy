#!/bin/bash
set -euo pipefail

BASE_URL="${CLAUDE_BASE_URL:-http://localhost:3457}"

echo "[smoke] checking ${BASE_URL}/health"
curl -fsS "${BASE_URL}/health" > /dev/null

echo "[smoke] checking ${BASE_URL}/ready"
curl -fsS "${BASE_URL}/ready" > /dev/null

echo "[smoke] sending non-stream message with tool blocks"
cat > /tmp/claude-proxy-smoke.json <<'JSON'
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
  --data-binary @/tmp/claude-proxy-smoke.json \
  | head -c 300

echo
echo "[smoke] ok"
