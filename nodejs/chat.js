/**
 * Node.js 聊天示例 - 使用云驿二次中转代理
 */

import OpenAI from 'openai';

// 配置 - 使用本地代理
const PROXY_URL = process.env.PROXY_URL || 'http://localhost:3456/v1';
const MODEL = 'gpt-4'; // 任意模型名，代理会自动转换

// 创建客户端 - 连接本地代理
const client = new OpenAI({
    apiKey: 'any-key', // 代理使用 .env 中的云驿激活码
    baseURL: PROXY_URL,
});

async function chat(message) {
    const response = await client.chat.completions.create({
        model: MODEL,
        messages: [
            { role: 'system', content: '你是一个有用的助手。' },
            { role: 'user', content: message }
        ],
        temperature: 0.7,
        max_tokens: 2000,
    });
    return response.choices[0].message.content;
}

async function streamChat(message) {
    const stream = await client.chat.completions.create({
        model: MODEL,
        messages: [
            { role: 'system', content: '你是一个有用的助手。' },
            { role: 'user', content: message }
        ],
        stream: true,
    });

    for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || '';
        process.stdout.write(content);
    }
    console.log();
}

async function main() {
    console.log('='.repeat(50));
    console.log('云驿 API 聊天测试 (通过本地代理)');
    console.log('='.repeat(50));
    console.log(`代理地址: ${PROXY_URL}`);
    console.log(`请求模型: ${MODEL}`);
    console.log('='.repeat(50));

    // 非流式测试
    console.log('\n--- 非流式调用 ---');
    const question1 = '1+1=?';
    console.log(`问: ${question1}`);
    const answer1 = await chat(question1);
    console.log(`答: ${answer1}`);

    // 流式测试
    console.log('\n--- 流式调用 ---');
    const question2 = '用一句话解释什么是 JavaScript';
    console.log(`问: ${question2}`);
    process.stdout.write('答: ');
    await streamChat(question2);
}

main().catch(console.error);
