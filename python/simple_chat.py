#!/usr/bin/env python3
"""
简单聊天示例 - 使用云驿二次中转代理
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


def chat(message: str) -> str:
    """发送消息并获取回复"""
    response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": "你是一个有用的助手。"},
            {"role": "user", "content": message}
        ],
        temperature=0.7,
        max_tokens=2000,
    )
    return response.choices[0].message.content


def main():
    print("=" * 50)
    print("云驿 API 聊天测试 (通过本地代理)")
    print("=" * 50)
    print(f"代理地址: {PROXY_URL}")
    print(f"请求模型: {MODEL}")
    print("=" * 50)
    
    # 测试请求
    question = "请用 Python 写一个快速排序算法"
    print(f"\n问: {question}\n")
    
    answer = chat(question)
    print(f"答: {answer}")


if __name__ == "__main__":
    main()
