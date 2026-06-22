/**
 * ONNX OCR 分类引擎 — 加载 ddddocr 的 common.onnx OCR 模型
 *
 * 替代 tesseract.js 做 OCR 分类，速度从 ~640ms/次 提升到 ~10ms/次。
 *
 * 模型规格：
 * - 输入: input1  shape [1, 1, 64, W]  float32 (灰度, 0-1归一化)
 * - 输出: 387     shape (seqlen, 1, 8210)  float32
 * - 8210 = charset size (index 0 = CTC blank)
 *
 * 预处理（与 ddddocr OCREngine._preprocess_image 一致）：
 * 1. 保持纵横比缩放到 height=64
 * 2. 灰度化
 * 3. /255.0 归一化到 [0,1]
 * 4. 扩维到 [1, 1, 64, W]
 *
 * 后处理（与 ddddocr _ctc_decode_indices 一致）：
 * 1. Argmax per timestep → predicted_indices
 * 2. CTC 解码：去连续重复 + 去 blank (index=0)
 * 3. Charset lookup → 字符串
 *
 * 增强功能：
 * - classifyWithConfidence() 返回 softmax 置信度 + top-k 候选字符
 *   置信度使用 sigmoid(max_margin) 计算，反映模型对预测的确信程度
 *   top-k 候选来自每个解码 timestep 的 top-5 预测，丰富 OCR 评分信息
 */
import ort from 'onnxruntime-node';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
// 惰性加载 charset，避免模块加载时文件不存在导致崩溃
let _charset = null;
function _loadCharset() {
    if (_charset)
        return _charset;
    const jsonPaths = [
        path.join(process.cwd(), 'models', 'charset.json'),
    ];
    for (const p of jsonPaths) {
        if (fs.existsSync(p)) {
            try {
                const charset = JSON.parse(fs.readFileSync(p, 'utf-8'));
                if (charset.length >= 8000) {
                    _charset = charset;
                    return _charset;
                }
            }
            catch {
                continue;
            }
        }
    }
    const pythonPaths = [
        'D:\\scoop\\apps\\python\\current\\Lib\\site-packages\\ddddocr\\charsets.py',
    ];
    for (const p of pythonPaths) {
        if (fs.existsSync(p)) {
            try {
                const content = fs.readFileSync(p, 'utf-8');
                const match = content.match(/CHARSET_OLD\s*=\s*\[([^\]]+)\]/s);
                if (match) {
                    const chars = match[1].split(',').map(c => {
                        const m = c.trim().match(/^'(.*?)'$/);
                        return m ? m[1] : '';
                    });
                    if (chars.length >= 8000) {
                        _charset = chars;
                        return _charset;
                    }
                }
            }
            catch {
                continue;
            }
        }
    }
    throw new Error('无法加载 ddddocr charset (需要 charset.json 或 Python ddddocr)');
}
const TOP_K = 5;
export class ONNXOCRClassifier {
    modelPath;
    session = null;
    charset = null;
    constructor(modelPath) {
        this.modelPath = modelPath || path.join(process.cwd(), 'models', 'common.onnx');
    }
    async init() {
        if (this.session)
            return;
        // 惰性加载 charset（在 init 时加载，避免模块加载时崩溃）
        if (!this.charset) {
            this.charset = _loadCharset();
        }
        const candidates = [this.modelPath];
        if (!fs.existsSync(this.modelPath)) {
            candidates.push('D:\\scoop\\apps\\python\\current\\Lib\\site-packages\\ddddocr\\common.onnx', '/usr/local/lib/python3/dist-packages/ddddocr/common.onnx', '/usr/lib/python3/dist-packages/ddddocr/common.onnx');
        }
        let foundPath = null;
        for (const p of candidates) {
            if (fs.existsSync(p)) {
                foundPath = p;
                break;
            }
        }
        if (!foundPath) {
            throw new Error('ONNX OCR 模型文件不存在 (common.onnx)');
        }
        console.log(`[ONNX OCR] 加载分类模型: ${foundPath}`);
        this.session = await ort.InferenceSession.create(foundPath, {
            executionProviders: ['cpu'],
            graphOptimizationLevel: 'all',
        });
        console.log('[ONNX OCR] 分类模型加载完成');
    }
    /**
     * 分类单个图像区域（简单版，只返回文字）
     * @param imgBuffer - 图像 Buffer (PNG/JPEG)
     * @returns 识别的文字
     */
    async classify(imgBuffer) {
        const result = await this.classifyWithConfidence(imgBuffer);
        return result.text;
    }
    /**
     * 分类单个图像区域（增强版，返回文字 + 置信度 + top-k 候选）
     *
     * @param imgBuffer - 图像 Buffer (PNG/JPEG)
     * @param knownWidth - 已知宽度（可选，避免重复 metadata 调用）
     * @param knownHeight - 已知高度（可选，避免重复 metadata 调用）
     * @returns text: CTC 解码后的文字
     *         confidence: sigmoid(max_margin) 平均置信度 [0,1]
     *         topKChars: 每个解码位置 top-K 候选字符集合
     */
    async classifyWithConfidence(imgBuffer, knownWidth, knownHeight) {
        await this.init();
        const inputTensor = await this._preprocess(imgBuffer, knownWidth, knownHeight);
        const inputName = this.session.inputNames[0];
        const feeds = { [inputName]: inputTensor };
        const results = await this.session.run(feeds);
        const outputName = this.session.outputNames[0];
        const output = results[outputName];
        return this._ctcDecodeWithConfidence(output);
    }
    /**
     * 预处理（与 ddddocr OCREngine 一致）
     * 优化：接受已知尺寸避免 metadata 调用
     */
    async _preprocess(imgBuffer, knownWidth, knownHeight) {
        const targetH = 64;
        // 如果已知尺寸，直接计算 targetW，避免 metadata 调用
        if (knownWidth && knownHeight) {
            const targetW = Math.max(1, Math.round(knownWidth * (targetH / knownHeight)));
            const resized = await sharp(imgBuffer)
                .resize(targetW, targetH, { fit: 'fill' })
                .grayscale()
                .raw()
                .toBuffer();
            const floatData = new Float32Array(1 * 1 * targetH * targetW);
            for (let i = 0; i < resized.length; i++) {
                floatData[i] = resized[i] / 255.0;
            }
            return new ort.Tensor('float32', floatData, [1, 1, targetH, targetW]);
        }
        // fallback: 需要获取图像尺寸，先 metadata 再 resize（两个 sharp 调用）
        const meta = await sharp(imgBuffer).metadata();
        const origW = meta.width || 64;
        const origH = meta.height || 64;
        const targetW = Math.max(1, Math.round(origW * (targetH / origH)));
        const resized = await sharp(imgBuffer)
            .resize(targetW, targetH, { fit: 'fill' })
            .grayscale()
            .raw()
            .toBuffer();
        const floatData = new Float32Array(1 * 1 * targetH * targetW);
        for (let i = 0; i < resized.length; i++) {
            floatData[i] = resized[i] / 255.0;
        }
        return new ort.Tensor('float32', floatData, [1, 1, targetH, targetW]);
    }
    /**
     * CTC 解码 + 置信度计算 + top-k 提取
     *
     * 置信度计算方式：
     * 对每个解码 timestep，计算 margin = max_logit - second_logit
     * 然后用 sigmoid(margin) 映射到 [0,1]
     *
     * top-k 提取方式：
     * 对每个解码 timestep，收集 top-K（默认5）个非 CTC blank 的候选字符
     */
    _ctcDecodeWithConfidence(outputTensor) {
        const dims = outputTensor.dims;
        const data = outputTensor.data;
        const numClasses = this.charset.length;
        // 解析输出形状，统一为 (seqlen, num_classes) 访问模式
        let seqlen;
        let getLogit;
        if (dims.length === 3 && dims[1] === 1) {
            // (seqlen, 1, num_classes)
            seqlen = dims[0];
            getLogit = (t, c) => data[t * numClasses + c];
        }
        else if (dims.length === 3 && dims[0] === 1) {
            // (1, seqlen, num_classes)
            seqlen = dims[1];
            getLogit = (t, c) => data[t * numClasses + c];
        }
        else if (dims.length === 2) {
            // (seqlen, num_classes)
            seqlen = dims[0];
            getLogit = (t, c) => data[t * numClasses + c];
        }
        else {
            return { text: '', confidence: 0, topKChars: new Set() };
        }
        // 对每个 timestep: 找 argmax + second-best + top-K
        const timestepInfo = new Array(seqlen);
        for (let t = 0; t < seqlen; t++) {
            let maxVal = -Infinity, maxIdx = 0;
            let secondVal = -Infinity;
            // 维护 top-K 堆（小顶堆策略）
            const topK = [];
            for (let c = 0; c < numClasses; c++) {
                const val = getLogit(t, c);
                // argmax + second-best
                if (val > maxVal) {
                    secondVal = maxVal;
                    maxVal = val;
                    maxIdx = c;
                }
                else if (val > secondVal) {
                    secondVal = val;
                }
                // top-K: 维护降序排列的最多 TOP_K 个元素
                if (topK.length < TOP_K) {
                    topK.push({ idx: c, val });
                    if (topK.length === TOP_K)
                        topK.sort((a, b) => b.val - a.val);
                }
                else if (val > topK[topK.length - 1].val) {
                    topK.pop();
                    topK.push({ idx: c, val });
                    topK.sort((a, b) => b.val - a.val);
                }
            }
            // sigmoid(margin) 作为该 timestep 的置信度
            const margin = maxVal - secondVal;
            const confidence = 1 / (1 + Math.exp(-margin));
            timestepInfo[t] = { argmaxIdx: maxIdx, confidence, topK };
        }
        // CTC 解码: 去连续重复 + 去 blank (index=0)
        const decoded = [];
        let prevIdx = -1;
        let totalConf = 0;
        let decodedCount = 0;
        const topKChars = new Set();
        for (let t = 0; t < seqlen; t++) {
            const idx = timestepInfo[t].argmaxIdx;
            if (idx !== prevIdx) {
                if (idx !== 0) {
                    const char = this.charset[idx] || '';
                    decoded.push(char);
                    totalConf += timestepInfo[t].confidence;
                    decodedCount++;
                    // 收集 top-K 候选（排除 top-1 本身和 CTC blank）
                    for (const k of timestepInfo[t].topK) {
                        if (k.idx !== idx && k.idx > 0) {
                            const altChar = this.charset[k.idx] || '';
                            if (altChar)
                                topKChars.add(altChar);
                        }
                    }
                }
            }
            prevIdx = idx;
        }
        const text = decoded.join('');
        const confidence = decodedCount > 0 ? totalConf / decodedCount : 0;
        return { text, confidence, topKChars };
    }
}
//# sourceMappingURL=onnx-ocr-classifier.js.map