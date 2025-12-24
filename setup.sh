#!/bin/bash
# 云驿 API 代理 - 自动配置脚本
#
# 交付约束（重要）：
# - 本脚本的目标是“固化 Claude Code/Claude CLI 的指向”，让用户一键可用；
# - 不做复杂逻辑与隐式行为，尽量只写入与本项目代理相关的最小字段；
# - 当走本地 Codex 代理时，需要同时覆盖主模型与“子代理/小模型”（Claude Code 常用 ANTHROPIC_SMALL_FAST_MODEL），
#   否则会出现“主模型已切 Codex，但后台子任务仍用 claude-*”的混用与兼容性问题。

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
QUIET=0
NO_SHELL=0
NO_CLAUDE=0

# 颜色
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

while [[ $# -gt 0 ]]; do
    case "$1" in
        --quiet) QUIET=1; shift ;;
        --no-shell) NO_SHELL=1; shift ;;
        --no-claude) NO_CLAUDE=1; shift ;;
        -h|--help)
            echo "用法: $0 [--quiet] [--no-shell] [--no-claude]"
            exit 0
            ;;
        *)
            echo "未知参数: $1"
            exit 1
            ;;
    esac
done

say() {
    if [ "$QUIET" -eq 1 ]; then return; fi
    echo -e "$1"
}

read_env_value() {
    local key="$1"
    local file="$2"
    if [ ! -f "$file" ]; then return; fi
    local line
    line="$(grep -E "^${key}=" "$file" 2>/dev/null | tail -n 1 || true)"
    if [ -z "$line" ]; then return; fi
    echo "${line#*=}" | sed -E "s/^['\"]|['\"]$//g"
}

ENV_FILE="$SCRIPT_DIR/.env.local"
if [ ! -f "$ENV_FILE" ]; then
    ENV_FILE="$SCRIPT_DIR/.env"
fi
CLAUDE_PORT="$(read_env_value "CLAUDE_PROXY_PORT" "$ENV_FILE")"
CLAUDE_MODE="$(read_env_value "CLAUDE_PROXY_MODE" "$ENV_FILE")"
CODEX_MODEL="$(read_env_value "CODEX_MODEL" "$ENV_FILE")"
CODEX_REASONING="$(read_env_value "CODEX_REASONING" "$ENV_FILE")"
CLAUDE_PORT="${CLAUDE_PORT:-3457}"
CLAUDE_MODE="${CLAUDE_MODE:-codex}"
CODEX_MODEL="${CODEX_MODEL:-gpt-5.2-codex}"
CODEX_REASONING="${CODEX_REASONING:-medium}"

ANTHROPIC_BASE_URL="http://localhost:${CLAUDE_PORT}"

if [ "$CLAUDE_MODE" = "claude" ]; then
    CLAUDE_DEFAULT_MODEL="$(read_env_value "ANTHROPIC_MODEL" "$ENV_FILE")"
    CLAUDE_DEFAULT_MODEL="${CLAUDE_DEFAULT_MODEL:-claude-sonnet-4-20250514}"
    DESIRED_MODEL="$CLAUDE_DEFAULT_MODEL"
else
    DESIRED_MODEL="$CODEX_MODEL"
fi

say "${BLUE}"
say "═══════════════════════════════════════════════════════"
say "  云驿 API 代理 - 自动配置"
say "═══════════════════════════════════════════════════════"
say "${NC}"

# 检查 .env.local / .env 文件
if [ ! -f "$SCRIPT_DIR/.env.local" ] && [ ! -f "$SCRIPT_DIR/.env" ]; then
    say "${YELLOW}创建 .env.local 配置文件...${NC}"
    cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env.local" 2>/dev/null || {
        echo "YUNYI_API_KEY=your-api-key-here" > "$SCRIPT_DIR/.env.local"
        echo "CODEX_MODEL=gpt-5.2-codex" >> "$SCRIPT_DIR/.env.local"
        echo "CODEX_REASONING=medium" >> "$SCRIPT_DIR/.env.local"
        echo "CLAUDE_PROXY_PORT=3457" >> "$SCRIPT_DIR/.env.local"
    }
    say "${YELLOW}请编辑 .env.local 文件填入 API Key${NC}"
fi

if [ "$NO_CLAUDE" -ne 1 ]; then
    say "${GREEN}配置 Claude CLI...${NC}"

    mkdir -p "$(dirname "$CLAUDE_SETTINGS")"
    if [ ! -f "$CLAUDE_SETTINGS" ]; then
        echo '{}' > "$CLAUDE_SETTINGS"
    fi

    node -e "
const fs = require('fs');
const path = '$CLAUDE_SETTINGS';
let settings = {};
try { settings = JSON.parse(fs.readFileSync(path, 'utf8')); } catch (e) { settings = {}; }
settings.env = settings.env || {};
const desiredBaseUrl = '$ANTHROPIC_BASE_URL';
const desiredModel = '$DESIRED_MODEL';
let changed = false;

function set(obj, key, value) {
  if (obj[key] !== value) { obj[key] = value; changed = true; }
}

set(settings.env, 'ANTHROPIC_BASE_URL', desiredBaseUrl);
set(settings.env, 'ANTHROPIC_MODEL', desiredModel);
set(settings.env, 'ANTHROPIC_SMALL_FAST_MODEL', desiredModel);
set(settings, 'model', desiredModel);

if (changed) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  try { fs.copyFileSync(path, path + '.bak.' + ts); } catch (e) {}
  fs.writeFileSync(path, JSON.stringify(settings, null, 2));
}

console.log('  ANTHROPIC_BASE_URL = ' + desiredBaseUrl);
console.log('  model              = ' + desiredModel);
"
fi

# 配置 shell 环境变量
if [ "$NO_SHELL" -ne 1 ]; then
    say "${GREEN}配置 shell 环境变量...${NC}"
    SHELL_RC="$HOME/.zshrc"
    [ -f "$HOME/.bashrc" ] && [ ! -f "$HOME/.zshrc" ] && SHELL_RC="$HOME/.bashrc"

    if ! grep -q "ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL" "$SHELL_RC" 2>/dev/null; then
        echo "" >> "$SHELL_RC"
        echo "# 云驿 API 代理配置" >> "$SHELL_RC"
        echo "export ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL" >> "$SHELL_RC"
        say "  已添加到 $SHELL_RC"
    fi
fi

echo ""
say "${GREEN}配置完成！${NC}"
echo ""
echo "使用方法:"
echo "  1. 启动代理:  ./proxy-ctl.sh start"
if [ "$NO_SHELL" -ne 1 ]; then
    echo "  2. 新开终端或执行: source $SHELL_RC"
fi
echo "  3. 运行 Claude CLI: cc 或 claude"
echo ""
echo "代理端点: $ANTHROPIC_BASE_URL"
echo "代理模式: $CLAUDE_MODE"
echo "Claude CLI 模型: $DESIRED_MODEL"
echo "推理等级: $CODEX_REASONING"
