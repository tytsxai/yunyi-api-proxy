# 使用指南（稳定使用 / 高容错）

本项目提供两条本地代理链路：

- **OpenAI 兼容代理**（端口 `3456`）：`/v1/chat/completions`（给 Cursor/VS Code/OpenAI SDK 用）
- **Claude CLI/Claude Code 代理**（端口 `3457`）：`/v1/messages`（给 `cc`/Claude Code 用）

---

## 1) 一键启动（推荐）

```bash
cd yunyi-api-proxy
cp .env.example .env.local
# 编辑 .env.local 填入 YUNYI_API_KEY

./proxy-ctl.sh bootstrap
```

检查状态：

```bash
./proxy-ctl.sh status
./proxy-ctl.sh logs
```

---

## 2) 健康检查（上线前必做）

本项目对两个代理都提供：

- `GET /health`：存活
- `GET /ready`：就绪（校验关键配置）

推荐自检：

```bash
npm run smoke      # OpenAI 代理 (3456)
npm run smoke:claude
npm run smoke:all
```

---

## 3) OpenAI 兼容代理（Cursor / VS Code / SDK）

启动：

```bash
npm run fast
```

工具配置：

- Base URL：`http://localhost:3456/v1`
- API Key：默认填任意值即可（代理以 `.env.local` 的 `YUNYI_API_KEY` 为准）
- 若启用了 `PROXY_API_KEY`：客户端 API Key 必须填写 `PROXY_API_KEY`

Cursor 详细配置：`docs/CURSOR_SETUP.md`

---

## 4) Claude CLI / Claude Code（cc）

启动 Claude 代理：

```bash
npm run claude
export ANTHROPIC_BASE_URL=http://localhost:3457
```

常见用法：

```bash
cc
```

### 4.1 连续对话与 /dev 工具兼容性

Claude Code 的 `/dev` 等工作流会通过 `tools/tool_choice/tool_use/tool_result` 来驱动交互式执行（例如询问、读目录、跑命令）。

本代理做了两层保障，避免“工具缺失导致中止 / 对话不连续”：

- **工具桥接**：转发 `tools/tool_choice` 到上游，并把上游 `function_call` 转回 Claude 的 `tool_use`
- **降级策略**：若某些 UI 工具未提供（或上游暂不支持 `tools/tool_choice`），自动降级为“直接在聊天里提问并继续”，避免卡死

相关开关（放在 `.env.local`）：

- `CLAUDE_CODE_COMPAT=1`：默认开启（仅在工具缺失时介入）
- `CLAUDE_PROXY_DEBUG=1`：打印收到的消息 content block 类型摘要（排查不连续/丢上下文）
- `CLAUDE_PROXY_TOOL_PAYLOAD=truncate|none|full`：控制 `tool_use/tool_result` 写回上游时是否带 JSON（默认 `truncate`，想彻底杜绝 UI “JSON 泄漏”可设 `none`）
- `CLAUDE_PROXY_MAX_CONCURRENCY=0`：并发上限（默认 `0`=不限制；若要降低 429/中断概率可设 1–2）
- `CLAUDE_PROXY_RETRY_429=1`：遇到 429/5xx 自动退避重试（默认开启）

---

## 5) 推荐的稳定配置（.env.local）

最小必填：

```bash
YUNYI_API_KEY=你的云驿激活码
```

推荐（安全 + 稳定）：

```bash
PROXY_HOST=127.0.0.1
PROXY_API_KEY=自定义强随机密钥

MAX_BODY_BYTES=1048576
READ_TIMEOUT_MS=15000
UPSTREAM_TIMEOUT_MS=120000

CLAUDE_CODE_COMPAT=1
CLAUDE_PROXY_DEBUG=0
```

---

## 6) 排障速查

- **工具/对话不连续**：先开 `CLAUDE_PROXY_DEBUG=1`，重启 `./proxy-ctl.sh restart claude`，看 `~/.yunyi-proxy/logs/claude.log`
- **就绪失败**：`curl http://localhost:3456/ready` 或 `curl http://localhost:3457/ready` 看缺哪些配置
- **端口冲突**：用 `./proxy-ctl.sh stop` 停止旧进程，或改端口（`PROXY_PORT`/`CLAUDE_PROXY_PORT`）
- **上游报 tools/tool_choice 参数错误**：代理会自动重试不带 tools；如仍失败，查看 `claude.log` 的 upstream error
