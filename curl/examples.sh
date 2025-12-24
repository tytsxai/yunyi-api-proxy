#!/bin/bash
#
# Yunyi API cURL 示例
#

# ============================================
# 配置
# ============================================
API_KEY="${YUNYI_API_KEY:-your-activation-code-here}"
LOCAL_OPENAI_URL="${LOCAL_OPENAI_URL:-http://localhost:3456/v1}"
CLAUDE_URL="https://yunyi.cfd/claude"
USER_API_URL="https://yunyi.cfd/user/api/v1"

# ============================================
# 1. 验证 API Key / 查询账户信息
# ============================================
echo "=========================================="
echo "1. 查询账户信息"
echo "=========================================="

curl -s -X GET "${USER_API_URL}/me" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" | python3 -m json.tool

# ============================================
# 2. 通过本地代理调用 Codex (非流式)
# ============================================
echo ""
echo "=========================================="
echo "2. Codex Chat Completion (via local proxy)"
echo "=========================================="

curl -s -X POST "${LOCAL_OPENAI_URL}/chat/completions" \
  -H "Authorization: Bearer any-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.2-codex",
    "messages": [
      {"role": "system", "content": "你是一个编程助手"},
      {"role": "user", "content": "用 Python 写一个冒泡排序"}
    ],
    "reasoning": { "effort": "medium" },
    "max_tokens": 300
  }' | python3 -m json.tool

# ============================================
# 3. 通过本地代理调用 Codex (流式)
# ============================================
echo ""
echo "=========================================="
echo "3. 流式输出示例 (via local proxy)"
echo "=========================================="

curl -s -X POST "${LOCAL_OPENAI_URL}/chat/completions" \
  -H "Authorization: Bearer any-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.2",
    "messages": [
      {"role": "user", "content": "简单介绍一下 Docker"}
    ],
    "reasoning": { "effort": "medium" },
    "stream": true
  }'

echo ""

# ============================================
# 4. 列出本地代理可用模型
# ============================================
echo ""
echo "=========================================="
echo "4. 列出可用模型 (via local proxy)"
echo "=========================================="

curl -s -X GET "${LOCAL_OPENAI_URL}/models" \
  -H "Authorization: Bearer any-key" | python3 -m json.tool

# ============================================
# 使用说明
# ============================================
echo ""
echo "=========================================="
echo "使用说明"
echo "=========================================="
echo "
1. 替换 API_KEY 为您的激活码
2. chmod +x examples.sh 添加执行权限
3. ./examples.sh 运行测试

API 端点说明:
- ${USER_API_URL}/me     - 查询账户/配额信息
- ${LOCAL_OPENAI_URL}/chat/completions - Chat 接口（本地代理）
- ${LOCAL_OPENAI_URL}/models - 模型列表（本地代理）
"
