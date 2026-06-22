/**
 * 配置加载与校验 - OCR 服务专用
 * 使用 convict 6.x 加载 .env + 默认配置，校验后导出
 */

import dotenv from 'dotenv';
import convict from 'convict';
import path from 'path';
import fs from 'fs';
import defaultConfig from './default.js';

dotenv.config();

// ── 注册自定义格式 ──────────────────────────────────

convict.addFormat({
  name: 'string',
  validate: (v: unknown) => { if (typeof v !== 'string') throw new Error('must be a string'); },
  coerce: (v: unknown) => String(v),
});

convict.addFormat({
  name: 'int',
  validate: (v: unknown) => { if (!Number.isInteger(v)) throw new Error('must be an integer'); },
  coerce: (v: unknown) => parseInt(String(v), 10),
});

// 创建 convict 实例
const config = convict(defaultConfig);

// 校验配置
try {
  config.validate();
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('配置校验失败:', msg);
  process.exit(1);
}

// 自动查找 ONNX 模型路径（如果用户没配置）
if (!config.get('onnxModelPath')) {
  const detCandidates = [
    path.join(process.cwd(), 'models', 'common_det.onnx'),
    'D:\\scoop\\apps\\python\\current\\Lib\\site-packages\\ddddocr\\common_det.onnx',
    '/usr/local/lib/python3/dist-packages/ddddocr/common_det.onnx',
    '/usr/lib/python3/dist-packages/ddddocr/common_det.onnx',
  ];

  for (const p of detCandidates) {
    if (fs.existsSync(p)) {
      config.set('onnxModelPath', p);
      break;
    }
  }
}

if (!config.get('onnxOcrModelPath')) {
  const ocrCandidates = [
    path.join(process.cwd(), 'models', 'common.onnx'),
    'D:\\scoop\\apps\\python\\current\\Lib\\site-packages\\ddddocr\\common.onnx',
    '/usr/local/lib/python3/dist-packages/ddddocr/common.onnx',
    '/usr/lib/python3/dist-packages/ddddocr/common.onnx',
  ];

  for (const p of ocrCandidates) {
    if (fs.existsSync(p)) {
      config.set('onnxOcrModelPath', p);
      break;
    }
  }
}

export default config;
