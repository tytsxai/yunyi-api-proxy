# 架构文档

## 系统架构图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              客户端层                                     │
├─────────────────────────────────────────────────────────────────────────┤
│  VS Code    │   Cursor    │  Python SDK  │  Node.js SDK  │  其他工具    │
│  Copilot    │             │   OpenAI     │    OpenAI     │              │
└──────┬──────┴──────┬──────┴──────┬───────┴───────┬───────┴───────┬──────┘
       │             │             │               │               │
       └─────────────┴─────────────┴───────┬───────┴───────────────┘
                                           │
                           POST /v1/chat/completions
                           (标准 OpenAI 格式)
                                           │
                                           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         本地代理层 (localhost:3456)                       │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐   │
│  │   请求转换        │ → │   调用上游 API    │ → │   响应转换        │   │
│  │                  │    │                  │    │                  │   │
│  │ messages → input │    │ + Organization   │    │ delta → content  │   │
│  │ 模型映射         │    │   header         │    │ SSE 格式转换     │   │
│  └──────────────────┘    └──────────────────┘    └──────────────────┘   │
│                                                                          │
│  index-fast.js (高性能)                                      │
│  零依赖，原生 http                                           │
│                                                                          │
└─────────────────────────────────────┬───────────────────────────────────┘
                                       │
                          POST /codex/v1/responses
                          (OpenAI Responses API 格式)
                          + OpenAI-Organization: openai
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         云驿服务层 (yunyi.cfd)                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  /user/api/v1/me     ─── 账户信息、配额查询                              │
│  /codex/v1/responses ─── Codex 生成接口 (Responses API)                  │
│  /claude/v1/messages ─── Claude 接口 (需要 Claude 权限)                  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## 数据流

### 非流式请求

```
1. 客户端发送 POST /v1/chat/completions { stream: false }
2. 代理强制设置 stream: true (云驿要求)
3. 代理调用云驿 /v1/responses
4. 云驿返回 SSE 流
5. 代理收集所有 delta，拼接完整响应
6. 代理返回标准 Chat Completion 响应给客户端
```

### 流式请求

```
1. 客户端发送 POST /v1/chat/completions { stream: true }
2. 代理调用云驿 /v1/responses
3. 云驿返回 SSE 流
4. 代理实时转换每个事件格式
5. 代理返回转换后的 SSE 流给客户端
```

## 核心模块

### 请求处理流程

```javascript
handleChatCompletions(req, res)
├── 解析请求体 (JSON)
├── convertToResponsesFormat()
│   ├── 转换 messages → input
│   ├── mapModel() 模型映射
│   └── 强制 stream: true
├── fetch() 调用云驿 API
│   └── 添加 OpenAI-Organization header
├── 处理响应
│   ├── [流式] 实时转换并输出
│   └── [非流式] 收集完整响应后输出
└── 错误处理
```

### 关键函数

| 函数 | 作用 |
|------|------|
| `mapModel(model)` | 模型名映射 |
| `convertToResponsesFormat(req)` | 请求格式转换 |
| `extractAssistantText(response)` | 从 Responses 提取文本 |
| `generateId()` | 生成响应 ID |

## 扩展点

### 添加新端点

在 `handleChatCompletions` 后添加新路由：

```javascript
if (method === 'POST' && pathname === '/v1/embeddings') {
  return handleEmbeddings(req, res);
}
```

### 添加中间件 / 日志

本项目使用原生 `http`，可在 `createServer` 入口统一处理日志、鉴权、限流等逻辑。

### 添加认证

```javascript
const apiKey = req.headers['authorization']?.replace('Bearer ', '');
if (apiKey !== process.env.PROXY_API_KEY) {
  return jsonResponse(res, 401, { error: { message: 'Unauthorized' } });
}
```

启用方式：在 `.env.local`（或 `.env`）中设置 `PROXY_API_KEY`。

## 测试命令

```bash
# 健康检查
curl http://localhost:3456/health

# 就绪检查
curl http://localhost:3456/ready

# 模型列表
curl http://localhost:3456/v1/models

# 非流式调用
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.2-codex","messages":[{"role":"user","content":"hi"}],"reasoning":{"effort":"medium"}}'

# 流式调用
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.2","messages":[{"role":"user","content":"hi"}],"reasoning":{"effort":"medium"},"stream":true}'
```
