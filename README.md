# GLM Coding Grabber - Node.js 版

智谱 GLM Coding 验证码点选 OCR 服务，替代 Python ddddocr，与原接口完全兼容，可直接对接油猴脚本。

## 项目架构

```
glm-coding-grabber-node/
├── config/                    # 配置模块
│   ├── default.ts             # 默认配置定义（convict schema）
│   └── index.ts               # 配置加载、校验、ONNX 模型路径自动查找
├── src/
│   ├── index.ts               # Express HTTP 服务入口（/ /health /click 路由）
│   ├── ocr/
│   │   ├── local-ocr.ts       # 核心 OCR 引擎（检测 + OCR + HOG + 排列搜索）
│   │   ├── onnx-detector.ts   # ONNX YOLOX 检测模型（common_det.onnx）
│   │   ├── onnx-ocr-classifier.ts  # ONNX OCR 分类模型（common.onnx + CTC 解码）
│   └── types/
│       └── declarations.d.ts  # 第三方包类型声明
├── scripts/
│   ├── build-tampermonkey.ts  # 油猴脚本构建器
│   └── start.sh               # Linux 启动脚本
├── models/                    # ONNX 模型文件（需手动放置）
│   ├── common_det.onnx        # ddddocr 检测模型
│   ├── common.onnx            # ddddocr OCR 分类模型
│   └── charset.json           # OCR 字符集（8210 字）
├── data/                      # Tesseract 训练数据
│   └── chi_sim.traineddata    # 中文简体训练数据（区域检测 fallback）
├── tampermonkey/              # 油猴脚本源码
│   ├── index.js               # v1 - DOM 寄生型（依赖页面 Vue 实例）
│   └── index-v2.js            # v2 - 纯接口型（推荐，无 DOM 依赖）
├── dist/                      # TypeScript 编译输出
├── package.json
├── tsconfig.json
└── .env                       # 环境变量（端口、地址等）
```

## 识别流程

验证码点选识别采用多层级策略，优先使用高性能路径：

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  区域检测     │ ──▶ │  裁剪 + OCR  │ ──▶ │  快速路径?   │ ──▶ │  返回坐标    │
│  (ONNX/CC/   │     │  (ONNX CTC   │     │  高置信匹配  │     │              │
│   Tesseract) │     │   分类)       │     │  是 → 直接返回│     └──────────────┘
└──────────────┘     └──────────────┘     │  否 ↓        │
                                          ┌──────────────┐
                                          │  HOG 特征    │
                                          │  + 字体渲染   │
                                          │  + 全排列搜索 │
                                          └──────────────┘
```

**Step 1 — 区域检测**（Fallback 链）：
ONNX YOLOX 检测 → 连通区域检测 → tesseract PSM=6 → tesseract PSM=12

**Step 2 — 裁剪 + OCR 分类**：
并行裁剪所有检测区域 → 并行 ONNX OCR 分类（CTC 解码 + softmax 置信度 + top-5 候选）

**Step 3 — 快速路径**（80-160ms）：
所有提示字 ONNX 置信度 ≥ 0.7 且唯一匹配 → 直接返回坐标，跳过后续步骤

**Step 4 — 完整路径**（150-300ms，快速路径失败时）：
- HOG 特征提取（32×32 → 324 维梯度方向直方图）
- 字体渲染变体（1 字号 × 3 字体 × 2 角度 = 6 变体/字）
- 综合评分矩阵：视觉相似度 + ONNX 精确匹配 bonus(0.5×置信度) + top-k 候选 bonus(0.15)
- 全排列搜索 + 距离约束

## 依赖与功能

### 运行时依赖

| 依赖 | 用途 |
|------|------|
| express | HTTP 服务框架，路由声明式管理，自动 JSON 解析和 CORS |
| cors | Express CORS 中间件，允许油猴脚本跨域调用 |
| onnxruntime-node | ONNX 模型推理引擎，加载 ddddocr 检测和分类模型 |
| sharp | 图像处理（裁剪、缩放、灰度化、CLAHE 增强、二值化） |
| canvas (node-canvas) | 中文字体渲染变体（测量字宽、绘制字符、提取像素） |
| tesseract.js | 区域检测 fallback（PSM=6/12 模式定位文字区域） |
| convict | 配置管理框架（schema 定义、环境变量绑定、校验） |
| dotenv | .env 文件加载 |

### 开发依赖

| 依赖 | 用途 |
|------|------|
| typescript | TypeScript 编译器 |
| tsx | 开发模式运行（无需预编译，直接执行 .ts） |
| @types/node | Node.js 类型定义 |
| @types/express | Express 类型定义 |
| @types/cors | cors 类型定义 |

## 快速开始

### 环境要求

- Node.js >= 20.0.0
- 系统需安装中文字体（Windows 自带，macOS/Linux 需手动安装）

### 安装与运行

```bash
# 安装依赖
npm install

# 开发模式（无需编译，推荐）
npm run dev

# 或编译后启动
npm run build:ts
npm start
```

服务默认监听 `127.0.0.1:9898`，启动后会显示：

```
╔══════════════════════════════════════════╗
║  GLM Coding OCR Server - Node.js 版     ║
║  替代原 Python ddddocr 服务              ║
╚══════════════════════════════════════════╝
```

### 环境变量配置

可通过 `.env` 文件或环境变量覆盖默认配置：

```bash
# .env
OCR_SERVER_PORT=9898           # 服务端口
OCR_SERVER_HOST=127.0.0.1      # 监听地址
ONNX_MODEL_PATH=models/common_det.onnx   # 检测模型路径
ONNX_OCR_MODEL_PATH=models/common.onnx   # OCR 分类模型路径
```

## API 接口

兼容原 Python ddddocr 服务接口，油猴脚本无需改动即可对接：

### `GET /`

服务连通性检查，油猴脚本 `checkLocalOcrService` 使用。

```json
{ "status": "ok", "engine": "node-ocr" }
```

### `GET /health`

健康检查，返回引擎状态和已加载字体数量。

```json
{ "status": "ok", "engine": "node-ocr", "fonts": 5 }
```

### `POST /click`

验证码点选识别。

**请求体：**
```json
{
  "image": "base64 编码的验证码图片",
  "remark": "提示文字（如"大中小"）"
}
```

**成功响应：**
```json
{
  "success": true,
  "data": {
    "result": "120,85|200,90|280,88",
    "id": ""
  }
}
```

**失败响应：**
```json
{
  "success": false,
  "message": "未检测到任何目标"
}
```

## 模型文件

ONNX 模型需要放置在 `models/` 目录下：

| 文件 | 说明 |
|------|------|
| `common_det.onnx` | ddddocr YOLOX 检测模型（目标区域定位） |
| `common.onnx` | ddddocr OCR 分类模型（CTC 文字识别） |
| `charset.json` | OCR 字符集（8210 字，index 0 = CTC blank） |

> 模型文件来自 [ddddocr](https://github.com/sml2h3/ddddocr) 项目，也可从 Python ddddocr 包路径自动加载（`onnxModelPath` / `onnxOcrModelPath` 为空时自动查找）。

## 油猴脚本

项目提供两个版本的油猴脚本（`tampermonkey/` 目录）：

| 版本 | 文件 | 说明 |
|------|------|------|
| v1 | `index.js` | DOM 寄生型，依赖页面 Vue 实例 |
| **v2** | **`index-v2.js`** | **纯接口型，推荐使用，无 DOM 依赖** |

两个版本功能不同，**不要同时安装**。脚本默认连接 `http://127.0.0.1:9898`。

## 性能

| 路径 | 耗时 | 说明 |
|------|------|------|
| 快速路径 | 80-160ms | ONNX 高置信直接匹配，跳过 HOG + 字体渲染 |
| 完整路径 | 150-300ms | HOG + 字体渲染 + 全排列搜索 |

优化措施：
- 启动时预缓存 ~190 个常见验证码字符的字体变体，消除首次请求延迟
- 并行裁剪 + 并行 OCR 分类，减少串行等待
- UV_THREADPOOL_SIZE 设为 12，支持 4-6 个并发请求
- ONNX 检测结果只保留 top-N（提示字数 + 1），减少 OCR 调用数

## License

MIT
