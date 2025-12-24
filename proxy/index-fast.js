/**
 * 云驿 API 二次中转代理 (高性能版)
 *
 * 零依赖实现，使用 Node.js 原生 http 模块
 * 如果安装了 Bun，用 `bun run index-fast.js` 运行可获得 3x 性能提升
 */

import { createServer } from "http";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { networkInterfaces } from "os";
import { once } from "events";
import { randomUUID } from "crypto";
import { loadDotEnvFiles } from "./lib/dotenv.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 加载配置（不污染系统环境变量；.env.local 覆盖 .env）
const config = loadDotEnvFiles([
  resolve(__dirname, "../.env"),
  resolve(__dirname, "../.env.local"),
]);

// 配置（.env 优先）
const YUNYI_API_KEY = config.YUNYI_API_KEY || process.env.YUNYI_API_KEY;
const YUNYI_CODEX_URL =
  config.YUNYI_CODEX_URL ||
  process.env.YUNYI_CODEX_URL ||
  "https://yunyi.cfd/codex";
const CODEX_REASONING = (
  config.CODEX_REASONING ||
  process.env.CODEX_REASONING ||
  "medium"
).toLowerCase();
const CODEX_INSTRUCTIONS_FILE =
  config.CODEX_INSTRUCTIONS_FILE ||
  process.env.CODEX_INSTRUCTIONS_FILE ||
  resolve(__dirname, "./codex-prompt.md");
const PORT = parseInt(
  config.PROXY_PORT || process.env.PROXY_PORT || "3456",
  10,
);
const PROXY_API_KEY = config.PROXY_API_KEY || process.env.PROXY_API_KEY;
const AUTO_KILL_PORT =
  (
    config.AUTO_KILL_PORT ||
    process.env.AUTO_KILL_PORT ||
    "false"
  ).toLowerCase() === "true";
const MAX_BODY_BYTES = parseInt(
  config.MAX_BODY_BYTES || process.env.MAX_BODY_BYTES || "1048576",
  10,
);
const READ_TIMEOUT_MS = parseInt(
  config.READ_TIMEOUT_MS || process.env.READ_TIMEOUT_MS || "15000",
  10,
);
const UPSTREAM_TIMEOUT_MS = parseInt(
  config.UPSTREAM_TIMEOUT_MS || process.env.UPSTREAM_TIMEOUT_MS || "45000",
  10,
);
const LOG_PREVIEW =
  (config.LOG_PREVIEW || process.env.LOG_PREVIEW || "false").toLowerCase() ===
  "true";
const FORCE_SHUTDOWN_MS = parseInt(
  config.FORCE_SHUTDOWN_MS || process.env.FORCE_SHUTDOWN_MS || "10000",
  10,
);
const CORS_ORIGINS = (config.CORS_ORIGINS || process.env.CORS_ORIGINS || "*")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

// 自动释放被占用的端口
function killPortProcess(port) {
  try {
    const pid = execSync(`lsof -ti:${port} 2>/dev/null`).toString().trim();
    if (pid) {
      console.log(`⚠️  端口 ${port} 被进程 ${pid} 占用，正在自动释放...`);
      execSync(`kill -9 ${pid}`);
      // 等待端口完全释放
      execSync("sleep 0.5");
      console.log(`✅ 端口已释放\n`);
    }
  } catch (e) {
    // 端口未被占用，正常情况
  }
}

// 启动前释放端口（默认关闭，避免误杀）
if (AUTO_KILL_PORT) {
  killPortProcess(PORT);
}

// Codex 可用模型
const DEFAULT_MODEL =
  config.YUNYI_MODEL || process.env.YUNYI_MODEL || "gpt-5.2-codex";
const ALLOWED_CODEX_MODELS = new Set(["gpt-5.2", "gpt-5.2-codex"]);

const mapModel = (model) => {
  if (typeof model === "string" && ALLOWED_CODEX_MODELS.has(model))
    return model;
  return DEFAULT_MODEL;
};

function pickReasoningEffort(chatRequest) {
  const raw =
    chatRequest?.reasoning_effort ??
    chatRequest?.reasoningEffort ??
    chatRequest?.reasoning?.effort ??
    chatRequest?.metadata?.reasoning_effort ??
    chatRequest?.metadata?.reasoningEffort ??
    chatRequest?.metadata?.reasoning ??
    CODEX_REASONING;
  const effort = typeof raw === "string" ? raw.toLowerCase() : CODEX_REASONING;
  return ["low", "medium", "high", "xhigh"].includes(effort)
    ? effort
    : CODEX_REASONING;
}

function loadCodexInstructions() {
  try {
    return readFileSync(CODEX_INSTRUCTIONS_FILE, "utf-8");
  } catch (e) {
    return "";
  }
}

const CODEX_INSTRUCTIONS = loadCodexInstructions();
const generateId = () => "chatcmpl-" + Math.random().toString(36).slice(2, 15);
const generateRequestId = () =>
  `req_${typeof randomUUID === "function" ? randomUUID() : Math.random().toString(36).slice(2, 12)}`;

// JSON 响应辅助函数
const jsonResponse = (res, status, data) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(data));
};

// 读取请求体（大小限制 + 超时）
const readBody = (req) =>
  new Promise((resolve, reject) => {
    let body = "";
    let total = 0;
    req.setEncoding("utf8");
    const timeout = setTimeout(() => {
      req.destroy();
      reject(new Error("Request timeout"));
    }, READ_TIMEOUT_MS);

    req.on("data", (chunk) => {
      total += Buffer.byteLength(chunk);
      if (total > MAX_BODY_BYTES) {
        clearTimeout(timeout);
        req.destroy();
        return reject(new Error("Request body too large"));
      }
      body += chunk;
    });
    req.on("end", () => {
      clearTimeout(timeout);
      resolve(body);
    });
    req.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    req.on("aborted", () => {
      clearTimeout(timeout);
      reject(new Error("Client aborted"));
    });
  });

// SSE 数据解析（支持 \r\n 和多行 data）
function consumeSse(state, chunk) {
  state.buffer += chunk;
  state.buffer = state.buffer.replace(/\r\n/g, "\n");
  const lines = state.buffer.split("\n");
  state.buffer = lines.pop() || "";
  const events = [];

  for (const line of lines) {
    if (line === "") {
      if (state.dataLines.length > 0) {
        events.push(state.dataLines.join("\n"));
        state.dataLines = [];
      }
      continue;
    }
    if (line.startsWith("data:")) {
      state.dataLines.push(line.slice(5).trimStart());
    }
  }
  return events;
}

// 从 Responses 格式提取文本
function extractAssistantText(responseData) {
  if (!responseData?.output) return "";
  for (const item of responseData.output) {
    if (item.type === "message" && item.role === "assistant" && item.content) {
      for (const c of item.content) {
        if (c.type === "output_text" && c.text) return c.text;
      }
    }
  }
  return "";
}

// 处理 Chat Completions 请求
async function handleChatCompletions(req, res) {
  const requestId = req.requestId || generateRequestId();
  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);

  try {
    const body = await readBody(req);

    // 请求验证
    if (!body || body.trim() === "") {
      return jsonResponse(res, 400, {
        error: { message: "Request body is empty", type: "invalid_request" },
      });
    }

    let chatRequest;
    try {
      chatRequest = JSON.parse(body);
    } catch (e) {
      return jsonResponse(res, 400, {
        error: {
          message: "Invalid JSON in request body",
          type: "invalid_request",
        },
      });
    }

    // 验证必需字段
    if (
      !chatRequest.messages ||
      !Array.isArray(chatRequest.messages) ||
      chatRequest.messages.length === 0
    ) {
      return jsonResponse(res, 400, {
        error: {
          message: "messages field is required and must be a non-empty array",
          type: "invalid_request",
        },
      });
    }

    // 验证 API Key 配置
    if (!YUNYI_API_KEY) {
      return jsonResponse(res, 500, {
        error: {
          message: "API key not configured. Please set YUNYI_API_KEY in .env",
          type: "configuration_error",
        },
      });
    }
    if (!CODEX_INSTRUCTIONS) {
      return jsonResponse(res, 500, {
        error: {
          message: `CODEX_INSTRUCTIONS not loaded (check CODEX_INSTRUCTIONS_FILE=${CODEX_INSTRUCTIONS_FILE})`,
          type: "configuration_error",
        },
      });
    }

    const isStream = chatRequest.stream ?? false;

    // 可选代理鉴权
    if (PROXY_API_KEY) {
      const auth = req.headers["authorization"] || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (token !== PROXY_API_KEY) {
        return jsonResponse(res, 401, {
          error: { message: "Unauthorized", type: "authentication_error" },
        });
      }
    }

    // 转换格式 - 处理各种消息格式
    const systemParts = [];
    const input = chatRequest.messages.map((m) => {
      // 处理 content 可能是多种格式的情况
      let content = m.content;

      // content 是数组 (OpenAI vision API 格式)
      if (Array.isArray(content)) {
        content = content
          .map((c) => {
            if (typeof c === "string") return c;
            if (c.type === "text") return c.text || "";
            if (c.text) return c.text;
            if (c.content) return c.content;
            return "";
          })
          .join("\n");
      }
      // content 是对象
      else if (typeof content === "object" && content !== null) {
        content = content.text || content.content || JSON.stringify(content);
      }
      // content 不是字符串
      else if (typeof content !== "string") {
        content = String(content || "");
      }

      const role = m.role || "user";
      if (role === "system") {
        systemParts.push(content || "");
        return null;
      }
      return { type: "message", role, content: content || "" };
    });

    const filteredInput = input.filter(Boolean);
    const systemText = systemParts
      .map((s) => String(s || "").trim())
      .filter(Boolean)
      .join("\n");
    if (systemText) {
      // 云驿 Codex 禁止 input 里出现 system role，这里降级为 user 前缀
      const prefix = `SYSTEM:\\n${systemText}\\n\\n`;
      if (filteredInput.length > 0 && filteredInput[0].role === "user") {
        filteredInput[0].content = prefix + (filteredInput[0].content || "");
      } else {
        filteredInput.unshift({
          type: "message",
          role: "user",
          content: prefix.trimEnd(),
        });
      }
    }

    const responsesRequest = {
      model: mapModel(chatRequest.model),
      input:
        filteredInput.length > 0
          ? filteredInput
          : [{ type: "message", role: "user", content: "" }],
      instructions: CODEX_INSTRUCTIONS,
      stream: true, // 云驿要求必须为 true
      reasoning: { effort: pickReasoningEffort(chatRequest) },
    };

    // 详细日志 - 可选内容预览
    const msgCount = chatRequest.messages?.length || 0;
    if (LOG_PREVIEW) {
      let firstContent = chatRequest.messages?.[0]?.content;
      if (Array.isArray(firstContent))
        firstContent = firstContent
          .map((c) => c.text || c.content || "")
          .join("");
      else if (typeof firstContent === "object")
        firstContent = JSON.stringify(firstContent);
      const firstMsgPreview = String(firstContent || "").slice(0, 50);
      console.log(
        `[Proxy] req=${requestId} ${chatRequest.model || "default"} → ${responsesRequest.model} | ${msgCount} msgs | "${firstMsgPreview}..."`,
      );
    } else {
      console.log(
        `[Proxy] req=${requestId} ${chatRequest.model || "default"} → ${responsesRequest.model} | ${msgCount} msgs`,
      );
    }

    // 调用云驿 API
    const controller = new AbortController();
    const abortUpstream = () => {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    };
    req.on("aborted", abortUpstream);
    res.on("close", () => {
      if (!res.writableEnded) abortUpstream();
    });

    const upstreamTimeout = setTimeout(
      () => controller.abort(),
      UPSTREAM_TIMEOUT_MS,
    );
    const upstreamStart = process.hrtime.bigint();
    let response;
    try {
      response = await fetch(
        `${YUNYI_CODEX_URL.replace(/\/$/, "")}/v1/responses`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${YUNYI_API_KEY}`,
            "Content-Type": "application/json",
            "OpenAI-Organization": "openai",
          },
          body: JSON.stringify(responsesRequest),
          signal: controller.signal,
        },
      );
    } finally {
      clearTimeout(upstreamTimeout);
    }
    req.upstreamDurationMs =
      Number(process.hrtime.bigint() - upstreamStart) / 1e6;
    req.upstreamStatus = response?.status;

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Proxy] req=${requestId} 上游错误 ${response.status}`);
      if (
        errorText.includes("Instructions are not valid") ||
        errorText.includes("Instructions are required")
      ) {
        return jsonResponse(res, response.status, {
          error: {
            message:
              `Upstream rejected "instructions" (当前云驿 /codex/v1/responses 可能不可用)。` +
              ` 请联系上游或提供可用的 instructions 规则后再试。`,
            type: "upstream_error",
          },
        });
      }
      return jsonResponse(res, response.status, {
        error: {
          message: `Upstream error: ${errorText.slice(0, 500)}`,
          type: "upstream_error",
        },
      });
    }

    const responseId = generateId();
    const model = responsesRequest.model;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    if (isStream) {
      // 流式响应
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const sseState = { buffer: "", dataLines: [] };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const events = consumeSse(
          sseState,
          decoder.decode(value, { stream: true }),
        );
        for (const data of events) {
          if (data === "[DONE]") {
            if (!res.writableEnded) res.write("data: [DONE]\n\n");
            continue;
          }
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === "response.output_text.delta" && parsed.delta) {
              const payload = `data: ${JSON.stringify({
                id: responseId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [
                  {
                    index: 0,
                    delta: { content: parsed.delta },
                    finish_reason: null,
                  },
                ],
              })}\n\n`;
              if (!res.writableEnded) {
                if (!res.write(payload)) await once(res, "drain");
              }
            }
            if (parsed.type === "response.completed") {
              const payload = `data: ${JSON.stringify({
                id: responseId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              })}\n\n`;
              if (!res.writableEnded) {
                if (!res.write(payload)) await once(res, "drain");
                res.write("data: [DONE]\n\n");
              }
            }
          } catch (e) {}
        }
      }
      res.end();
    } else {
      // 非流式响应
      const sseState = { buffer: "", dataLines: [] };
      let fullText = "",
        usage = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const events = consumeSse(
          sseState,
          decoder.decode(value, { stream: true }),
        );
        for (const data of events) {
          if (data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === "response.output_text.delta" && parsed.delta) {
              fullText += parsed.delta;
            }
            if (parsed.type === "response.completed" && parsed.response) {
              const extracted = extractAssistantText(parsed.response);
              if (extracted) fullText = extracted;
              if (parsed.response.usage) {
                usage = {
                  prompt_tokens: parsed.response.usage.input_tokens || 0,
                  completion_tokens: parsed.response.usage.output_tokens || 0,
                  total_tokens: parsed.response.usage.total_tokens || 0,
                };
              }
            }
          } catch (e) {}
        }
      }

      jsonResponse(res, 200, {
        id: responseId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: fullText },
            finish_reason: "stop",
          },
        ],
        usage: usage || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      });
    }
  } catch (error) {
    console.error(
      `[Proxy] req=${req.requestId || "unknown"} Error:`,
      error.message,
    );
    const status =
      error.message === "Request body too large"
        ? 413
        : error.message === "Request timeout"
          ? 408
          : error.message === "Client aborted"
            ? 499
            : error.name === "AbortError"
              ? 504
              : 500;
    if (!res.writableEnded) {
      jsonResponse(res, status, {
        error: { message: error.message, type: "internal_error" },
      });
    }
  }
}

// 创建服务器
const server = createServer(async (req, res) => {
  const { method } = req;
  let pathname = req.url || "/";
  try {
    pathname = new URL(req.url || "/", "http://localhost").pathname;
  } catch {
    // keep default
  }

  const requestId = req.headers["x-request-id"] || generateRequestId();
  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);

  const startAt = process.hrtime.bigint();
  const logAccess = () => {
    const durationMs = Number(process.hrtime.bigint() - startAt) / 1e6;
    const upstreamInfo = req.upstreamStatus
      ? ` upstream=${req.upstreamStatus} ${req.upstreamDurationMs?.toFixed(1) || 0}ms`
      : "";
    console.log(
      `[Proxy] req=${requestId} ${method} ${pathname} ${res.statusCode} ${durationMs.toFixed(1)}ms${upstreamInfo}`,
    );
  };
  res.on("finish", logAccess);
  res.on("close", () => {
    if (!res.writableEnded) logAccess();
  });

  // CORS 支持
  const origin = req.headers.origin;
  const allowOrigin = CORS_ORIGINS.includes("*")
    ? "*"
    : origin && CORS_ORIGINS.includes(origin)
      ? origin
      : "";
  if (allowOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowOrigin);
    if (allowOrigin !== "*") res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Request-Id",
  );
  res.setHeader("Access-Control-Expose-Headers", "X-Request-Id");
  res.setHeader("X-Content-Type-Options", "nosniff");

  // 处理 OPTIONS 预检请求
  if (method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // 路由
  if (method === "GET" && pathname === "/health") {
    return jsonResponse(res, 200, {
      status: "ok",
      service: "yunyi-proxy-fast",
    });
  }
  if (method === "GET" && pathname === "/ready") {
    const missing = [];
    if (!YUNYI_API_KEY) missing.push("YUNYI_API_KEY");
    if (!YUNYI_CODEX_URL) missing.push("YUNYI_CODEX_URL");
    if (!CODEX_INSTRUCTIONS)
      missing.push("CODEX_INSTRUCTIONS (check CODEX_INSTRUCTIONS_FILE)");
    if (missing.length > 0) {
      return jsonResponse(res, 503, { status: "error", missing });
    }
    return jsonResponse(res, 200, {
      status: "ok",
      service: "yunyi-proxy-fast",
    });
  }
  if (method === "GET" && pathname === "/v1/models") {
    return jsonResponse(res, 200, {
      object: "list",
      data: [
        { id: "gpt-5.2", object: "model", owned_by: "yunyi" },
        { id: "gpt-5.2-codex", object: "model", owned_by: "yunyi" },
      ],
    });
  }
  if (method === "POST" && pathname === "/v1/chat/completions") {
    return handleChatCompletions(req, res);
  }

  // 404
  jsonResponse(res, 404, {
    error: { message: "Not found", type: "not_found" },
  });
});

// 错误处理
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n❌ 端口 ${PORT} 已被占用！\n`);
    console.error("解决方法:");
    console.error(`  1. 停止占用进程: lsof -ti:${PORT} | xargs kill -9`);
    console.error(`  2. 或使用其他端口: PROXY_PORT=3457 npm run fast\n`);
    process.exit(1);
  }
  console.error("[Proxy] 服务器错误:", err);
});

// 优雅关闭
const sockets = new Set();
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});

const shutdown = (signal) => {
  console.log(`\n[Proxy] 收到 ${signal}，正在关闭...`);
  server.close(() => {
    console.log("[Proxy] 已关闭");
    process.exit(0);
  });
  setTimeout(() => {
    for (const socket of sockets) socket.destroy();
  }, FORCE_SHUTDOWN_MS).unref();
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// 捕获未处理的异常
process.on("uncaughtException", (err) => {
  console.error("[Proxy] 未捕获的异常:", err.message);
});

process.on("unhandledRejection", (reason) => {
  console.error("[Proxy] 未处理的 Promise 拒绝:", reason);
});

// 获取本机 IP
function getLocalIP() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "localhost";
}

// 默认仅绑定本机，避免局域网滥用
const HOST = config.PROXY_HOST || process.env.PROXY_HOST || "127.0.0.1";
const LOCAL_IP = getLocalIP();

server.listen(PORT, HOST, () => {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  云驿 API 二次中转代理 (高性能版)");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  本地端点:   http://localhost:${PORT}/v1`);
  console.log(`  远程端点:   http://${LOCAL_IP}:${PORT}/v1`);
  console.log(`  上游服务:   ${YUNYI_CODEX_URL}`);
  const maskedKey = YUNYI_API_KEY
    ? `${YUNYI_API_KEY.slice(0, 4)}...${YUNYI_API_KEY.slice(-4)}`
    : "(未设置)";
  console.log(`  云驿 Key:   ${maskedKey}`);
  console.log(
    `  运行时:     ${typeof Bun !== "undefined" ? "Bun 🚀" : "Node.js"}`,
  );
  console.log("");
  console.log("  在 Cursor/其他工具中配置:");
  console.log(`    Base URL: http://${LOCAL_IP}:${PORT}/v1`);
  console.log(`    API Key:  任意值 (代理会使用上面的云驿 Key)`);
  console.log("");
  console.log("  按 Ctrl+C 停止");
  console.log("═══════════════════════════════════════════════════════");
});
