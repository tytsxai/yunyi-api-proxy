/**
 * Claude CLI → Codex API 代理服务
 *
 * 将 Anthropic Messages API 请求转换为云驿 Codex Responses API（默认）
 * 同时支持回退为“直通 Claude 上游”（可选）
 */

import { createServer } from 'http';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { networkInterfaces, homedir } from 'os';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 加载配置
function loadConfig() {
    const config = {};
    try {
        const envPaths = [resolve(__dirname, '../.env'), resolve(__dirname, '../.env.local')];
        for (const envPath of envPaths) {
            try {
                const content = readFileSync(envPath, 'utf-8');
                for (const line of content.split('\n')) {
                    const match = line.match(/^([^#=]+)=(.*)$/);
                    if (match) {
                        const key = match[1].trim();
                        const value = match[2].trim().replace(/^["']|["']$/g, '');
                        config[key] = value;
                    }
                }
            } catch (e) {}
        }
    } catch (e) {}
    return config;
}

const config = loadConfig();

// Codex 代理配置
const CODEX_UPSTREAM_URL = config.CODEX_UPSTREAM_URL || process.env.CODEX_UPSTREAM_URL || 'https://yunyi.cfd/codex';
const CODEX_API_KEY = config.YUNYI_API_KEY || process.env.YUNYI_API_KEY || config.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
const CODEX_MODEL = config.CODEX_MODEL || process.env.CODEX_MODEL || 'gpt-5.2-codex';
const CODEX_REASONING = config.CODEX_REASONING || process.env.CODEX_REASONING || 'medium';
const CODEX_INSTRUCTIONS_FILE =
    config.CODEX_INSTRUCTIONS_FILE ||
    process.env.CODEX_INSTRUCTIONS_FILE ||
    resolve(__dirname, './codex-prompt.md');
const CLAUDE_PROXY_MODE = (config.CLAUDE_PROXY_MODE || process.env.CLAUDE_PROXY_MODE || 'codex').toLowerCase();
const CLAUDE_UPSTREAM_URL =
    config.CLAUDE_UPSTREAM_URL ||
    process.env.CLAUDE_UPSTREAM_URL ||
    'https://code.newcli.com/claude/aws';
const CLAUDE_AUTH_TOKEN =
    config.CLAUDE_AUTH_TOKEN ||
    process.env.CLAUDE_AUTH_TOKEN ||
    process.env.ANTHROPIC_AUTH_TOKEN;
const PORT = parseInt(config.CLAUDE_PROXY_PORT || process.env.CLAUDE_PROXY_PORT || '3457', 10);
const HOST = config.CLAUDE_PROXY_HOST || process.env.CLAUDE_PROXY_HOST || '127.0.0.1';
const UPSTREAM_TIMEOUT_MS = parseInt(config.UPSTREAM_TIMEOUT_MS || '120000', 10);
const MAX_BODY_BYTES = parseInt(config.MAX_BODY_BYTES || process.env.MAX_BODY_BYTES || '1048576', 10);
const READ_TIMEOUT_MS = parseInt(config.READ_TIMEOUT_MS || process.env.READ_TIMEOUT_MS || '15000', 10);
const CLAUDE_CODE_COMPAT = !['0', 'false', 'off'].includes(
    String(config.CLAUDE_CODE_COMPAT || process.env.CLAUDE_CODE_COMPAT || '1').toLowerCase()
);
const CLAUDE_PROXY_DEBUG = ['1', 'true', 'yes', 'on'].includes(
    String(config.CLAUDE_PROXY_DEBUG || process.env.CLAUDE_PROXY_DEBUG || '').toLowerCase()
);
// 0 / empty = unlimited (do not limit concurrency)
// Claude Code/codeagent-wrapper 可能会产生大量并发子请求。
// 这里提供“可选并发上限”，用于在上游出现 429 时做运维侧的闸门止血：
// - 0 表示不限制（默认，不改变现有并发行为）
// - >0 表示同一时刻最多 N 个上游请求在进行（更稳，但可能降低吞吐）
const CLAUDE_PROXY_MAX_CONCURRENCY = (() => {
    const raw = config.CLAUDE_PROXY_MAX_CONCURRENCY || process.env.CLAUDE_PROXY_MAX_CONCURRENCY || '0';
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n;
})();
const CLAUDE_PROXY_RETRY_429 = !['0', 'false', 'off'].includes(
    String(config.CLAUDE_PROXY_RETRY_429 || process.env.CLAUDE_PROXY_RETRY_429 || '1').toLowerCase()
);
const CLAUDE_PROXY_MAX_RETRIES = Math.max(
    0,
    parseInt(config.CLAUDE_PROXY_MAX_RETRIES || process.env.CLAUDE_PROXY_MAX_RETRIES || '3', 10) || 3
);
const CLAUDE_PROXY_TOOL_PAYLOAD = String(
    config.CLAUDE_PROXY_TOOL_PAYLOAD || process.env.CLAUDE_PROXY_TOOL_PAYLOAD || 'truncate'
).toLowerCase(); // full | truncate | none
const CLAUDE_PROXY_TOOL_PAYLOAD_MAX_CHARS = Math.max(
    0,
    parseInt(config.CLAUDE_PROXY_TOOL_PAYLOAD_MAX_CHARS || process.env.CLAUDE_PROXY_TOOL_PAYLOAD_MAX_CHARS || '800', 10) || 800
);

let CODEX_INSTRUCTIONS = '';
try {
    CODEX_INSTRUCTIONS = readFileSync(CODEX_INSTRUCTIONS_FILE, 'utf-8');
} catch (e) {}

const generateRequestId = () => `req_${randomUUID?.() || Math.random().toString(36).slice(2)}`;
const ALLOWED_CODEX_MODELS = new Set(['gpt-5.2', 'gpt-5.2-codex']);
const ALLOWED_REASONING = new Set(['low', 'medium', 'high', 'xhigh']);

function createSemaphore(max) {
    let inFlight = 0;
    const waiters = [];
    const acquire = () =>
        new Promise((resolve) => {
            if (inFlight < max) {
                inFlight += 1;
                return resolve();
            }
            waiters.push(resolve);
        });
    const release = () => {
        inFlight = Math.max(0, inFlight - 1);
        const next = waiters.shift();
        if (next) {
            inFlight += 1;
            next();
        }
    };
    return { acquire, release, getInFlight: () => inFlight };
}

// 用于可选并发闸门：默认 no-op（不限制并发），仅在显式配置上限时启用。
const upstreamSemaphore =
    CLAUDE_PROXY_MAX_CONCURRENCY > 0
        ? createSemaphore(CLAUDE_PROXY_MAX_CONCURRENCY)
        : { acquire: async () => {}, release: () => {}, getInFlight: () => 0 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jitteredBackoffMs(attempt, base = 500, cap = 8000) {
    const exp = Math.min(cap, base * Math.pow(2, Math.max(0, attempt - 1)));
    const jitter = Math.floor(Math.random() * Math.min(250, exp));
    return exp + jitter;
}

function pickUpstreamModel(anthropicModel) {
    if (typeof anthropicModel === 'string' && ALLOWED_CODEX_MODELS.has(anthropicModel)) return anthropicModel;
    return CODEX_MODEL;
}

function sanitizeToolName(name) {
    const raw = String(name || '').trim();
    if (!raw) return '';
    // OpenAI function name is fairly strict; keep common Claude tool names as-is.
    // Replace unsupported chars with underscore.
    return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function mapAnthropicToolsToResponsesTools(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return [];
    const mapped = [];
    for (const tool of tools) {
        if (!tool || typeof tool !== 'object') continue;
        const name = sanitizeToolName(tool.name);
        if (!name) continue;
        const description = typeof tool.description === 'string' ? tool.description : '';
        const parameters =
            (tool.input_schema && typeof tool.input_schema === 'object') ? tool.input_schema :
            (tool.inputSchema && typeof tool.inputSchema === 'object') ? tool.inputSchema :
            { type: 'object', properties: {} };
        // Responses API tool shape: { type: "function", name, description, parameters }
        mapped.push({ type: 'function', name, description, parameters });
    }
    return mapped;
}

function pickToolChoice(request) {
    // Anthropic tool_choice examples:
    // - { "type": "auto" }
    // - { "type": "tool", "name": "Bash" }
    // OpenAI tool_choice examples:
    // - "auto" | "none"
    // - { type: "function", function: { name: "..." } }
    const tc = request?.tool_choice || request?.toolChoice;
    if (!tc) return undefined;
    if (typeof tc === 'string') return tc;
    if (tc && typeof tc === 'object') {
        const type = tc.type;
        if (type === 'auto' || type === 'none') return type;
        if (type === 'tool' && typeof tc.name === 'string' && tc.name.trim()) {
            return { type: 'function', name: sanitizeToolName(tc.name) };
        }
        if (type === 'function' && typeof tc.name === 'string' && tc.name.trim()) {
            return { type: 'function', name: sanitizeToolName(tc.name) };
        }
    }
    return undefined;
}

function pickReasoningEffort(request) {
    const raw =
        request?.metadata?.reasoning_effort ??
        request?.metadata?.reasoningEffort ??
        request?.metadata?.reasoning ??
        request?.reasoning_effort ??
        request?.reasoningEffort;
    if (typeof raw === 'string' && ALLOWED_REASONING.has(raw)) return raw;
    return CODEX_REASONING;
}

function readClaudeCliTokenFromSettings() {
    try {
        const settingsPath = resolve(homedir(), '.claude/settings.json');
        const raw = readFileSync(settingsPath, 'utf-8');
        const parsed = JSON.parse(raw);
        const token = parsed?.env?.ANTHROPIC_AUTH_TOKEN;
        if (typeof token === 'string' && token.trim()) return token.trim();
    } catch (e) {}
    return undefined;
}

function getClaudeAuthToken() {
    if (typeof CLAUDE_AUTH_TOKEN === 'string' && CLAUDE_AUTH_TOKEN.trim()) return CLAUDE_AUTH_TOKEN.trim();
    const fromSettings = readClaudeCliTokenFromSettings();
    if (typeof fromSettings === 'string' && fromSettings.trim()) return fromSettings.trim();
    return undefined;
}

// JSON 响应
const jsonResponse = (res, status, data) => {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(data));
};

// 读取请求体
const readBody = (req) => new Promise((resolve, reject) => {
    let body = '';
    let total = 0;
    req.setEncoding('utf8');
    const timeout = setTimeout(() => {
        req.destroy();
        reject(new Error('Request timeout'));
    }, READ_TIMEOUT_MS);

    req.on('data', chunk => {
        total += Buffer.byteLength(chunk);
        if (total > MAX_BODY_BYTES) {
            clearTimeout(timeout);
            req.destroy();
            return reject(new Error('Request body too large'));
        }
        body += chunk;
    });
    req.on('end', () => { clearTimeout(timeout); resolve(body); });
    req.on('error', err => { clearTimeout(timeout); reject(err); });
    req.on('aborted', () => { clearTimeout(timeout); reject(new Error('Client aborted')); });
});

// SSE 数据解析（支持 \r\n 和多行 data）
function consumeSse(state, chunk) {
    state.buffer += chunk;
    state.buffer = state.buffer.replace(/\r\n/g, '\n');
    const lines = state.buffer.split('\n');
    state.buffer = lines.pop() || '';
    const events = [];

    for (const line of lines) {
        if (line === '') {
            if (state.dataLines.length > 0) {
                events.push(state.dataLines.join('\n'));
                state.dataLines = [];
            }
            continue;
        }
        if (line.startsWith('data:')) {
            state.dataLines.push(line.slice(5).trimStart());
        }
    }
    return events;
}

function stripHookNoise(text) {
    if (!text) return '';
    const raw = String(text);

    // 1) claude-mem 等 hooks 会输出控制 JSON（如 {"continue":true,"suppressOutput":true}）。
    // 2) 某些 wrapper/worker 也会把日志写到 stdout，最终可能“穿透”进 UI。
    // 说明：这不是协议层“严格过滤”（那样可能误伤正常输出），而是针对已观测到的“明显控制噪声”做降噪。
    const lines = raw.split('\n');
    const kept = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
            kept.push(line);
            continue;
        }

        // JSON 控制对象（尽量只杀“明显是 hook 控制输出”的）
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
            if (trimmed.includes('"suppressOutput"') || trimmed.includes('"hookSpecificOutput"')) continue;
            if (trimmed.includes('"continue"') && trimmed.includes('"suppressOutput"')) continue;
        }

        // wrapper 日志（claude-mem 里有 [wrapper] 前缀）
        if (/\[wrapper\]/i.test(trimmed)) continue;

        kept.push(line);
    }
    return kept.join('\n').replace(/\n{4,}/g, '\n\n\n');
}

// Claude 消息格式 → OpenAI 消息格式
function stringifyClaudeContentParts(parts) {
    if (!Array.isArray(parts)) return '';
    const chunks = [];

    for (const part of parts) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'text') {
            if (typeof part.text === 'string' && part.text) chunks.push(stripHookNoise(part.text));
            continue;
        }

        // Claude Code 会在 messages 里塞 tool_use/tool_result。
        // 设计权衡：
        // - 丢弃：UI 更干净，但模型会“忘记刚刚做了什么工具动作”，导致续聊/回合衔接变差。
        // - 文本化保留：连续对话更稳，但可能出现“结构/JSON 泄漏”污染 UI（尤其是 TodoWrite）。
        // 本项目默认保留但截断；如希望彻底杜绝 UI 泄漏，用 CLAUDE_PROXY_TOOL_PAYLOAD=none。
        if (part.type === 'tool_use') {
            const id = part.id ? String(part.id) : '';
            const name = part.name ? String(part.name) : '';
            let input = '';
            if (CLAUDE_PROXY_TOOL_PAYLOAD !== 'none') {
                try {
                    input = part.input !== undefined ? JSON.stringify(part.input) : '';
                } catch (e) {
                    input = '';
                }
                if (CLAUDE_PROXY_TOOL_PAYLOAD === 'truncate' && input.length > CLAUDE_PROXY_TOOL_PAYLOAD_MAX_CHARS) {
                    input = input.slice(0, CLAUDE_PROXY_TOOL_PAYLOAD_MAX_CHARS) + '…';
                }
            }
            chunks.push(
                `[tool_use${id ? ` id=${id}` : ''}${name ? ` name=${name}` : ''}${input ? ` input=${input}` : ''}]`
            );
            continue;
        }

        if (part.type === 'tool_result') {
            const toolUseId = part.tool_use_id ? String(part.tool_use_id) : '';
            const isError = part.is_error === true;
            let resultText = '';
            if (typeof part.content === 'string') {
                resultText = part.content;
            } else if (Array.isArray(part.content)) {
                resultText = part.content
                    .filter(p => p && p.type === 'text' && typeof p.text === 'string')
                    .map(p => p.text)
                    .join('\n');
            } else if (part.content && typeof part.content === 'object') {
                try {
                    resultText = JSON.stringify(part.content);
                } catch (e) {}
            }
            resultText = stripHookNoise(resultText);
            if (CLAUDE_PROXY_TOOL_PAYLOAD === 'none') resultText = '';
            if (CLAUDE_PROXY_TOOL_PAYLOAD === 'truncate' && resultText.length > CLAUDE_PROXY_TOOL_PAYLOAD_MAX_CHARS) {
                resultText = resultText.slice(0, CLAUDE_PROXY_TOOL_PAYLOAD_MAX_CHARS) + '…';
            }
            chunks.push(
                `[tool_result${toolUseId ? ` tool_use_id=${toolUseId}` : ''}${isError ? ' is_error=true' : ''}]` +
                (resultText ? `\n${resultText}` : '')
            );
            continue;
        }

        if (part.type === 'image') {
            const source = part.source || {};
            const mediaType = source.media_type || source.mediaType || part.media_type || part.mediaType || '';
            const kind = source.type || '';
            const bytes =
                typeof source.data === 'string' ? source.data.length :
                typeof source.bytes === 'string' ? source.bytes.length :
                0;
            chunks.push(`[image${mediaType ? ` media_type=${mediaType}` : ''}${kind ? ` source=${kind}` : ''}${bytes ? ` bytes~=${bytes}` : ''}]`);
            continue;
        }

        // 其他类型（如 image 等）先以占位文本保留语义，避免彻底丢上下文
        try {
            const preview = JSON.stringify(part);
            chunks.push(`[${part.type || 'unknown_part'} omitted] ${preview.slice(0, 500)}`);
        } catch (e) {
            chunks.push(`[${part.type || 'unknown_part'} omitted]`);
        }
    }

    return chunks.join('\n');
}

function convertMessages(claudeMessages) {
    const openaiMessages = [];

    for (const msg of claudeMessages) {
        const role = msg.role === 'assistant' ? 'assistant' : 'user';
        let content = '';

        if (typeof msg.content === 'string') {
            content = msg.content;
        } else if (Array.isArray(msg.content)) {
            // 处理多部分内容（保留 tool_use/tool_result 等非 text 块）
            content = stringifyClaudeContentParts(msg.content);
        }

        openaiMessages.push({ role, content });
    }

    return openaiMessages;
}

function normalizeSystem(system) {
    if (!system) return '';
    if (typeof system === 'string') return system;
    if (Array.isArray(system)) {
        return system
            .filter(part => part && part.type === 'text')
            .map(part => part.text)
            .join('\n');
    }
    return '';
}

// Claude Code(/dev) 在 Anthropic 环境下会依赖一组“UI 工具”（如 AskUserQuestion）。
// 当这些工具没有通过 request.tools 提供给模型时，会导致工作流中止/对话体验变差。
// 为避免模型在严格工作流下“因工具缺失而中止”，这里对 system 文本做兼容性重写（仅在工具缺失时生效）：
// - 删除包含 AskUserQuestion 的强约束行
// - 明确告知：缺工具时改为直接在对话里提问并继续
function rewriteClaudeCodeSystemForCodex(systemText, availableToolNames = new Set()) {
    if (!systemText) return '';
    const raw = String(systemText);
    if (!CLAUDE_CODE_COMPAT) return raw;

    // 仅在检测到 Claude Code UI 工具/工作流约束时才启用重写，避免对普通请求增加无谓的 prompt 噪声。
    const needsShim =
        raw.includes('AskUserQuestion') ||
        raw.includes('EnterPlanMode') ||
        raw.includes('ExitPlanMode') ||
        raw.includes('SlashCommand');
    if (!needsShim) return raw;

    // 如果相关工具已经在 tools 列表里提供，就不要“降级剥离”这些约束。
    // 这样 Claude Code 可以照常执行 UI 工具（比如弹窗提问）。
    const hasAsk = availableToolNames.has('AskUserQuestion');
    const hasSlash = availableToolNames.has('SlashCommand');
    const hasEnter = availableToolNames.has('EnterPlanMode');
    const hasExit = availableToolNames.has('ExitPlanMode');
    const shouldStrip = !(hasAsk || hasSlash || hasEnter || hasExit);
    if (!shouldStrip) return raw;

    const lines = raw.split('\n');

    const filtered = [];
    for (const line of lines) {
        // Claude Code /dev 常见的硬约束点：必须使用 AskUserQuestion 询问用户，否则停止。
        // 这里直接移除相关行，避免 Codex 后端误以为必须调用不存在的工具。
        if (line.includes('AskUserQuestion')) continue;
        if (line.includes('EnterPlanMode')) continue;
        if (line.includes('ExitPlanMode')) continue;
        if (line.includes('SlashCommand')) continue;
        filtered.push(line);
    }

    const note =
        [
            '',
            '---',
            'Compatibility note (Claude Code → Codex proxy):',
            '- UI tools like AskUserQuestion/EnterPlanMode/ExitPlanMode/SlashCommand are not available here.',
            '- If you need clarification, ask the user directly in normal chat text and continue.',
            '- Tool specs may be present; do not emit tool calls unless tools are actually provided.',
        ].join('\n');

    return filtered.join('\n') + note;
}

function describeClaudeMessageContent(content) {
    if (typeof content === 'string') return { types: ['string'], approxChars: content.length };
    if (!Array.isArray(content)) return { types: ['unknown'], approxChars: 0 };
    const types = new Set();
    let approxChars = 0;
    for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        if (part.type) types.add(part.type);
        if (part.type === 'text' && typeof part.text === 'string') approxChars += part.text.length;
        if (part.type === 'tool_result' && typeof part.content === 'string') approxChars += part.content.length;
    }
    return { types: Array.from(types), approxChars };
}

// 从 Responses 格式提取文本
function extractAssistantText(responseData) {
    if (!responseData?.output) return '';
    for (const item of responseData.output) {
        if (item.type === 'message' && item.role === 'assistant' && item.content) {
            for (const c of item.content) {
                if (c.type === 'output_text' && c.text) return c.text;
            }
        }
    }
    return '';
}

function extractFunctionCallsFromResponse(responseData) {
    const calls = [];
    const output = responseData?.output;
    if (!Array.isArray(output)) return calls;
    for (const item of output) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'function_call') {
            const id = item.id ? String(item.id) : `toolu_${randomUUID()}`;
            const name = item.name ? String(item.name) : '';
            const args =
                typeof item.arguments === 'string' ? item.arguments :
                item.arguments && typeof item.arguments === 'object' ? JSON.stringify(item.arguments) :
                '';
            calls.push({ id, name, arguments: args });
        }
    }
    return calls;
}

// 文本 → Claude 响应格式
function convertResponseFromText(text, model, toolUses = []) {
    const content = [];
    if (toolUses.length > 0) {
        for (const t of toolUses) {
            const id = t.id ? String(t.id) : `toolu_${randomUUID()}`;
            const name = t.name ? String(t.name) : '';
            let input = {};
            if (t.arguments && typeof t.arguments === 'string') {
                try {
                    input = JSON.parse(t.arguments);
                } catch (e) {
                    input = { raw: t.arguments };
                }
            }
            content.push({ type: 'tool_use', id, name, input });
        }
    }
    const cleaned = stripHookNoise(text);
    if (cleaned !== undefined && cleaned !== null && String(cleaned).trim() !== '') {
        content.push({ type: 'text', text: String(cleaned) });
    }
    return {
        id: `msg_${randomUUID()}`,
        type: 'message',
        role: 'assistant',
        model: model,
        content: content.length > 0 ? content : [{ type: 'text', text: '' }],
        stop_reason: toolUses.length > 0 ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
    };
}

// 处理流式响应转换
async function handleStreamResponse(response, res, model, requestId) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });

    const msgId = `msg_${randomUUID()}`;
    let outputTokens = 0;
    let blockIndex = -1;
    let openBlockType = null; // 'text' | 'tool_use'
    let toolStopReason = null; // 'tool_use' if any tool emitted

    // 发送 message_start
    const messageStart = {
        type: 'message_start',
        message: {
            id: msgId,
            type: 'message',
            role: 'assistant',
            model: model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 }
        }
    };
    res.write(`event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const sseState = { buffer: '', dataLines: [] };
    const fnCalls = new Map(); // id -> { id, name, args }
    let activeFnId = null;

    function startTextBlockIfNeeded() {
        if (openBlockType === 'text') return;
        if (openBlockType) {
            res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: blockIndex })}\n\n`);
        }
        blockIndex += 1;
        openBlockType = 'text';
        res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } })}\n\n`);
    }

    function startToolBlock(id, name) {
        if (openBlockType) {
            res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: blockIndex })}\n\n`);
        }
        blockIndex += 1;
        openBlockType = 'tool_use';
        toolStopReason = 'tool_use';
        const toolUse = { type: 'tool_use', id, name, input: {} };
        res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: blockIndex, content_block: toolUse })}\n\n`);
    }

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const events = consumeSse(sseState, decoder.decode(value, { stream: true }));
            for (const data of events) {
                if (data === '[DONE]') continue;
                try {
                    const chunk = JSON.parse(data);
                    if (chunk.type === 'response.output_text.delta' && chunk.delta) {
                        outputTokens++;
                        startTextBlockIfNeeded();
                        const deltaEvent = {
                            type: 'content_block_delta',
                            index: blockIndex,
                            delta: { type: 'text_delta', text: chunk.delta }
                        };
                        res.write(`event: content_block_delta\ndata: ${JSON.stringify(deltaEvent)}\n\n`);
                        continue;
                    }
                    // function call start (best-effort)
                    if (chunk.type === 'response.output_item.added' && chunk.item && chunk.item.type === 'function_call') {
                        const id = chunk.item.id ? String(chunk.item.id) : `toolu_${randomUUID()}`;
                        const name = chunk.item.name ? String(chunk.item.name) : '';
                        fnCalls.set(id, { id, name, args: '' });
                        activeFnId = id;
                        startToolBlock(id, name);
                        continue;
                    }
                    // function call args delta (best-effort)
                    if ((chunk.type === 'response.function_call_arguments.delta' || chunk.type === 'response.output_item.delta') && chunk.delta) {
                        if (!activeFnId) continue;
                        const rec = fnCalls.get(activeFnId);
                        if (!rec) continue;
                        rec.args += String(chunk.delta);
                        if (openBlockType !== 'tool_use') startToolBlock(rec.id, rec.name);
                        const deltaEvent = {
                            type: 'content_block_delta',
                            index: blockIndex,
                            delta: { type: 'input_json_delta', partial_json: String(chunk.delta) }
                        };
                        res.write(`event: content_block_delta\ndata: ${JSON.stringify(deltaEvent)}\n\n`);
                        continue;
                    }
                    // function call done (best-effort)
                    if (chunk.type === 'response.output_item.done' && chunk.item && chunk.item.type === 'function_call') {
                        const id = chunk.item.id ? String(chunk.item.id) : activeFnId;
                        const name = chunk.item.name ? String(chunk.item.name) : (fnCalls.get(id)?.name || '');
                        const args =
                            typeof chunk.item.arguments === 'string' ? chunk.item.arguments :
                            chunk.item.arguments && typeof chunk.item.arguments === 'object' ? JSON.stringify(chunk.item.arguments) :
                            '';
                        if (id) {
                            const rec = fnCalls.get(id) || { id, name, args: '' };
                            if (args) rec.args = args;
                            fnCalls.set(id, rec);
                        }
                        // close tool block; next text will open new block
                        if (openBlockType === 'tool_use') {
                            res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: blockIndex })}\n\n`);
                            openBlockType = null;
                        }
                        activeFnId = null;
                        continue;
                    }
                } catch (e) {}
            }
        }
    } catch (error) {
        console.error(`[Codex] req=${requestId} stream error:`, error.message);
    }

    // 关闭最后一个 block（如果有）
    if (openBlockType) {
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: blockIndex })}\n\n`);
        openBlockType = null;
    }

    // 发送 message_delta
    const messageDelta = {
        type: 'message_delta',
        delta: { stop_reason: toolStopReason || 'end_turn', stop_sequence: null },
        usage: { output_tokens: outputTokens }
    };
    res.write(`event: message_delta\ndata: ${JSON.stringify(messageDelta)}\n\n`);

    // 发送 message_stop
    res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);

    res.end();
}

// 处理 Anthropic Messages API → Codex API
async function handleMessages(req, res) {
    const requestId = generateRequestId();
    res.setHeader('X-Request-Id', requestId);

    try {
        const body = await readBody(req);
        let request;
        try {
            request = JSON.parse(body);
        } catch (e) {
            return jsonResponse(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON' } });
        }
        if (CLAUDE_PROXY_DEBUG) {
            const msgs = Array.isArray(request?.messages) ? request.messages : [];
            const types = msgs.slice(-8).map((m) => ({
                role: m?.role,
                ...describeClaudeMessageContent(m?.content),
            }));
            console.log(`[Debug] req=${requestId} mode=${CLAUDE_PROXY_MODE} compat=${CLAUDE_CODE_COMPAT} messages=${msgs.length} tail=${JSON.stringify(types)}`);
        }

        // 模式 A：直通 Claude 上游（不做协议转换）
        if (CLAUDE_PROXY_MODE === 'claude') {
            const token = getClaudeAuthToken();
            if (!token) {
                return jsonResponse(res, 500, { type: 'error', error: { type: 'api_error', message: 'CLAUDE_AUTH_TOKEN not configured' } });
            }

            const isStream = request.stream ?? false;
            console.log(`[Claude] req=${requestId} upstream=${CLAUDE_UPSTREAM_URL} stream=${isStream}`);

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
            let response;
            try {
                response = await fetch(`${CLAUDE_UPSTREAM_URL.replace(/\/$/, '')}/v1/messages`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': token,
                        'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
                    },
                    body: JSON.stringify(request),
                    signal: controller.signal,
                });
            } finally {
                clearTimeout(timeout);
            }

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`[Claude] req=${requestId} upstream error ${response.status}: ${errorText.slice(0, 200)}`);
                return jsonResponse(res, response.status, { type: 'error', error: { type: 'api_error', message: errorText.slice(0, 500) } });
            }

            if (isStream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream; charset=utf-8',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                });
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const chunk = decoder.decode(value, { stream: true });
                    if (!res.writableEnded) res.write(chunk);
                }
                res.end();
            } else {
                const data = await response.json();
                jsonResponse(res, 200, data);
            }

            console.log(`[Claude] req=${requestId} completed`);
            return;
        }

        if (!CODEX_API_KEY) {
            return jsonResponse(res, 500, { type: 'error', error: { type: 'api_error', message: 'YUNYI_API_KEY not configured' } });
        }
        if (!CODEX_INSTRUCTIONS) {
            return jsonResponse(res, 500, {
                type: 'error',
                error: {
                    type: 'api_error',
                    message: `CODEX_INSTRUCTIONS not loaded (check CODEX_INSTRUCTIONS_FILE=${CODEX_INSTRUCTIONS_FILE})`
                }
            });
        }

        const isStream = request.stream ?? false;
        const requestedModel = request.model || 'gpt-5.2-codex';
        const upstreamModel = pickUpstreamModel(requestedModel);
        const reasoningEffort = pickReasoningEffort(request);
        console.log(`[Codex] req=${requestId} requested_model=${requestedModel} upstream_model=${upstreamModel} reasoning=${reasoningEffort} stream=${isStream}`);

        const responsesTools = mapAnthropicToolsToResponsesTools(request.tools || request?.tool_schema || request?.toolSchema || []);
        const toolNames = new Set(responsesTools.map(t => t?.name).filter(Boolean));
        const toolChoice = pickToolChoice(request);

        // 转换请求格式 (Anthropic Messages → Responses API)
        const openaiMessages = convertMessages(request.messages || []);
        const filteredInput = openaiMessages.map(m => ({ type: 'message', role: m.role, content: m.content || '' }));

        // 云驿 Codex 禁止 input 里出现 system role，这里将 system prompt 降级为 user 前缀
        const systemText = rewriteClaudeCodeSystemForCodex(normalizeSystem(request.system), toolNames);
        if (systemText) {
            const prefix = `SYSTEM:\\n${systemText}\\n\\n`;
            if (filteredInput.length > 0 && filteredInput[0].role === 'user') {
                filteredInput[0].content = prefix + (filteredInput[0].content || '');
            } else {
                filteredInput.unshift({ type: 'message', role: 'user', content: prefix.trimEnd() });
            }
        }

        const responsesRequest = {
            model: upstreamModel,
            input: filteredInput.length > 0 ? filteredInput : [{ type: 'message', role: 'user', content: '' }],
            stream: true, // 云驿要求必须为 true
            instructions: CODEX_INSTRUCTIONS,
            reasoning: { effort: reasoningEffort },
        };
        if (responsesTools.length > 0) responsesRequest.tools = responsesTools;
        if (toolChoice) responsesRequest.tool_choice = toolChoice;

        // 转发到 Codex
        async function fetchCodexOnce(payload) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
            try {
                return await fetch(`${CODEX_UPSTREAM_URL.replace(/\/$/, '')}/v1/responses`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${CODEX_API_KEY}`,
                        'OpenAI-Organization': 'openai',
                    },
                    body: JSON.stringify(payload),
                    signal: controller.signal,
                });
            } finally {
                clearTimeout(timeout);
            }
        }

        async function fetchCodex(payload) {
            let lastErrText = '';
            const maxAttempts = Math.max(1, CLAUDE_PROXY_MAX_RETRIES + 1);
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                const resp = await fetchCodexOnce(payload);
                if (resp.ok) return { response: resp, errorText: '' };

                const status = resp.status;
                const text = await resp.text().catch(() => '');
                lastErrText = text;

                const is429 = status === 429;
                const isRetryable = (status >= 500 && status <= 599) || is429;
                const canRetry = attempt < maxAttempts;
                const shouldRetry = isRetryable && canRetry && (CLAUDE_PROXY_RETRY_429 || !is429);

                if (!shouldRetry) {
                    return { response: resp, errorText: text };
                }

                const delay = jitteredBackoffMs(attempt);
                console.warn(`[Codex] req=${requestId} retrying status=${status} attempt=${attempt}/${maxAttempts} wait=${delay}ms`);
                await sleep(delay);
            }

            // 理论上走不到这里；兜底构造一个失败响应形态
            return { response: new Response(lastErrText || 'Upstream error', { status: 502 }), errorText: lastErrText || 'Upstream error' };
        }

        // 限制并发，避免 429（特别是 codeagent-wrapper 多子任务并行）
        await upstreamSemaphore.acquire();
        let response;
        let errorText = '';
        try {
            const first = await fetchCodex(responsesRequest);
            response = first.response;
            errorText = first.errorText || '';
            if (!response.ok) {
                console.error(`[Codex] req=${requestId} upstream error ${response.status}: ${errorText.slice(0, 200)}`);

                const mayBeToolsUnsupported =
                    (responsesRequest.tools && errorText.includes('tools')) ||
                    (responsesRequest.tool_choice && (errorText.includes('tool_choice') || errorText.includes('tool choice')));
                if (mayBeToolsUnsupported && (responsesRequest.tools || responsesRequest.tool_choice)) {
                    // 自动降级：某些上游/网关可能暂不支持 tools/tool_choice 参数
                    const retryPayload = { ...responsesRequest };
                    delete retryPayload.tools;
                    delete retryPayload.tool_choice;
                    console.warn(`[Codex] req=${requestId} retrying without tools/tool_choice`);
                    const retry = await fetchCodex(retryPayload);
                    if (retry.response.ok) {
                        response = retry.response;
                        errorText = '';
                    } else {
                        const retryErr = retry.errorText || '';
                        console.error(`[Codex] req=${requestId} retry error ${retry.response.status}: ${retryErr.slice(0, 200)}`);
                        // 保持原始错误返回（更贴近用户请求）
                    }
                }

                if (!response.ok) {
                    if (errorText.includes('Instructions are not valid') || errorText.includes('Instructions are required')) {
                        return jsonResponse(res, response.status, {
                            type: 'error',
                            error: {
                                type: 'api_error',
                                message:
                                    `Codex upstream rejected "instructions" (当前云驿 /codex/v1/responses 可能不可用)。` +
                                    ` 可临时切换为直通模式: 在 .env 设置 CLAUDE_PROXY_MODE=claude，并配置 CLAUDE_UPSTREAM_URL/CLAUDE_AUTH_TOKEN。`
                            }
                        });
                    }
                    return jsonResponse(res, response.status, { type: 'error', error: { type: 'api_error', message: errorText.slice(0, 500) } });
                }
            }

            if (isStream) {
                await handleStreamResponse(response, res, requestedModel, requestId);
            } else {
                // 非流式：上游仍然以 SSE 返回，收集所有 delta
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                const sseState = { buffer: '', dataLines: [] };
                let fullText = '';
                const fnCalls = new Map(); // id -> { id, name, args }
                let activeFnId = null;

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const events = consumeSse(sseState, decoder.decode(value, { stream: true }));
                    for (const data of events) {
                        if (data === '[DONE]') continue;
                        try {
                            const chunk = JSON.parse(data);
                            if (chunk.type === 'response.output_text.delta' && chunk.delta) {
                                fullText += chunk.delta;
                            }
                            if (chunk.type === 'response.output_item.added' && chunk.item && chunk.item.type === 'function_call') {
                                const id = chunk.item.id ? String(chunk.item.id) : `toolu_${randomUUID()}`;
                                const name = chunk.item.name ? String(chunk.item.name) : '';
                                fnCalls.set(id, { id, name, args: '' });
                                activeFnId = id;
                            }
                            if ((chunk.type === 'response.function_call_arguments.delta' || chunk.type === 'response.output_item.delta') && chunk.delta) {
                                if (!activeFnId) continue;
                                const rec = fnCalls.get(activeFnId);
                                if (!rec) continue;
                                rec.args += String(chunk.delta);
                            }
                            if (chunk.type === 'response.output_item.done' && chunk.item && chunk.item.type === 'function_call') {
                                const id = chunk.item.id ? String(chunk.item.id) : activeFnId;
                                const name = chunk.item.name ? String(chunk.item.name) : (id ? (fnCalls.get(id)?.name || '') : '');
                                const args =
                                    typeof chunk.item.arguments === 'string' ? chunk.item.arguments :
                                    chunk.item.arguments && typeof chunk.item.arguments === 'object' ? JSON.stringify(chunk.item.arguments) :
                                    '';
                                if (id) {
                                    const rec = fnCalls.get(id) || { id, name, args: '' };
                                    if (name) rec.name = name;
                                    if (args) rec.args = args;
                                    fnCalls.set(id, rec);
                                }
                                activeFnId = null;
                            }
                            if (chunk.type === 'response.completed' && chunk.response) {
                                const extracted = extractAssistantText(chunk.response);
                                if (extracted) fullText = extracted;
                                for (const fc of extractFunctionCallsFromResponse(chunk.response)) {
                                    if (!fc?.id) continue;
                                    const rec = fnCalls.get(fc.id) || { id: fc.id, name: fc.name || '', args: '' };
                                    if (fc.name) rec.name = fc.name;
                                    if (fc.arguments) rec.args = fc.arguments;
                                    fnCalls.set(fc.id, rec);
                                }
                            }
                        } catch (e) {}
                    }
                }

                const toolUses = Array.from(fnCalls.values()).map(r => ({ id: r.id, name: r.name, arguments: r.args }));
                const claudeResponse = convertResponseFromText(fullText, requestedModel, toolUses);
                jsonResponse(res, 200, claudeResponse);
            }
        } catch (e) {
            throw e;
        } finally {
            upstreamSemaphore.release();
        }

        console.log(`[Codex] req=${requestId} completed`);
    } catch (error) {
        console.error(`[Codex] req=${requestId} error:`, error.message);
        if (!res.writableEnded) {
            jsonResponse(res, 500, { type: 'error', error: { type: 'api_error', message: error.message } });
        }
    }
}

// 创建服务器
const server = createServer(async (req, res) => {
    const { method } = req;
    let pathname = '/';
    try { pathname = new URL(req.url || '/', 'http://localhost').pathname; } catch {}

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version');

    if (method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    // 路由
    if (method === 'GET' && pathname === '/health') {
        return jsonResponse(res, 200, {
            status: 'ok',
            service: 'claude-to-codex-proxy',
            mode: CLAUDE_PROXY_MODE,
            model: CODEX_MODEL,
            reasoning: CODEX_REASONING
        });
    }
    if (method === 'GET' && pathname === '/ready') {
        const missing = [];
        if (CLAUDE_PROXY_MODE === 'claude') {
            const token = getClaudeAuthToken();
            if (!CLAUDE_UPSTREAM_URL) missing.push('CLAUDE_UPSTREAM_URL');
            if (!token) missing.push('CLAUDE_AUTH_TOKEN (or ~/.claude/settings.json env.ANTHROPIC_AUTH_TOKEN)');
        } else {
            if (!CODEX_API_KEY) missing.push('YUNYI_API_KEY');
            if (!CODEX_UPSTREAM_URL) missing.push('CODEX_UPSTREAM_URL');
            if (!CODEX_INSTRUCTIONS) missing.push('CODEX_INSTRUCTIONS (check CODEX_INSTRUCTIONS_FILE)');
        }
        if (missing.length > 0) {
            return jsonResponse(res, 503, {
                status: 'error',
                service: 'claude-to-codex-proxy',
                mode: CLAUDE_PROXY_MODE,
                missing,
            });
        }
        return jsonResponse(res, 200, { status: 'ok', service: 'claude-to-codex-proxy', mode: CLAUDE_PROXY_MODE });
    }

    if (method === 'POST' && pathname === '/v1/messages') {
        return handleMessages(req, res);
    }

    jsonResponse(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'Not found' } });
});

// 获取本机 IP
function getLocalIP() {
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) return net.address;
        }
    }
    return 'localhost';
}

server.listen(PORT, HOST, () => {
    console.log('═══════════════════════════════════════════════════════');
    console.log('  Claude CLI 代理服务');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`  本地端点:   http://localhost:${PORT}/v1`);
    console.log(`  模式:       ${CLAUDE_PROXY_MODE}`);
    console.log(`  Compat:     ${CLAUDE_CODE_COMPAT ? 'on' : 'off'} (CLAUDE_CODE_COMPAT)`);
    console.log(`  Debug:      ${CLAUDE_PROXY_DEBUG ? 'on' : 'off'} (CLAUDE_PROXY_DEBUG)`);
    if (CLAUDE_PROXY_MODE === 'claude') {
        console.log(`  上游服务:   ${CLAUDE_UPSTREAM_URL}`);
        const masked = CLAUDE_AUTH_TOKEN ? `${CLAUDE_AUTH_TOKEN.slice(0, 8)}...` : '(未设置)';
        console.log(`  Auth Token: ${masked}`);
    } else {
        console.log(`  上游服务:   ${CODEX_UPSTREAM_URL}`);
        console.log(`  Codex 模型: ${CODEX_MODEL}`);
        console.log(`  推理等级:   ${CODEX_REASONING}`);
        const masked = CODEX_API_KEY ? `${CODEX_API_KEY.slice(0, 8)}...` : '(未设置)';
        console.log(`  API Key:    ${masked}`);
    }
    console.log('');
    console.log('  Claude CLI 配置:');
    console.log(`    ANTHROPIC_BASE_URL=http://localhost:${PORT}`);
    console.log('');
    console.log('  按 Ctrl+C 停止');
    console.log('═══════════════════════════════════════════════════════');
});

process.on('SIGINT', () => { console.log('\n[Codex] 正在关闭...'); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { console.log('\n[Codex] 正在关闭...'); server.close(() => process.exit(0)); });
