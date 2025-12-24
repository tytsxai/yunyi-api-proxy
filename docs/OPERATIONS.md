# 生产运行指南（最小运维集）

本项目为无状态本地/内网代理，核心目标是稳定转发与格式转换。以下为最小可运维建议，避免过度设计。

本项目包含两个独立服务：

- OpenAI 兼容代理：`proxy/index-fast.js`（端口 `3456`）
- Claude Code 代理：`proxy/claude-proxy.js`（端口 `3457`，给 `cc`/Claude Code 用）

## 运行前检查

- Node.js 18+（需要内置 fetch）
- `.env` 中已配置 `YUNYI_API_KEY`
- 端口与监听地址符合部署环境要求

建议运行前验证：

```bash
node -v
curl -s http://localhost:3456/health
```

## 启动与停止

本地启动：

```bash
npm run fast
```

Claude Code 代理（如需要）：

```bash
npm run claude
```

生产环境建议使用进程管理器（systemd/PM2）确保异常自动拉起。

systemd 示例：

```ini
[Unit]
Description=yunyi-proxy
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/yunyi-api-guide
EnvironmentFile=/path/to/yunyi-api-guide/.env
ExecStart=/usr/bin/node proxy/index-fast.js
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

Claude Code 代理可复制一份 service，`ExecStart` 改为 `proxy/claude-proxy.js`，端口用 `CLAUDE_PROXY_PORT` 控制。

## 健康检查与告警

- `GET /health`：存活检查
- `GET /ready`：就绪检查（校验关键配置）

建议告警条件：
- 5xx 比例异常升高
- 请求延迟显著上升
- `/ready` 失败

## 日志与排障

日志默认输出到 stdout，包含请求 ID 与时延，示例：

```
[Proxy] req=req_... POST /v1/chat/completions 200 123.4ms upstream=200 98.7ms
```

排障建议：
- 通过 `X-Request-Id` 关联上游问题
- 生产环境保持 `LOG_PREVIEW=false`，避免打印输入内容

## Claude Code / 插件已知边界（避免误判为“代理 bug”）

- **UI 出现 JSON/内部结构泄漏**：常见于 `tool_use/tool_result` 被文本化，或插件 hooks 把 stdout 输出穿透到 UI。
  - 代理侧止血：`.env.local` 设置 `CLAUDE_PROXY_TOOL_PAYLOAD=none`
  - 插件侧（如 claude-mem）：建议将插件日志降到最小（例如设置 `CLAUDE_MEM_LOG_LEVEL=SILENT`），或临时禁用插件验证根因
- **后台任务中途停止**：多见于上游 429（并发限流）导致流式失败/回退失败。
  - 代理侧：默认对 429/5xx 做退避重试（`CLAUDE_PROXY_RETRY_429=1`）
  - 仍频繁 429：需要从任务侧降低并发，或配置 `CLAUDE_PROXY_MAX_CONCURRENCY`（可选；`0` 表示不限制）

## 安全基线

- `PROXY_HOST=127.0.0.1` 默认仅本机访问
- 公网暴露时务必启用 `PROXY_API_KEY`
- `CORS_ORIGINS` 生产环境建议指定白名单
- 使用防火墙或反向代理限制来源
- 不在日志中输出完整密钥

## 回滚与恢复

- 项目无状态，回滚只需切换到上一个稳定版本并重启进程
- 建议打 git tag 或使用发布目录保留上一版本

## 备份策略

- 无持久化数据
- 需备份 `.env`（或使用密钥管理服务托管）

## 变更发布建议

1. 修改配置或代码
2. 重启服务
3. 执行健康检查：`/health`、`/ready`（或 `npm run smoke`）
4. 观察日志与错误率

## 交付自检清单（建议固化为上线门槛）

- 配置：已使用 `.env.example` 生成 `.env.local`，并确认 `.env.local` 未被提交到仓库（避免泄露密钥）
- OpenAI 代理：`curl -s http://localhost:3456/ready` 返回 `status: ok`
- Claude 代理：`curl -s http://localhost:3457/ready` 返回 `status: ok`
- 冒烟测试：`npm run smoke:all` 通过（或分别跑 `smoke` / `smoke:claude`）
- Claude Code：确认 `~/.claude/settings.json` 的 `ANTHROPIC_BASE_URL` 指向本地代理，且 `ANTHROPIC_MODEL`/`ANTHROPIC_SMALL_FAST_MODEL` 与预期一致
