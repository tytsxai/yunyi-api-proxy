#!/bin/bash
#
# 云驿 API 代理控制脚本
# 用法: ./proxy-ctl.sh [start|stop|restart|status|logs] [openai|claude|all]
#

set -e
cd "$(dirname "$0")"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# PID 文件
OPENAI_PID="/tmp/yunyi-openai-proxy.pid"
CLAUDE_PID="/tmp/yunyi-claude-proxy.pid"

# 日志文件
LOG_DIR="$HOME/.yunyi-proxy/logs"
mkdir -p "$LOG_DIR"

print_banner() {
    echo -e "${BLUE}"
    echo "═══════════════════════════════════════════"
    echo "  云驿 API 代理控制面板"
    echo "═══════════════════════════════════════════"
    echo -e "${NC}"
}

check_node() {
    if ! command -v node &> /dev/null; then
        echo -e "${RED}❌ 需要 Node.js 18+${NC}"
        exit 1
    fi
}

check_env() {
    if [ ! -f .env ] && [ ! -f .env.local ]; then
        echo -e "${YELLOW}⚠️  未找到 .env 配置文件${NC}"
        echo "   请复制 .env.example 为 .env.local 并填入配置"
        exit 1
    fi
}

is_running() {
    local pid_file=$1
    if [ -f "$pid_file" ]; then
        local pid=$(cat "$pid_file")
        if ps -p "$pid" > /dev/null 2>&1; then
            return 0
        fi
    fi
    return 1
}

get_pid() {
    local pid_file=$1
    if [ -f "$pid_file" ]; then
        cat "$pid_file"
    fi
}

start_openai() {
    if is_running "$OPENAI_PID"; then
        echo -e "${YELLOW}⚠️  OpenAI 代理已在运行 (PID: $(get_pid $OPENAI_PID))${NC}"
        return
    fi
    echo -e "${GREEN}▶ 启动 OpenAI 兼容代理...${NC}"
    nohup node proxy/index-fast.js > "$LOG_DIR/openai.log" 2>&1 &
    echo $! > "$OPENAI_PID"
    sleep 1
    if is_running "$OPENAI_PID"; then
        echo -e "${GREEN}✅ OpenAI 代理已启动 (PID: $(get_pid $OPENAI_PID))${NC}"
        echo -e "   端点: http://localhost:3456/v1"
    else
        echo -e "${RED}❌ OpenAI 代理启动失败${NC}"
    fi
}

start_claude() {
    if is_running "$CLAUDE_PID"; then
        echo -e "${YELLOW}⚠️  Claude 代理已在运行 (PID: $(get_pid $CLAUDE_PID))${NC}"
        return
    fi
    echo -e "${GREEN}▶ 启动 Claude CLI 代理...${NC}"
    nohup node proxy/claude-proxy.js > "$LOG_DIR/claude.log" 2>&1 &
    echo $! > "$CLAUDE_PID"
    sleep 1
    if is_running "$CLAUDE_PID"; then
        echo -e "${GREEN}✅ Claude 代理已启动 (PID: $(get_pid $CLAUDE_PID))${NC}"
        echo -e "   端点: http://localhost:3457  (Anthropic: POST /v1/messages)"
    else
        echo -e "${RED}❌ Claude 代理启动失败${NC}"
    fi
}

stop_openai() {
    if is_running "$OPENAI_PID"; then
        local pid=$(get_pid $OPENAI_PID)
        kill "$pid" 2>/dev/null
        rm -f "$OPENAI_PID"
        echo -e "${GREEN}✅ OpenAI 代理已停止${NC}"
    else
        echo -e "${YELLOW}⚠️  OpenAI 代理未运行${NC}"
    fi
}

stop_claude() {
    if is_running "$CLAUDE_PID"; then
        local pid=$(get_pid $CLAUDE_PID)
        kill "$pid" 2>/dev/null
        rm -f "$CLAUDE_PID"
        echo -e "${GREEN}✅ Claude 代理已停止${NC}"
    else
        echo -e "${YELLOW}⚠️  Claude 代理未运行${NC}"
    fi
}

show_status() {
    echo -e "${BLUE}服务状态:${NC}"
    echo ""
    if is_running "$OPENAI_PID"; then
        echo -e "  OpenAI 代理:  ${GREEN}● 运行中${NC} (PID: $(get_pid $OPENAI_PID))"
        echo -e "                http://localhost:3456/v1"
    else
        echo -e "  OpenAI 代理:  ${RED}○ 已停止${NC}"
    fi
    echo ""
    if is_running "$CLAUDE_PID"; then
        echo -e "  Claude 代理:  ${GREEN}● 运行中${NC} (PID: $(get_pid $CLAUDE_PID))"
        echo -e "                http://localhost:3457  (POST /v1/messages)"
    else
        echo -e "  Claude 代理:  ${RED}○ 已停止${NC}"
    fi
    echo ""
}

show_logs() {
    local service=$1
    case $service in
        openai)
            echo -e "${BLUE}OpenAI 代理日志:${NC}"
            tail -50 "$LOG_DIR/openai.log" 2>/dev/null || echo "无日志"
            ;;
        claude)
            echo -e "${BLUE}Claude 代理日志:${NC}"
            tail -50 "$LOG_DIR/claude.log" 2>/dev/null || echo "无日志"
            ;;
        *)
            echo -e "${BLUE}=== OpenAI 代理日志 ===${NC}"
            tail -20 "$LOG_DIR/openai.log" 2>/dev/null || echo "无日志"
            echo ""
            echo -e "${BLUE}=== Claude 代理日志 ===${NC}"
            tail -20 "$LOG_DIR/claude.log" 2>/dev/null || echo "无日志"
            ;;
    esac
}

show_help() {
    echo "用法: $0 <命令> [服务]"
    echo ""
    echo "命令:"
    echo "  bootstrap 一键配置并启动"
    echo "  start   启动代理服务"
    echo "  stop    停止代理服务"
    echo "  restart 重启代理服务"
    echo "  status  查看服务状态"
    echo "  logs    查看服务日志"
    echo ""
    echo "服务 (可选):"
    echo "  openai  OpenAI 兼容代理 (端口 3456)"
    echo "  claude  Claude CLI 代理 (端口 3457)"
    echo "  all     所有服务 (默认)"
    echo ""
    echo "示例:"
    echo "  $0 start         # 启动所有服务"
    echo "  $0 start claude  # 仅启动 Claude 代理"
    echo "  $0 stop          # 停止所有服务"
    echo "  $0 status        # 查看状态"
    echo "  $0 logs claude   # 查看 Claude 日志"
}

# 主逻辑
check_node
check_env

CMD=${1:-help}
SERVICE=${2:-all}

case $CMD in
    bootstrap)
        print_banner
        ./setup.sh
        case $SERVICE in
            openai) start_openai ;;
            claude) start_claude ;;
            all) start_openai; start_claude ;;
            *) echo "未知服务: $SERVICE"; exit 1 ;;
        esac
        ;;
    start)
        print_banner
        # 最小化自动配置：确保 Claude CLI 走本地代理（不改 shell rc）
        ./setup.sh --quiet --no-shell 2>/dev/null || true
        case $SERVICE in
            openai) start_openai ;;
            claude) start_claude ;;
            all) start_openai; start_claude ;;
            *) echo "未知服务: $SERVICE"; exit 1 ;;
        esac
        ;;
    stop)
        case $SERVICE in
            openai) stop_openai ;;
            claude) stop_claude ;;
            all) stop_openai; stop_claude ;;
            *) echo "未知服务: $SERVICE"; exit 1 ;;
        esac
        ;;
    restart)
        # 最小化自动配置：确保 Claude CLI 走本地代理（不改 shell rc）
        ./setup.sh --quiet --no-shell 2>/dev/null || true
        case $SERVICE in
            openai) stop_openai; start_openai ;;
            claude) stop_claude; start_claude ;;
            all) stop_openai; stop_claude; start_openai; start_claude ;;
            *) echo "未知服务: $SERVICE"; exit 1 ;;
        esac
        ;;
    status)
        print_banner
        show_status
        ;;
    logs)
        show_logs "$SERVICE"
        ;;
    *)
        show_help
        ;;
esac
