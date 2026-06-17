/**
 * ONNX 检测引擎 — 加载 ddddocr 的 YOLOX 检测模型
 *
 * 直接加载 Python ddddocr 的 common_det.onnx 模型文件，
 * 在 Node.js 中通过 onnxruntime-node 推理，
 * 获得与 Python 版完全一致的检测精度。
 *
 * 模型规格：
 * - 输入: /images/  shape [1, 3, 416, 416]  float32 (BGR, 0-255, 不做归一化)
 * - 输出: /output/  shape [1, 3549, 6]       float32
 * - 6 = [cx, cy, w, h, objectness, class_score]
 * - 3549 = 52²+26²+13² (YOLOX 三尺度特征金字塔, strides=[8,16,32])
 *
 * 预处理流程（与 ddddocr DetectionEngine.preproc 一致）：
 * 1. 解码图像为 BGR uint8 数组
 * 2. 创建 416×416×3 canvas (fill=114, YOLO letterbox padding)
 * 3. 保持纵横比缩放图像 (ratio = min(416/H, 416/W))
 * 4. 放置缩放图像到 canvas 左上角
 * 5. HWC→CHW 转置, uint8→float32 (不做归一化)
 *
 * 后处理流程（与 ddddocr DetectionEngine 一致）：
 * 1. Grid 解码: (raw_xy + grid_xy) * stride, exp(raw_wh) * stride
 * 2. 提取 boxes(cx,cy,w,h) 和 scores(objectness * class_prob)
 * 3. cx,cy,w,h → x1,y1,x2,y2
 * 4. 除以 ratio 回到原图坐标
 * 5. NMS (score_thr=0.1, nms_thr=0.45)
 * 6. Clamp 到图像边界
 */

import ort from 'onnxruntime-node';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

// YOLOX 参数
const INPUT_SIZE = 416;
const STRIDES: readonly number[] = [8, 16, 32];
const PAD_VALUE = 114; // YOLO letterbox padding (ImageNet BGR average)
const SCORE_THRESHOLD = 0.1;
const NMS_THRESHOLD = 0.45;

interface DetectionResult {
  box: [number, number, number, number]; // [x1, y1, x2, y2]
  confidence: number;
}

interface BoxCandidate {
  cx: number;
  cy: number;
  w: number;
  h: number;
  score: number;
}

interface NMSBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  score: number;
}

export class ONNXDetectionEngine {
  private modelPath: string;
  private session: ort.InferenceSession | null = null;

  constructor(modelPath: string) {
    this.modelPath = modelPath || path.join(process.cwd(), 'models', 'common_det.onnx');
  }

  /**
   * 初始化 ONNX 推理会话
   */
  async init(): Promise<void> {
    if (this.session) return;

    if (!fs.existsSync(this.modelPath)) {
      throw new Error(`ONNX 模型文件不存在: ${this.modelPath}`);
    }

    console.log(`[ONNX] 加载检测模型: ${this.modelPath}`);
    const sessionOptions = {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    };

    this.session = await ort.InferenceSession.create(this.modelPath, sessionOptions);
    console.log('[ONNX] 模型加载完成');
  }

  /**
   * 检测图像中的目标区域
   * @param imgBuffer - 原始图像 Buffer (PNG/JPEG)
   * @returns 检测到的区域列表
   */
  async detect(imgBuffer: Buffer): Promise<DetectionResult[]> {
    await this.init();

    // Step 1: 解码图像 + 获取尺寸
    const meta = await sharp(imgBuffer).metadata();
    const imgW = meta.width || 340;
    const imgH = meta.height || 195;

    // Step 2: 预处理 (letterbox resize + padding)
    const { inputTensor, ratio } = await this._preprocess(imgBuffer, imgW, imgH);

    // Step 3: ONNX 推理
    const inputName = this.session!.inputNames[0]; // '/images/'
    const feeds: Record<string, ort.Tensor> = { [inputName]: inputTensor };
    const results = await this.session!.run(feeds);

    // Step 4: 后处理 (grid 解码 + NMS)
    const outputName = this.session!.outputNames[0]; // '/output/'
    const outputData = (results[outputName].data as Float32Array);
    const outputDims = results[outputName].dims;

    const predictions = this._decodePredictions(outputData, outputDims);
    const boxes = this._postprocess(predictions, ratio, imgW, imgH);

    return boxes;
  }

  /**
   * 预处理: letterbox resize + padding + HWC→CHW
   * 与 ddddocr DetectionEngine.preproc 一致
   */
  private async _preprocess(imgBuffer: Buffer, imgW: number, imgH: number): Promise<{ inputTensor: ort.Tensor; ratio: number }> {
    // 计算 letterbox 缩放比例
    const ratio = Math.min(INPUT_SIZE / imgH, INPUT_SIZE / imgW);
    const newW = Math.round(imgW * ratio);
    const newH = Math.round(imgH * ratio);

    // 用 sharp 做 resize + raw pixel 输出
    // sharp 输出 RGB 顺序, 需要 swap 到 BGR (YOLO convention)
    const resized = await sharp(imgBuffer)
      .resize(newW, newH, { fit: 'fill' })
      .raw()
      .toBuffer();

    // 创建 416×416×3 padding canvas (fill=114)
    const canvas = new Uint8Array(INPUT_SIZE * INPUT_SIZE * 3);
    canvas.fill(PAD_VALUE);

    // 将缩放图像放到 canvas 左上角 (BGR order for YOLO)
    for (let y = 0; y < newH; y++) {
      for (let x = 0; x < newW; x++) {
        const srcIdx = (y * newW + x) * 3;
        // sharp 输出 RGB, YOLO 需要 BGR → swap R and B
        const dstIdx = (y * INPUT_SIZE + x) * 3;
        canvas[dstIdx + 0] = resized[srcIdx + 2]; // B
        canvas[dstIdx + 1] = resized[srcIdx + 1]; // G
        canvas[dstIdx + 2] = resized[srcIdx + 0]; // R
      }
    }

    // HWC → CHW 转置 + uint8 → float32 (不做归一化, 与 ddddocr 一致)
    const chwData = new Float32Array(INPUT_SIZE * INPUT_SIZE * 3);
    for (let y = 0; y < INPUT_SIZE; y++) {
      for (let x = 0; x < INPUT_SIZE; x++) {
        for (let c = 0; c < 3; c++) {
          chwData[c * INPUT_SIZE * INPUT_SIZE + y * INPUT_SIZE + x] =
            canvas[(y * INPUT_SIZE + x) * 3 + c];
        }
      }
    }

    const inputTensor = new ort.Tensor('float32', chwData, [1, 3, INPUT_SIZE, INPUT_SIZE]);
    return { inputTensor, ratio };
  }

  /**
   * YOLOX grid 解码
   * 与 ddddocr demo_postprocess 一致
   */
  private _decodePredictions(outputData: Float32Array, outputDims: readonly number[]): number[][] {
    const numAnchors = outputDims[1]; // 3549
    const numValues = outputDims[2];  // 6

    // 生成 grid centers 和 expanded strides
    const grids: number[] = [];
    const expandedStrides: number[] = [];

    for (const stride of STRIDES) {
      const featH = INPUT_SIZE / stride;
      const featW = INPUT_SIZE / stride;
      for (let y = 0; y < featH; y++) {
        for (let x = 0; x < featW; x++) {
          grids.push(x);
          grids.push(y);
          expandedStrides.push(stride);
          expandedStrides.push(stride);
        }
      }
    }

    // 解码: (raw_xy + grid_xy) * stride, exp(raw_wh) * stride
    const predictions: number[][] = [];
    for (let i = 0; i < numAnchors; i++) {
      const row: number[] = [];
      for (let j = 0; j < numValues; j++) {
        const idx = i * numValues + j;
        row.push(outputData[idx]);
      }

      // 解码 center coordinates 和 size
      row[0] = (row[0] + grids[i * 2]) * expandedStrides[i * 2];     // cx
      row[1] = (row[1] + grids[i * 2 + 1]) * expandedStrides[i * 2 + 1]; // cy
      row[2] = Math.exp(row[2]) * expandedStrides[i * 2];               // w
      row[3] = Math.exp(row[3]) * expandedStrides[i * 2];               // h

      predictions.push(row);
    }

    return predictions;
  }

  /**
   * 后处理: 提取 boxes + scores + NMS + coordinate conversion
   * 与 ddddocr DetectionEngine 一致
   */
  private _postprocess(predictions: number[][], ratio: number, imgW: number, imgH: number): DetectionResult[] {
    // Step 1: 提取 boxes 和 scores
    // scores = objectness * class_score
    const candidates: BoxCandidate[] = [];
    for (const pred of predictions) {
      const score = pred[4] * pred[5]; // objectness * class_prob
      if (score > SCORE_THRESHOLD) {
        candidates.push({
          cx: pred[0],
          cy: pred[1],
          w: pred[2],
          h: pred[3],
          score,
        });
      }
    }

    if (candidates.length === 0) return [];

    // Step 2: cx,cy,w,h → x1,y1,x2,y2 并除以 ratio 回到原图坐标
    const boxes: NMSBox[] = candidates.map(c => ({
      x1: Math.max(0, Math.round((c.cx - c.w / 2) / ratio)),
      y1: Math.max(0, Math.round((c.cy - c.h / 2) / ratio)),
      x2: Math.min(imgW, Math.round((c.cx + c.w / 2) / ratio)),
      y2: Math.min(imgH, Math.round((c.cy + c.h / 2) / ratio)),
      score: c.score,
    }));

    // Step 3: NMS (class-agnostic, 与 ddddocr 一致)
    const kept = this._nms(boxes, NMS_THRESHOLD);

    return kept.map(b => ({
      box: [b.x1, b.y1, b.x2, b.y2] as [number, number, number, number],
      confidence: b.score,
    }));
  }

  /**
   * Non-Maximum Suppression (贪心 NMS)
   */
  private _nms(boxes: NMSBox[], nmsThr: number): NMSBox[] {
    // 按分数降序排序
    const sorted = [...boxes].sort((a, b) => b.score - a.score);
    const kept: NMSBox[] = [];
    const suppressed = new Set<number>();

    for (let i = 0; i < sorted.length; i++) {
      if (suppressed.has(i)) continue;
      kept.push(sorted[i]);

      for (let j = i + 1; j < sorted.length; j++) {
        if (suppressed.has(j)) continue;
        const iou = this._computeIoU(sorted[i], sorted[j]);
        if (iou > nmsThr) {
          suppressed.add(j);
        }
      }
    }

    return kept;
  }

  /**
   * 计算两个 box 的 IoU
   */
  private _computeIoU(a: NMSBox, b: NMSBox): number {
    const x1 = Math.max(a.x1, b.x1);
    const y1 = Math.max(a.y1, b.y1);
    const x2 = Math.min(a.x2, b.x2);
    const y2 = Math.min(a.y2, b.y2);

    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    if (inter === 0) return 0;

    const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
    const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
    return inter / (areaA + areaB - inter);
  }
}
