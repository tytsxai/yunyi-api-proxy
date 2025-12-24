#!/bin/bash
# Claude CLI → Codex 代理一键启动脚本

cd "$(dirname "$0")/.."

echo "启动 Claude CLI → Codex 代理..."

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "❌ 需要 Node.js 18+"
    exit 1
fi

# 检查配置
if [ ! -f .env ]; then
    echo "❌ 缺少 .env 配置文件"
    echo "   请复制 .env.example 为 .env 并填入配置"
    exit 1
fi

# 最小化自动配置：确保 Claude CLI 走本地代理（不改 shell rc）
./setup.sh --quiet --no-shell 2>/dev/null || true

# 启动代理
node proxy/claude-proxy.js
