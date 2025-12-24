# 云驿 API 二次中转代理

将云驿 Codex 的 Responses API 转换为标准 OpenAI Chat Completions API，同时支持 Claude CLI 代理。

快速上手与稳定使用：`docs/USAGE.md`

## ✅ 环境要求

- Node.js 18+（依赖内置 fetch）
- 可选：Bun（性能更好）

## 🚀 快速开始

### OpenAI 兼容代理 (Cursor/VS Code 等)

```bash
# 1. 配置环境变量
cp .env.example .env.local
# 编辑 .env.local 填入你的云驿激活码

# 2. 启动代理
npm run fast

# 3. 在 AI 工具中配置
#    Base URL: http://localhost:3456/v1
#    API Key:  你的云驿激活码
```

### Claude CLI 代理

```bash
# 0. 一键配置 + 启动（推荐）
./proxy-ctl.sh bootstrap

# 或者：npm
npm run bootstrap

# 1. 仅启动 Claude CLI 代理
npm run claude

# 2. Claude CLI 指向本地代理（自动：setup.sh 会写入 ~/.claude/settings.json）
export ANTHROPIC_BASE_URL=http://localhost:3457
```

**Claude CLI 代理模式（在 `.env.local` / `.env` 配置）**

- `CLAUDE_PROXY_MODE=codex`：Claude CLI → 云驿 Codex（使用 `CODEX_MODEL` + `CODEX_REASONING`）
- `CLAUDE_PROXY_MODE=claude`：Claude CLI → Claude 上游直通（需要 `CLAUDE_UPSTREAM_URL` + `CLAUDE_AUTH_TOKEN`）
- 如果看到错误 `Instructions are not valid / required`：通常是 `instructions` 不符合 Codex CLI 的标准 prompt；本项目默认使用 `proxy/codex-prompt.md`
- Claude Code 的 `/dev` 等工作流依赖工具调用：本代理会转发 `tools` 并把上游 function call 转回 `tool_use`；若工具未提供，则 `proxy/claude-proxy.js` 会自动降级为“直接在聊天里提问并继续”

**Claude Code 模型覆盖（含“子代理/小模型”）**

`setup.sh` 会写入 `~/.claude/settings.json`：

- `ANTHROPIC_MODEL`：主模型
- `ANTHROPIC_SMALL_FAST_MODEL`：Claude Code 常用作“子代理/后台小任务”的模型
- `settings.model`：部分版本会读取该字段作为默认模型

当 `CLAUDE_PROXY_MODE=codex` 时，上述字段会统一设置为 `CODEX_MODEL`，避免“主模型已切 Codex，但子代理仍用 claude-*”的混用。

**Claude Code 兼容性开关（可选）**

- `CLAUDE_CODE_COMPAT=1`：默认开启。遇到 `/dev` 等工作流要求 UI 工具（AskUserQuestion/SlashCommand/PlanMode）时自动降级，避免中止
- `CLAUDE_PROXY_DEBUG=1`：打印收到的消息 content block 类型摘要，排查“连续对话差/上下文丢失”
- `CLAUDE_PROXY_TOOL_PAYLOAD=truncate|none|full`：控制 `tool_use/tool_result` 在桥接时的 JSON 载荷（默认 `truncate`；若 UI 出现 `TodoWrite/tool_use` JSON 泄漏，建议设 `none`）
- `CLAUDE_PROXY_RETRY_429=1`：遇到 429/5xx 自动退避重试（默认开启）

**排查同类问题（推荐自检）**

```bash
npm run smoke:all
```

---

## 📁 项目结构

```
yunyi-api-proxy/
├── README.md              # 本文档
├── ARCHITECTURE.md        # 架构文档
├── .env.example           # 环境变量模板
├── .env.local             # 你的配置（推荐存放敏感信息）
├── .env                   # 可选：非敏感默认配置
├── package.json           # 根目录快捷命令
│
├── proxy/                 # ⭐ 核心：二次中转代理
│   ├── index-fast.js      # OpenAI 兼容代理 (端口 3456)
│   └── claude-proxy.js    # Claude CLI 代理 (端口 3457)
│
├── docs/                  # 文档
│   └── CURSOR_SETUP.md    # Cursor 详细配置指南
│
├── python/                # Python 示例
│   ├── requirements.txt
│   ├── simple_chat.py     # 非流式示例
│   └── stream_chat.py     # 流式示例
│
├── nodejs/                # Node.js 示例
│   ├── package.json
│   └── chat.js
│
├── curl/                  # cURL 示例
│   └── examples.sh
│
└── config/                # 编辑器配置指南
    ├── vscode-settings.json
    └── cursor-settings.json
```

---

## 🔧 核心原理

### 为什么需要二次中转？

云驿激活器提供的 Codex API 使用 **OpenAI Responses API** 格式，而大多数 AI 工具（VS Code、Cursor、OpenAI SDK 等）需要标准的 **Chat Completions API** 格式。

```
┌─────────────────────────────────────────────────────────────┐
│  AI 工具 (VS Code/Cursor/SDK)                               │
│  POST /v1/chat/completions                                   │
│  { "messages": [...] }                                       │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  本地代理 (localhost:3456)                                   │
│  转换: messages → input                                      │
│  添加: OpenAI-Organization header                            │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  云驿 API (yunyi.cfd/codex)                                  │
│  POST /v1/responses                                          │
│  { "input": [...], "stream": true }                          │
└─────────────────────────────────────────────────────────────┘
```

### API 格式转换

**请求转换 (Chat Completions → Responses)**

```javascript
// 输入 (Chat Completions 格式)
{
  "model": "gpt-5.2-codex",
  "messages": [{"role": "user", "content": "hi"}],
  "stream": true
}

// 输出 (Responses 格式)
{
  "model": "gpt-5.2-codex",
  "input": [{"type": "message", "role": "user", "content": "hi"}],
  "stream": true
}
```

**响应转换 (Responses → Chat Completions)**

```javascript
// 输入 (云驿 Responses 事件)
{ "type": "response.output_text.delta", "delta": "Hello" }
{ "type": "response.completed", "response": {...} }

// 输出 (Chat Completions 格式)
{ "choices": [{"delta": {"content": "Hello"}}] }
{ "choices": [{"delta": {}, "finish_reason": "stop"}] }
```

---

## 🔑 关键技术点

### 1. 必须的 Header

云驿 Codex API 需要 `OpenAI-Organization: openai` header 才能正常工作：

```javascript
headers: {
  'Authorization': `Bearer ${API_KEY}`,
  'Content-Type': 'application/json',
  'OpenAI-Organization': 'openai',  // ⚠️ 必须
}
```

### 2. 强制流式模式

云驿要求 `stream` 必须为 `true`，即使客户端请求非流式响应：

```javascript
responsesRequest.stream = true;  // 总是开启

// 非流式响应时，代理收集所有 delta 再一次性返回
```

### 3. Codex `instructions` 校验

云驿 Codex 的 `/codex/v1/responses` 会严格校验 `instructions`，必须使用 Codex CLI 的标准 prompt（项目内置：`proxy/codex-prompt.md`），否则会报 `Instructions are not valid / required`。

另外：上游不允许 `input` 里出现 `system` role，本项目会把 system 消息降级为 user 前缀。

### 4. 模型映射

代理会把任意模型名映射为默认模型，可在 `.env.local`（或 `.env`）中通过 `YUNYI_MODEL` 自定义：

```javascript
const DEFAULT_MODEL = process.env.YUNYI_MODEL || 'gpt-5.2-codex';
const mapModel = () => DEFAULT_MODEL;
```

---

## 📊 版本说明

当前仅保留高性能版 `proxy/index-fast.js`（原生 http，零依赖）。如需扩展 Express，可在此基础上自行引入。

---

## 🛠 启动命令

```bash
# 在根目录运行

npm run bootstrap      # 一键配置 + 启动全部代理（推荐）
npm run ctl            # 代理控制脚本（start/stop/status/logs）

npm run fast          # 高性能版 (推荐，零依赖)
npm start             # 同 npm run fast
npm run claude        # Claude CLI 代理（端口 3457）
npm run install:proxy # 如需安装自定义依赖

# 在 proxy 目录运行
cd proxy
npm run fast          # 高性能版
npm start             # 同 npm run fast
npm run bun           # 使用 Bun 运行 (最快)
```

---

## ✅ 健康检查

- `GET /health`：存活检查
- `GET /ready`：就绪检查（校验关键配置）

---

## 🔌 支持的工具

通过本代理，可在以下工具中使用云驿额度：

- ✅ VS Code Copilot / Continue
- ✅ Cursor
- ✅ OpenAI Python SDK
- ✅ OpenAI Node.js SDK

---

## ⚙️ 安全与配置建议

推荐在 `.env.local` 中配置以下项：

```bash
# 必需
YUNYI_API_KEY=你的云驿激活码

# 安全建议
PROXY_HOST=127.0.0.1
PROXY_API_KEY=自定义访问密钥

# 请求保护（可选）
MAX_BODY_BYTES=1048576
READ_TIMEOUT_MS=15000
UPSTREAM_TIMEOUT_MS=45000

# 默认模型（可选）
YUNYI_MODEL=gpt-5.2-codex

# CORS 允许来源（可选，逗号分隔）
CORS_ORIGINS=*

# 强制关闭超时（可选）
FORCE_SHUTDOWN_MS=10000

# 其他
LOG_PREVIEW=false
AUTO_KILL_PORT=false
```

说明：
- `PROXY_HOST` 默认仅绑定本机，避免局域网滥用。
- `PROXY_API_KEY` 启用后，请在客户端请求头中加入 `Authorization: Bearer <PROXY_API_KEY>`。
- `AUTO_KILL_PORT` 默认关闭，避免误杀占用端口的其他进程。
- `CORS_ORIGINS` 默认为 `*`，生产环境建议指定来源白名单。
- `FORCE_SHUTDOWN_MS` 用于优雅关闭时的强制退出兜底。

**配置示例：**

| 配置项 | 值 |
|--------|-----|
| Base URL | `http://localhost:3456/v1` |
| API Key | 你的云驿激活码 |
| Model | `gpt-5.2` / `gpt-5.2-codex` |

---

## 🧭 生产运行

生产部署与运维建议见 `docs/OPERATIONS.md`。

---

## 🐛 常见问题

### Q: 返回 502 错误

确保请求包含 `OpenAI-Organization: openai` header。代理已自动处理。

### Q: 返回 "Stream must be set to true"

云驿 API 只支持流式响应。代理已自动强制开启 stream。

### Q: 模型不存在

代理会将任意模型名映射到默认模型（可通过 `YUNYI_MODEL` 调整）。

---

## 📝 开发维护

### 修改默认模型

在 `.env.local`（或 `.env`）中设置 `YUNYI_MODEL`，或直接修改 `proxy/index-fast.js` 中的 `DEFAULT_MODEL`。

### 修改端口

设置环境变量 `PROXY_PORT`：

```bash
PROXY_PORT=8080 npm run fast
```

或在 `.env.local`（或 `.env`）中添加：

```
PROXY_PORT=8080
```

---

## 📄 License

MIT
