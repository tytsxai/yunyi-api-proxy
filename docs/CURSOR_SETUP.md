# Cursor 配置指南

使用云驿二次中转代理，在 Cursor 中使用 gpt-5.2 / gpt-5.2-codex。

## 前提条件

1. 启动本地代理：
```bash
cd yunyi-api-proxy
npm run fast
```

2. 确认代理正常运行，会显示：
```
本地端点:   http://localhost:3456/v1
远程端点:   http://192.168.x.x:3456/v1
云驿 Key:   你的激活码
```

## Cursor 配置步骤

### 方法一：通过设置界面

1. 打开 Cursor → **Settings** (Cmd+,)
2. 搜索 **"OpenAI"**
3. 找到以下配置项：

| 配置项 | 值 |
|--------|-----|
| **OpenAI API Key** | `任意值` (如 sk-xxx) |
| **OpenAI Base URL** | `http://localhost:3456/v1` |

### 方法二：通过环境变量

在 `~/.zshrc` 或 `~/.bashrc` 中添加：

```bash
export OPENAI_API_KEY="any-key"
export OPENAI_BASE_URL="http://localhost:3456/v1"
```

然后执行 `source ~/.zshrc`。

## 使用说明

- **模型选择**：在 Cursor 中选择 `gpt-5.2` 或 `gpt-5.2-codex`（其余模型名会被映射到默认模型）
- **API Key**：默认可以填任意值，代理使用 `.env.local`（或 `.env`）中配置的云驿激活码
- **启用代理鉴权时**：若设置了 `PROXY_API_KEY`，请在 Cursor 的 API Key 中填写该值
- **远程访问**：如果代理运行在其他机器，使用该机器的 IP 替换 localhost

## 故障排查

### 502 错误
- 检查代理是否正在运行 (`npm run fast`)
- 检查云驿服务是否正常 (可能是临时故障)

### 无法连接
- 确认端口 3456 没有被防火墙阻挡
- 确认 Base URL 格式正确（必须包含 `/v1`）

### API Key 错误
- 未启用代理鉴权时，代理会忽略 Cursor 发送的 API Key
- 启用代理鉴权时，请在 Cursor 填写 `PROXY_API_KEY`
- 确认 `.env.local`（或 `.env`）文件中的 `YUNYI_API_KEY` 正确
