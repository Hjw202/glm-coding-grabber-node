/**
 * 本地 OCR 引擎（Node.js 完整实现）
 *
 * 核心算法（对标 Python ddddocr_server.py）：
 * 1. 区域检测：ONNX 加载 ddddocr YOLOX 检测模型（与 Python 版完全一致）
 *    - fallback: 连通区域检测 + tesseract.js PSM=6/12
 * 2. OCR 集成：ONNX OCR 分类优先（含 softmax 置信度 + top-k 候选）
 * 3. HOG 特征：全局 HOG (32×32→324维)（仅在快速路径失败时计算）
 * 4. 字体渲染变体：node-canvas 渲染中文字（1字号×3字体×2角度=6变体/字）
 * 5. 全排列搜索：综合评分矩阵 + 距离约束
 *
 * 性能优化总结：
 * - ONNX 快速路径：高置信唯一匹配 → 跳过 HOG + 字体渲染
 * - 消除重复调用：_detectRegions 只返回边界框，crop+OCR 单次执行
 * - 传递图像尺寸：避免重复 sharp.metadata()
 * - softmax 置信度：sigmoid(max_margin) 替代固定 confidence=1
 * - top-k 候选：ONNX OCR top-5 丰富 allResults，提升 OCR bonus 覆盖率
 * - 字体变体缩减：18/字 → 6/字，减少渲染时间 ~3x
 * - 预缓存扩充：38 → ~100 个常见验证码字符
 * - OCR bonus 权重：0.5 × actual_confidence（不再固定乘 1）
 */
import Tesseract from 'tesseract.js';
import sharp from 'sharp';
import { createCanvas, registerFont } from 'canvas';
import { ONNXDetectionEngine } from './onnx-detector.js';
import { ONNXOCRClassifier } from './onnx-ocr-classifier.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
// ── 常量 ──────────────────────────────────────
const FEAT_SIZE = 32;
const NBINS = 9;
const CELL_GLOBAL = 8;
const BLOCK_GLOBAL = 16;
const STRIDE_GLOBAL = 8;
// 中文字体白名单（跨平台）
const CHINESE_FONT_PATTERNS = [
    // Windows
    'msyh', 'simsun', 'simhei', 'simkai', 'fangsong',
    'STSong', 'STHeiti', 'STKaiti', 'STFangsong',
    // macOS
    'PingFang', 'Songti', 'Kaiti', 'Heiti', 'Hiragino',
    // Linux
    'NotoSansCJK', 'WenQuanYi', 'SourceHanSans', 'SourceHanSerif',
    'DroidSansFallback',
    // 通用
    'ArialUnicode',
];
// 验证码常见字符（启动时预缓存字体变体，消除首次请求延迟）
const COMMON_CAPTCHA_CHARS = '大中小猜携永薄贝绷卞饱播瓣采并隘齿焙惩辩舶参驳把捕餐蔼骋筹雹迟程箔钵步袄灿测酬忱卜愁碑趁菜侧班菠玻边橙苯扁乘长辫敞板笆摆踌白半偿苍伴宝佰邦皑倡沧扮渤炽敖昂辈财北常弛册尝宠裁奔拔稗按彪沉憋绊饱撤崩背搬采抱惫薄惭翅差呈称埃暗堡避蚕查础闯粗促辞村存档岛灯冬独堆鹅翻负钢贡观罕轰汇混激减简竞剧聚靠控扩蓝浪礼炼亮聊略麻迈矛茂模磨陌农攀培片旗升缩泰谈毯提图弯喜闲线选训岩扬氧叶银印迎影涌优泽振镇遵佐';
// 快速路径置信度阈值（sigmoid margin ≥ 此值才算"高置信"）
const FAST_PATH_CONF_THRESHOLD = 0.7;
export class LocalOCREngine {
    config;
    variantCache;
    fontPaths;
    _tesseractWorker;
    onnxDetector;
    _onnxReady;
    onnxClassifier;
    _onnxOcrReady;
    constructor(config) {
        this.config = config;
        this.variantCache = {};
        this.fontPaths = [];
        this._tesseractWorker = null;
        const modelPath = config.onnxModelPath || '';
        this.onnxDetector = new ONNXDetectionEngine(modelPath);
        this._onnxReady = false;
        const ocrModelPath = config.onnxOcrModelPath || '';
        this.onnxClassifier = new ONNXOCRClassifier(ocrModelPath);
        this._onnxOcrReady = false;
        this._scanFonts();
    }
    async preInit() {
        try {
            await this.onnxDetector.init();
            this._onnxReady = true;
            console.log('[OCR] ONNX 检测引擎已就绪');
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn('[OCR] ONNX 检测引擎初始化失败 (使用 fallback):', msg);
            this._onnxReady = false;
        }
        try {
            await this.onnxClassifier.init();
            this._onnxOcrReady = true;
            console.log('[OCR] ONNX OCR 分类引擎已就绪');
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn('[OCR] ONNX OCR 分类引擎初始化失败 (使用 tesseract fallback):', msg);
            this._onnxOcrReady = false;
        }
        const uniqueChars = [...new Set(COMMON_CAPTCHA_CHARS)];
        console.log(`[OCR] 预缓存 ${uniqueChars.length} 个常见字符的字体变体...`);
        await Promise.all(uniqueChars.map(ch => this._renderVariants(ch)));
        console.log('[OCR] 预缓存完成');
    }
    /**
     * 识别点选验证码
     */
    async recognize(imageBase64, promptText) {
        const t0 = Date.now();
        const imgBuffer = Buffer.from(imageBase64, 'base64');
        const imgMeta = await sharp(imgBuffer).metadata();
        const imgW = imgMeta.width || 340;
        const imgH = imgMeta.height || 195;
        const minDist = Math.min(imgW, imgH) * 0.10;
        // Step 1: 检测目标区域（只返回边界框，传递已知尺寸避免重复 metadata）
        const t1 = Date.now();
        const detectedBoxes = await this._detectRegions(imgBuffer, promptText, imgW, imgH);
        console.log(`[OCR-耗时] Step1 检测区域: ${Date.now() - t1}ms`);
        if (!detectedBoxes || detectedBoxes.length === 0) {
            console.warn('[OCR] 未检测到目标区域');
            return [];
        }
        console.log(`[OCR] 检测到 ${detectedBoxes.length} 个目标区域`);
        // Step 2a: 先并行裁剪所有区域（减轻线程池争用）
        const t2a = Date.now();
        const cropResults = await Promise.all(detectedBoxes.map(async (region) => {
            const { buffer, width, height } = await this._cropRegion(imgBuffer, region.box, imgW, imgH);
            return { buffer, width, height, box: region.box };
        }));
        console.log(`[OCR-耗时] Step2a 裁剪区域 (并发): ${Date.now() - t2a}ms`);
        // Step 2b: 并行 OCR 所有裁剪区域（sharp预处理 + ONNX推理）
        const t2b = Date.now();
        const ocrResults = await Promise.all(cropResults.map(async (crop) => {
            return await this._ocrEnsemble(crop.buffer, crop.width, crop.height);
        }));
        console.log(`[OCR-耗时] Step2b OCR分类 (并发): ${Date.now() - t2b}ms`);
        const detected = cropResults.map((crop, i) => ({
            char: ocrResults[i].char,
            confidence: ocrResults[i].confidence,
            allOcr: ocrResults[i].allResults,
            onnxConfidence: ocrResults[i].onnxConfidence,
            x: (crop.box[0] + crop.box[2]) / 2,
            y: (crop.box[1] + crop.box[3]) / 2,
            cropBuffer: crop.buffer,
        }));
        console.log(`[OCR-耗时] Step2 裁剪+OCR 总耗时: ${Date.now() - t2a}ms`);
        const ocrSummary = detected.map(d => `${d.char}(${((d.onnxConfidence ?? d.confidence) * 100).toFixed(0)}%)`).join(', ');
        console.log(`[OCR] OCR结果: ${ocrSummary}, 提示: [${promptText}]`);
        // Step 3: 快速路径 — ONNX OCR 高置信唯一匹配 → 跳过 HOG + 字体渲染
        const t3 = Date.now();
        const fastPath = this._tryFastPath(detected, promptText);
        if (fastPath) {
            console.log(`[OCR-耗时] 快速路径判断: ${Date.now() - t3}ms (命中快速路径)`);
            console.log(`[OCR-耗时] 快速路径总耗时: ${Date.now() - t0}ms`);
            console.log('[OCR] 快速路径: ONNX OCR 高置信直接匹配，跳过 HOG + 字体渲染');
            return fastPath.map(({ promptIdx, detectedIdx }) => ({
                x: detected[detectedIdx].x,
                y: detected[detectedIdx].y,
                char: promptText[promptIdx],
                matchChar: detected[detectedIdx].char,
                score: detected[detectedIdx].onnxConfidence ?? 1.0,
            }));
        }
        console.log(`[OCR-耗时] 快速路径判断: ${Date.now() - t3}ms (未命中, 走完整路径)`);
        console.log(`[OCR] 快速路径未命中原因: detected chars与prompt不完全匹配或置信度<${FAST_PATH_CONF_THRESHOLD}`);
        for (const d of detected) {
            console.log(`[OCR]   detected="${d.char}" onnxConf=${d.onnxConfidence?.toFixed(3)} inPrompt=${promptText.includes(d.char)}`);
        }
        // Step 4: 完整路径 — 计算 HOG 特征
        const t4 = Date.now();
        const detectedWithFeat = await Promise.all(detected.map(async (d) => {
            const feat = await this._extractHOGFeature(d.cropBuffer);
            return { ...d, feat };
        }));
        console.log(`[OCR-耗时] Step4 HOG特征: ${Date.now() - t4}ms`);
        // Step 5: 渲染提示字变体（并行渲染，6变体/字）
        const t5 = Date.now();
        const uniqueChars = new Set(promptText);
        const variantEntries = await Promise.all([...uniqueChars].map(async (ch) => [ch, await this._renderVariants(ch)]));
        const promptVariants = {};
        for (const [ch, variants] of variantEntries) {
            promptVariants[ch] = variants;
        }
        console.log(`[OCR-耗时] Step5 渲染变体: ${Date.now() - t5}ms`);
        // Step 6: 综合评分矩阵
        const n = promptText.length;
        const m = detectedWithFeat.length;
        const score = [];
        for (let pi = 0; pi < n; pi++) {
            score[pi] = [];
            for (let di = 0; di < m; di++) {
                const imgSim = this._bestVariantSim(promptVariants[promptText[pi]], detectedWithFeat[di].feat);
                let ocrBonus = 0;
                if (detectedWithFeat[di].char === promptText[pi]) {
                    // ONNX 精确匹配：使用 softmax 置信度
                    const effectiveConf = detectedWithFeat[di].onnxConfidence ?? detectedWithFeat[di].confidence;
                    ocrBonus = 0.5 * effectiveConf;
                }
                else if (detectedWithFeat[di].allOcr.has(promptText[pi])) {
                    // top-k 候选或 tesseract 投票中包含提示字
                    ocrBonus = 0.15;
                }
                score[pi][di] = imgSim + ocrBonus;
            }
        }
        for (let pi = 0; pi < n; pi++) {
            const row = score[pi].map(s => s.toFixed(2)).join(', ');
            console.log(`[OCR] 评分[${promptText[pi]}]: [${row}]`);
        }
        // Step 7: 全排列搜索
        const t7 = Date.now();
        const result = this._permutationSearch(score, detectedWithFeat, promptText, minDist);
        console.log(`[OCR-耗时] Step7 全排列: ${Date.now() - t7}ms`);
        for (const r of result) {
            console.log(`[OCR] "${r.char}" → 检测区域 (OCR="${r.matchChar}", score=${r.score.toFixed(3)})`);
        }
        console.log(`[OCR-耗时] 总耗时: ${Date.now() - t0}ms`);
        return result;
    }
    // ── ONNX 快速路径 ────────────────────────────────
    /**
     * 尝试 ONNX OCR 快速路径匹配
     *
     * 条件：ONNX OCR 对所有提示字符给出唯一的高置信度匹配
     * 置信度阈值 FAST_PATH_CONF_THRESHOLD = 0.7
     */
    _tryFastPath(detected, promptText) {
        if (!this._onnxOcrReady)
            return null;
        const n = promptText.length;
        const mapping = [];
        const usedDetected = new Set();
        for (let pi = 0; pi < n; pi++) {
            const promptChar = promptText[pi];
            let bestDi = -1;
            let bestConf = 0;
            for (let di = 0; di < detected.length; di++) {
                if (usedDetected.has(di))
                    continue;
                if (detected[di].char === promptChar) {
                    const conf = detected[di].onnxConfidence ?? detected[di].confidence;
                    // 需要 ONNX softmax 置信度 ≥ 阈值才算高置信匹配
                    if (conf >= FAST_PATH_CONF_THRESHOLD && conf > bestConf) {
                        bestDi = di;
                        bestConf = conf;
                    }
                }
            }
            if (bestDi === -1)
                return null;
            mapping.push({ promptIdx: pi, detectedIdx: bestDi });
            usedDetected.add(bestDi);
        }
        return mapping;
    }
    // ── 区域检测 ────────────────────────────────────
    async _detectRegions(imgBuffer, promptText, imgW, imgH) {
        // Step 1: ONNX ddddocr 检测模型
        if (this._onnxReady) {
            try {
                const tOnnx = Date.now();
                const detections = await this.onnxDetector.detect(imgBuffer, imgW, imgH);
                console.log(`[OCR-耗时] ONNX detect: ${Date.now() - tOnnx}ms, 原始检测数=${detections ? detections.length : 0}`);
                if (detections && detections.length >= 3) {
                    // 优化：只保留 promptText.length + 1 个区域（减少 OCR 调用数）
                    const maxKeep = promptText ? Math.max(promptText.length + 1, 4) : 8;
                    const topDetections = detections
                        .sort((a, b) => b.confidence - a.confidence)
                        .slice(0, maxKeep);
                    console.log(`[OCR] ONNX 检测: ${detections.length} → ${topDetections.length} 个区域 (top ${maxKeep})`);
                    return topDetections.map(det => ({ box: det.box }));
                }
                console.log(`[OCR] ONNX 检测不足 (${detections ? detections.length : 0}), 使用 fallback`);
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                console.warn('[OCR] ONNX 检测失败:', msg);
                if (!this._onnxReady) {
                    try {
                        await this.preInit();
                    }
                    catch { /* ignore */ }
                }
            }
        }
        // Step 2: 连通区域检测
        try {
            const tCc = Date.now();
            const boxes = await this._detectByConnectedComponents(imgBuffer, imgW, imgH);
            console.log(`[OCR-耗时] 连通区域检测: ${Date.now() - tCc}ms`);
            if (boxes && boxes.length >= 3) {
                console.log(`[OCR] 连通区域检测: ${boxes.length} 个区域`);
                return boxes;
            }
            console.log(`[OCR] 连通区域检测不足 (${boxes ? boxes.length : 0}), 使用 tesseract fallback`);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn('[OCR] 连通区域检测失败:', msg);
        }
        // Step 3: tesseract PSM=6
        try {
            const tTess6 = Date.now();
            const result = await Tesseract.recognize(imgBuffer, 'chi_sim', {
                tessedit_pageseg_mode: '6',
            });
            console.log(`[OCR-耗时] tesseract PSM=6: ${Date.now() - tTess6}ms`);
            const words = result.data.words;
            if (!words || words.length === 0)
                return null;
            const regions = words
                .filter(w => w.text.trim().length > 0)
                .map(w => ({ box: [w.bbox.x0, w.bbox.y0, w.bbox.x1, w.bbox.y1] }));
            if (regions.length >= 3)
                return regions;
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn('[OCR] tesseract fallback 失败:', msg);
        }
        // Step 4: PSM=12
        try {
            const tTess12 = Date.now();
            const result = await Tesseract.recognize(imgBuffer, 'chi_sim', {
                tessedit_pageseg_mode: '12',
            });
            console.log(`[OCR-耗时] tesseract PSM=12: ${Date.now() - tTess12}ms`);
            const words = result.data.words;
            if (!words || words.length === 0)
                return null;
            return words
                .filter(w => w.text.trim().length > 0)
                .map(w => ({ box: [w.bbox.x0, w.bbox.y0, w.bbox.x1, w.bbox.y1] }));
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn('[OCR] PSM=12 fallback 失败:', msg);
            return null;
        }
    }
    async _detectByConnectedComponents(imgBuffer, imgW, imgH) {
        const processed = await sharp(imgBuffer)
            .grayscale()
            .clahe({ width: 4, height: 4, maxSlope: 3 })
            .raw()
            .toBuffer();
        const width = imgW || 340;
        const height = imgH || 195;
        const pixels = new Uint8Array(processed);
        const binary = new Uint8Array(width * height);
        const avgBrightness = pixels.reduce((s, v) => s + v, 0) / pixels.length;
        const isInverted = avgBrightness < 128;
        const blockSize = 11;
        const c = 5;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                let sum = 0, count = 0;
                const halfBlock = blockSize / 2;
                for (let dy = -halfBlock; dy <= halfBlock; dy++) {
                    for (let dx = -halfBlock; dx <= halfBlock; dx++) {
                        const nx = Math.min(Math.max(x + dx, 0), width - 1);
                        const ny = Math.min(Math.max(y + dy, 0), height - 1);
                        sum += pixels[ny * width + nx];
                        count++;
                    }
                }
                const localMean = sum / count;
                const idx = y * width + x;
                const pixelVal = pixels[idx];
                if (isInverted) {
                    binary[idx] = pixelVal > localMean + c ? 255 : 0;
                }
                else {
                    binary[idx] = pixelVal < localMean - c ? 255 : 0;
                }
            }
        }
        const visited = new Uint8Array(width * height);
        const components = [];
        const minArea = width * height * 0.005;
        const maxArea = width * height * 0.25;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = y * width + x;
                if (binary[idx] === 255 && !visited[idx]) {
                    const component = [];
                    const queue = [idx];
                    visited[idx] = 1;
                    while (queue.length > 0) {
                        const cur = queue.shift();
                        const cy = Math.floor(cur / width);
                        const cx = cur % width;
                        component.push({ x: cx, y: cy });
                        const neighbors = [
                            cy > 0 ? cur - width : -1,
                            cy < height - 1 ? cur + width : -1,
                            cx > 0 ? cur - 1 : -1,
                            cx < width - 1 ? cur + 1 : -1,
                        ];
                        for (const n of neighbors) {
                            if (n >= 0 && n < width * height && binary[n] === 255 && !visited[n]) {
                                visited[n] = 1;
                                queue.push(n);
                            }
                        }
                    }
                    if (component.length >= minArea && component.length <= maxArea) {
                        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                        for (const p of component) {
                            minX = Math.min(minX, p.x);
                            minY = Math.min(minY, p.y);
                            maxX = Math.max(maxX, p.x);
                            maxY = Math.max(maxY, p.y);
                        }
                        components.push({ box: [minX, minY, maxX + 1, maxY + 1], area: component.length });
                    }
                }
            }
        }
        const mergeDistance = Math.min(width, height) * 0.08;
        const merged = this._mergeCloseComponents(components, mergeDistance);
        return merged.map(comp => ({ box: comp.box }));
    }
    _mergeCloseComponents(components, mergeDistance) {
        if (components.length === 0)
            return [];
        const merged = [];
        const used = new Set();
        for (let i = 0; i < components.length; i++) {
            if (used.has(i))
                continue;
            const group = [components[i]];
            used.add(i);
            for (let j = i + 1; j < components.length; j++) {
                if (used.has(j))
                    continue;
                for (const g of group) {
                    const cx1 = (g.box[0] + g.box[2]) / 2;
                    const cy1 = (g.box[1] + g.box[3]) / 2;
                    const cx2 = (components[j].box[0] + components[j].box[2]) / 2;
                    const cy2 = (components[j].box[1] + components[j].box[3]) / 2;
                    const dist = Math.sqrt((cx1 - cx2) ** 2 + (cy1 - cy2) ** 2);
                    if (dist < mergeDistance) {
                        group.push(components[j]);
                        used.add(j);
                        break;
                    }
                }
            }
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            let totalArea = 0;
            for (const g of group) {
                minX = Math.min(minX, g.box[0]);
                minY = Math.min(minY, g.box[1]);
                maxX = Math.max(maxX, g.box[2]);
                maxY = Math.max(maxY, g.box[3]);
                totalArea += g.area;
            }
            merged.push({ box: [minX, minY, maxX, maxY], area: totalArea });
        }
        return merged;
    }
    // ── 图片裁剪 ────────────────────────────────────
    async _cropRegion(imgBuffer, box, imgW = 9999, imgH = 9999) {
        const clampedBox = [
            Math.max(0, Math.min(box[0], imgW)),
            Math.max(0, Math.min(box[1], imgH)),
            Math.max(0, Math.min(box[2], imgW)),
            Math.max(0, Math.min(box[3], imgH)),
        ];
        const [x1, y1, x2, y2] = clampedBox;
        const pad = 3;
        const left = Math.max(0, x1 - pad);
        const top = Math.max(0, y1 - pad);
        const width = Math.max(1, Math.min(x2 + pad, imgW) - left);
        const height = Math.max(1, Math.min(y2 + pad, imgH) - top);
        const buffer = await sharp(imgBuffer)
            .extract({ left, top, width, height })
            .toBuffer();
        return { buffer, width, height };
    }
    // ── OCR 集成 ────────────────────────────────────
    /**
     * OCR 分类：ONNX 分类优先（含 softmax 置信度 + top-k 候选）
     * 优化：接受已知裁剪尺寸，避免 OCR classifier 内部 metadata 调用
     */
    async _ocrEnsemble(cropBuffer, cropW, cropH) {
        // ONNX OCR 分类（含置信度 + top-k）
        if (this._onnxOcrReady) {
            try {
                const tOcr = Date.now();
                const { text, confidence, topKChars } = await this.onnxClassifier.classifyWithConfidence(cropBuffer, cropW, cropH);
                console.log(`[OCR-耗时] ONNX classifyWithConfidence: ${Date.now() - tOcr}ms`);
                // 合并 top-1 + top-k 候选为 allResults
                const allResults = new Set();
                if (text && text.trim()) {
                    allResults.add(text.trim());
                }
                for (const ch of topKChars) {
                    allResults.add(ch);
                }
                if (allResults.size > 0) {
                    return {
                        char: text.trim() || '?',
                        confidence: confidence > 0 ? confidence : 0.1,
                        allResults,
                        onnxConfidence: confidence,
                    };
                }
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                console.warn('[OCR] ONNX 分类失败:', msg);
            }
        }
        // ONNX 不可用或完全无结果时不使用 tesseract fallback
        // tesseract 对单字裁剪区域识别率极低且耗时 1-2秒，不值得消耗
        console.log('[OCR] ONNX 无结果，跳过 tesseract fallback（耗时过高）');
        return {
            char: '?',
            confidence: 0,
            allResults: new Set(),
            onnxConfidence: null,
        };
    }
    async _ocrSingle(imgBuffer) {
        try {
            const result = await Tesseract.recognize(imgBuffer, 'chi_sim', {
                tessedit_pageseg_mode: '10',
            });
            return result.data.text.trim();
        }
        catch {
            return '';
        }
    }
    async _otsuBinarize(imgBuffer) {
        return sharp(imgBuffer)
            .grayscale()
            .threshold(128)
            .toBuffer();
    }
    async _claheEnhance(imgBuffer) {
        return sharp(imgBuffer)
            .grayscale()
            .clahe({ width: 4, height: 4, maxSlope: 3 })
            .toBuffer();
    }
    // ── HOG 特征提取 ────────────────────────────────
    async _extractHOGFeature(cropBuffer) {
        const resized = await sharp(cropBuffer)
            .resize(FEAT_SIZE, FEAT_SIZE, { fit: 'fill' })
            .grayscale()
            .clahe({ width: 4, height: 4, maxSlope: 2.0 })
            .raw()
            .toBuffer();
        const pixels = new Uint8Array(resized);
        const darkCount = pixels.filter(v => v < 128).length;
        const lightCount = pixels.filter(v => v >= 128).length;
        const binary = new Uint8Array(FEAT_SIZE * FEAT_SIZE);
        for (let i = 0; i < pixels.length; i++) {
            if (lightCount > darkCount) {
                binary[i] = pixels[i] < 128 ? 255 : 0;
            }
            else {
                binary[i] = pixels[i] >= 128 ? 255 : 0;
            }
        }
        const globalHog = this._computeHOGBlock(binary, FEAT_SIZE, FEAT_SIZE, BLOCK_GLOBAL, STRIDE_GLOBAL, CELL_GLOBAL, NBINS);
        return globalHog;
    }
    _computeHOGBlock(img, imgW, imgH, blockSize, blockStride, cellSize, nbins) {
        const grads = new Float64Array(imgW * imgH);
        const dirs = new Float64Array(imgW * imgH);
        for (let y = 1; y < imgH - 1; y++) {
            for (let x = 1; x < imgW - 1; x++) {
                const gx = img[y * imgW + x + 1] - img[y * imgW + x - 1];
                const gy = img[(y + 1) * imgW + x] - img[(y - 1) * imgW + x];
                grads[y * imgW + x] = Math.sqrt(gx * gx + gy * gy);
                dirs[y * imgW + x] = Math.atan2(gy, gx);
            }
        }
        const cellsX = Math.floor((imgW - cellSize) / cellSize) + 1;
        const cellsY = Math.floor((imgH - cellSize) / cellSize) + 1;
        const cellHists = [];
        for (let cy = 0; cy < cellsY; cy++) {
            for (let cx = 0; cx < cellsX; cx++) {
                const hist = new Float64Array(nbins);
                for (let y = cy * cellSize; y < (cy + 1) * cellSize; y++) {
                    for (let x = cx * cellSize; x < (cx + 1) * cellSize; x++) {
                        if (y < 1 || y >= imgH - 1 || x < 1 || x >= imgW - 1)
                            continue;
                        const mag = grads[y * imgW + x];
                        const dir = dirs[y * imgW + x];
                        const bin = Math.floor(((dir + Math.PI) / (2 * Math.PI)) * nbins) % nbins;
                        hist[bin] += mag;
                    }
                }
                cellHists.push(hist);
            }
        }
        const blocksX = Math.floor((cellsX - blockSize / cellSize) / (blockStride / cellSize)) + 1;
        const blocksY = Math.floor((cellsY - blockSize / cellSize) / (blockStride / cellSize)) + 1;
        const blockCells = blockSize / cellSize;
        const feat = [];
        for (let by = 0; by < blocksY; by++) {
            for (let bx = 0; bx < blocksX; bx++) {
                const blockVec = [];
                for (let ccy = by * (blockStride / cellSize); ccy < by * (blockStride / cellSize) + blockCells; ccy++) {
                    for (let ccx = bx * (blockStride / cellSize); ccx < bx * (blockStride / cellSize) + blockCells; ccx++) {
                        const cellIdx = ccy * cellsX + ccx;
                        if (cellIdx < cellHists.length) {
                            blockVec.push(...cellHists[cellIdx]);
                        }
                    }
                }
                const norm = Math.sqrt(blockVec.reduce((s, v) => s + v * v, 0) + 0.001);
                for (let i = 0; i < blockVec.length; i++) {
                    blockVec[i] = Math.min(blockVec[i] / norm, 0.2);
                }
                const norm2 = Math.sqrt(blockVec.reduce((s, v) => s + v * v, 0) + 0.001);
                for (let i = 0; i < blockVec.length; i++) {
                    feat.push(blockVec[i] / norm2);
                }
            }
        }
        return feat;
    }
    // ── 字体渲染变体 ────────────────────────────────
    /**
     * 渲染单个汉字的变体（优化版：1字号 × 3字体 × 2角度 = 6 变体/字）
     */
    async _renderVariants(char) {
        if (this.variantCache[char]) {
            return this.variantCache[char];
        }
        const variants = [];
        // 优化：单字号 + 双角度（0° 和 15°），减少变体数量
        const sizes = [36]; // 单一中号
        const angles = [0, 15]; // 0° + 正向旋转
        const topFonts = this.fontPaths.slice(0, 3);
        for (const size of sizes) {
            for (const fontPath of topFonts) {
                try {
                    const canvas = createCanvas(size + 30, size + 30);
                    const ctx = canvas.getContext('2d');
                    ctx.fillStyle = 'black';
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                    ctx.fillStyle = 'white';
                    ctx.font = `${size}px "${fontPath.name}"`;
                    const cnWidth = ctx.measureText('测').width;
                    const enWidth = ctx.measureText('A').width;
                    if (cnWidth < 25 || cnWidth < enWidth * 1.3)
                        continue;
                    ctx.fillText(char, 15, size + 5);
                    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                    const pixels = new Uint8Array(canvas.width * canvas.height);
                    for (let i = 0; i < imageData.data.length; i += 4) {
                        pixels[i / 4] = Math.round(0.299 * imageData.data[i] +
                            0.587 * imageData.data[i + 1] +
                            0.114 * imageData.data[i + 2]);
                    }
                    let minX = canvas.width, minY = canvas.height, maxX = 0, maxY = 0;
                    for (let y = 0; y < canvas.height; y++) {
                        for (let x = 0; x < canvas.width; x++) {
                            if (pixels[y * canvas.width + x] > 128) {
                                minX = Math.min(minX, x);
                                minY = Math.min(minY, y);
                                maxX = Math.max(maxX, x);
                                maxY = Math.max(maxY, y);
                            }
                        }
                    }
                    if (maxX <= minX || maxY <= minY)
                        continue;
                    const cropped = new Uint8Array(FEAT_SIZE * FEAT_SIZE);
                    const cropW = maxX - minX + 1;
                    const cropH = maxY - minY + 1;
                    for (let y = 0; y < FEAT_SIZE; y++) {
                        for (let x = 0; x < FEAT_SIZE; x++) {
                            const srcX = Math.floor(x * cropW / FEAT_SIZE) + minX;
                            const srcY = Math.floor(y * cropH / FEAT_SIZE) + minY;
                            cropped[y * FEAT_SIZE + x] = pixels[srcY * canvas.width + srcX];
                        }
                    }
                    for (const angle of angles) {
                        const rotated = angle === 0 ? cropped : this._rotateArray(cropped, FEAT_SIZE, FEAT_SIZE, angle);
                        const binary = new Uint8Array(FEAT_SIZE * FEAT_SIZE);
                        const threshold = 128;
                        const darkPixels = rotated.filter(v => v < threshold).length;
                        const lightPixels = rotated.filter(v => v >= threshold).length;
                        for (let i = 0; i < rotated.length; i++) {
                            if (lightPixels > darkPixels) {
                                binary[i] = rotated[i] < threshold ? 255 : 0;
                            }
                            else {
                                binary[i] = rotated[i] >= threshold ? 255 : 0;
                            }
                        }
                        const feat = this._computeHOGBlock(binary, FEAT_SIZE, FEAT_SIZE, BLOCK_GLOBAL, STRIDE_GLOBAL, CELL_GLOBAL, NBINS);
                        variants.push(feat);
                    }
                }
                catch {
                    continue;
                }
            }
        }
        this.variantCache[char] = variants;
        return variants;
    }
    _rotateArray(pixels, w, h, angleDeg) {
        const result = new Uint8Array(w * h);
        const cx = w / 2;
        const cy = h / 2;
        const rad = -angleDeg * Math.PI / 180;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const srcX = Math.round((x - cx) * Math.cos(rad) - (y - cy) * Math.sin(rad) + cx);
                const srcY = Math.round((x - cx) * Math.sin(rad) + (y - cy) * Math.cos(rad) + cy);
                if (srcX >= 0 && srcX < w && srcY >= 0 && srcY < h) {
                    result[y * w + x] = pixels[srcY * w + srcX];
                }
            }
        }
        return result;
    }
    // ── 字体扫描 ────────────────────────────────────
    _scanFonts() {
        const fontDirs = this._getFontDirs();
        const found = [];
        for (const dir of fontDirs) {
            if (!fs.existsSync(dir))
                continue;
            try {
                const files = fs.readdirSync(dir);
                for (const file of files) {
                    const filePath = path.join(dir, file);
                    const lowerName = file.toLowerCase();
                    if (CHINESE_FONT_PATTERNS.some(pat => lowerName.includes(pat.toLowerCase()))) {
                        if (lowerName.endsWith('.ttf') || lowerName.endsWith('.ttc') || lowerName.endsWith('.otf')) {
                            found.push({ path: filePath, name: file });
                            try {
                                registerFont(filePath, { family: file });
                            }
                            catch { /* ignore */ }
                        }
                    }
                }
            }
            catch {
                continue;
            }
        }
        this.fontPaths = found;
        console.log(`[OCR] 扫描到 ${found.length} 个中文字体`);
    }
    _getFontDirs() {
        const platform = os.platform();
        const dirs = [];
        if (platform === 'win32') {
            const windir = process.env.WINDIR || 'C:\\Windows';
            dirs.push(path.join(windir, 'Fonts'));
        }
        else if (platform === 'darwin') {
            dirs.push('/System/Library/Fonts', '/Library/Fonts', path.join(os.homedir(), 'Library/Fonts'));
        }
        else {
            dirs.push('/usr/share/fonts', '/usr/local/share/fonts', path.join(os.homedir(), '.local/share/fonts'));
        }
        return dirs;
    }
    // ── 相似度计算 ────────────────────────────────────
    _cosineSim(a, b) {
        if (!a || !b || a.length === 0 || b.length === 0)
            return 0;
        const aMean = a.reduce((s, v) => s + v, 0) / a.length;
        const bMean = b.reduce((s, v) => s + v, 0) / b.length;
        let dot = 0, na = 0, nb = 0;
        for (let i = 0; i < a.length; i++) {
            const ai = a[i] - aMean;
            const bi = b[i] - bMean;
            dot += ai * bi;
            na += ai * ai;
            nb += bi * bi;
        }
        na = Math.sqrt(na);
        nb = Math.sqrt(nb);
        if (na < 1e-7 || nb < 1e-7)
            return 0;
        return dot / (na * nb);
    }
    _bestVariantSim(variants, feat) {
        if (!variants || variants.length === 0)
            return 0;
        let best = -1;
        for (const v of variants) {
            const s = this._cosineSim(v, feat);
            if (s > best)
                best = s;
        }
        return best;
    }
    // ── 全排列搜索 ────────────────────────────────────
    _permutationSearch(score, detected, promptText, minDist) {
        const n = promptText.length;
        const m = detected.length;
        function permutations(arr, k) {
            if (k === 0)
                return [[]];
            const result = [];
            for (let i = 0; i < arr.length; i++) {
                const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
                for (const p of permutations(rest, k - 1)) {
                    result.push([arr[i], ...p]);
                }
            }
            return result;
        }
        const indices = Array.from({ length: m }, (_, i) => i);
        const allPerms = permutations(indices, n);
        let bestTotal = -Infinity;
        let bestPerm = null;
        for (const perm of allPerms) {
            let ok = true;
            for (let i = 0; i < perm.length && ok; i++) {
                for (let j = i + 1; j < perm.length && ok; j++) {
                    const dx = detected[perm[i]].x - detected[perm[j]].x;
                    const dy = detected[perm[i]].y - detected[perm[j]].y;
                    if (Math.sqrt(dx * dx + dy * dy) < minDist)
                        ok = false;
                }
            }
            if (!ok)
                continue;
            const total = perm.reduce((sum, di, pi) => sum + score[pi][di], 0);
            if (total > bestTotal) {
                bestTotal = total;
                bestPerm = perm;
            }
        }
        if (!bestPerm) {
            console.warn('[OCR] 无可行分配，放宽距离约束');
            for (const perm of allPerms) {
                const total = perm.reduce((sum, di, pi) => sum + score[pi][di], 0);
                if (total > bestTotal) {
                    bestTotal = total;
                    bestPerm = perm;
                }
            }
        }
        if (!bestPerm)
            return [];
        return bestPerm.map((di, pi) => ({
            x: detected[di].x,
            y: detected[di].y,
            char: promptText[pi],
            matchChar: detected[di].char,
            score: score[pi][di],
        }));
    }
}
//# sourceMappingURL=local-ocr.js.map