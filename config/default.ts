/**
 * 默认配置 - OCR 服务专用
 * 所有配置项均可通过 .env 文件或命令行参数覆盖
 */

interface ConvictProperty {
  doc: string;
  format: string;
  default: string | number;
  env?: string;
  validator?: (val: unknown) => boolean;
}

const defaultConfig: Record<string, ConvictProperty> = {
  // ── OCR 设置 ──────────────────────────────────
  onnxModelPath: {
    doc: 'ONNX 检测模型路径（ddddocr common_det.onnx）',
    format: 'string',
    default: '',
    env: 'ONNX_MODEL_PATH',
  },
  onnxOcrModelPath: {
    doc: 'ONNX OCR 分类模型路径（ddddocr common.onnx）',
    format: 'string',
    default: '',
    env: 'ONNX_OCR_MODEL_PATH',
  },

  // ── OCR HTTP 服务 ────────────────────────────
  ocrServerPort: {
    doc: '本地 OCR 服务端口',
    format: 'int',
    default: 9898,
    env: 'OCR_SERVER_PORT',
  },
  ocrServerHost: {
    doc: '本地 OCR 服务地址',
    format: 'string',
    default: '127.0.0.1',
    env: 'OCR_SERVER_HOST',
  },
};

export default defaultConfig;
