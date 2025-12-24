#!/usr/bin/env python3
"""
流式聊天示例 - 使用云驿二次中转代理
"""

import os
from openai import OpenAI
from dotenv import load_dotenv

# 加载环境变量
load_dotenv()

# 配置 - 使用本地代理
PROXY_URL = os.getenv("PROXY_URL", "http://localhost:3456/v1")
MODEL = "gpt-4"  # 任意模型名，代理会自动转换

# 创建客户端 - 连接本地代理
client = OpenAI(
    api_key="any-key",  # 代理使用 .env 中的云驿激活码
    base_url=PROXY_URL,
)


def stream_chat(message: str):
    """发送消息并流式获取回复"""
    stream = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": "你是一个有用的助手。"},
            {"role": "user", "content": message}
        ],
        temperature=0.7,
        max_tokens=2000,
        stream=True,
    )
    
    for chunk in stream:
        if chunk.choices[0].delta.content:
            yield chunk.choices[0].delta.content


def main():
    print("=" * 50)
    print("云驿 API 流式聊天测试 (通过本地代理)")
    print("=" * 50)
    print(f"代理地址: {PROXY_URL}")
    print(f"请求模型: {MODEL}")
    print("=" * 50)
    
    # 测试请求
    question = "请解释什么是递归，并给出一个简单的例子"
    print(f"\n问: {question}\n")
    print("答: ", end="", flush=True)
    
    for text in stream_chat(question):
        print(text, end="", flush=True)
    
    print("\n")


if __name__ == "__main__":
    main()
