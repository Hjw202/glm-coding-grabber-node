# GLM Coding OCR Server - Node.js 版

替代 Python ddddocr 服务的 Node.js 验证码 OCR HTTP 服务，与原 Python 版接口完全兼容，可直接对接油猴脚本。

## 项目架构

```
glm-coding-grabber-node/
├── config/                    # 配置模块
│   ├── default.ts             # 默认配置定义（convict schema）
│   └── index.ts               # 配置加载、校验、ONNX 模型路径自动查找
├── src/
│   ├── index.ts               # CLI 入口（serve / ocr-server 命令）
│   ├── server.ts              # Express HTTP 服务（/ /health /click 路由）
│   ├── ocr/
│   │   ├── local-ocr.ts       # 核心 OCR 引擎（检测 + OCR + HOG + 排列搜索）
│   │   ├── onnx-detector.ts   # ONNX YOLOX 检测模型（common_det.onnx）
│   │   ├── onnx-ocr-classifier.ts  # ONNX OCR 分类模型（common.onnx + CTC 解码）
│   │   └── python-ocr.ts      # Python ddddocr HTTP fallback
│   └── types/
│       └── declarations.d.ts  # 第三方包类型声明（convict/canvas/tesseract/onnxruntime）
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
├── dist/                      # TypeScript 编译输出
├── tsconfig.json              # TypeScript 配置
└── .env                       # 环境变量（端口、地址等）
```

## 识别流程

验证码识别采用多层级策略，优先使用高性能路径：

1. **ONNX 检测**：YOLOX 模型检测目标区域（与 Python ddddocr 完全一致）
2. **ONNX OCR 分类**：对每个裁剪区域做 CTC 解码，返回文字 + sigmoid(margin) 置信度 + top-5 候选
3. **快速路径**：所有提示字 ONNX 置信度 ≥ 0.7 且唯一匹配时，直接返回坐标，跳过后续步骤（耗时 ~80-160ms）
4. **完整路径**（快速路径失败时）：
   - HOG 特征提取（32×32 → 324 维梯度方向直方图）
   - 字体渲染变体（1字号 × 3字体 × 2角度 = 6 变体/字）
   - 综合评分矩阵：视觉相似度 + ONNX 精确匹配 bonus(0.5×置信度) + top-k 候选 bonus(0.15)
   - 全排列搜索 + 距离约束

Fallback 链（检测阶段）：ONNX → 连通区域检测 → tesseract PSM=6 → tesseract PSM=12

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
| commander | CLI 命令解析（serve / ocr-server） |
| dotenv | .env 文件加载 |
| undici | HTTP 客户端（Python ddddocr 服务 fallback 调用） |

### 开发依赖

| 依赖 | 用途 |
|------|------|
| typescript | TypeScript 编译器 |
| tsx | 开发模式运行（无需预编译，直接执行 .ts） |
| @types/node | Node.js 类型定义 |
| @types/express | Express 类型定义 |
| @types/cors | cors 类型定义 |

## API 接口

兼容原 Python ddddocr 服务接口：

- `GET /` — 服务连通性检查，油猴脚本 `checkLocalOcrService` 使用
- `GET /health` — 健康检查，返回引擎状态和字体数量
- `POST /click` — 验证码识别，请求体 `{image: "base64", remark: "提示文字"}`，返回 `{success: true, data: {result: "x1,y1|x2,y2|x3,y3", id: ""}}`

## 快速开始

```bash
# 安装依赖
npm install

# 编译 TypeScript
npm run build:ts

# 启动服务
npm run serve

# 或开发模式（无需编译）
npm run dev
```

服务默认监听 `127.0.0.1:9898`，可通过 `.env` 或命令行参数修改：

```bash
# .env 文件
OCR_SERVER_PORT=9898
OCR_SERVER_HOST=127.0.0.1
ONNX_MODEL_PATH=models/common_det.onnx
ONNX_OCR_MODEL_PATH=models/common.onnx
```

## 模型文件

ONNX 模型需要放置在 `models/` 目录下：

- `common_det.onnx` — ddddocr YOLOX 检测模型（目标区域定位）
- `common.onnx` — ddddocr OCR 分类模型（CTC 文字识别）
- `charset.json` — OCR 字符集（8210 字，index 0 = CTC blank）

也可从 Python ddddocr 包路径自动加载（配置中 `onnxModelPath` / `onnxOcrModelPath` 为空时自动查找）。

## 性能

- 快速路径（ONNX 高置信直接匹配）：80-160ms
- 完整路径（HOG + 字体渲染 + 全排列）：150-300ms
- 预缓存 190 个常见验证码字符，消除首次请求延迟
