#!/bin/bash
# GLM Coding OCR Server Node.js 版启动脚本

set -e

# 检查 .env 文件
if [ ! -f .env ]; then
    echo "警告: .env 文件不存在，请复制 .env.example 并填写配置"
    echo "  cp .env.example .env"
    echo ""
fi

# 检查 Node.js 版本
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo "错误: 需要 Node.js 20+，当前版本: $(node -v)"
    exit 1
fi

# 安装依赖
if [ ! -d node_modules ]; then
    echo "安装依赖..."
    npm install
fi

# 启动 OCR 服务
echo "启动 GLM Coding OCR Server..."
node src/index.js serve "$@"
