/**
 * 本地 OCR HTTP 服务（Express 版）
 * 兼容原 Python ddddocr 接口：POST /click, GET /health
 * 使 Node.js 版本可以无缝对接原有的油猴脚本
 *
 * Express 优势：
 * 1. 路由声明式，清晰易维护
 * 2. express.json() 自动解析请求体，无需手动 _readBody
 * 3. cors 中间件自动处理 CORS preflight + 响应头
 * 4. 错误处理中间件统一捕获异常
 */
import express from 'express';
import cors from 'cors';
import { LocalOCREngine } from './ocr/local-ocr.js';
export class OCRServer {
    config;
    ocrEngine;
    app = null;
    server = null;
    constructor(config) {
        // convict 对象有 getProperties() 方法；普通对象直接使用
        const cfg = 'getProperties' in config
            ? config.getProperties()
            : config;
        this.config = cfg;
        this.ocrEngine = new LocalOCREngine(cfg);
    }
    /**
     * 启动 OCR HTTP 服务
     */
    async start() {
        // 预加载 ONNX 检测模型
        await this.ocrEngine.preInit();
        const app = express();
        this.app = app;
        // ── 中间件 ────────────────────────────────────
        // CORS（允许所有来源，与 Python Flask 一致）
        app.use(cors({
            origin: '*',
            methods: ['GET', 'POST', 'OPTIONS'],
            allowedHeaders: ['Content-Type'],
        }));
        // JSON 请求体解析（自动处理 Content-Type: application/json）
        app.use(express.json({ limit: '10mb' }));
        // ── 路由 ────────────────────────────────────
        // GET / — 油猴脚本 checkLocalOcrService 检查根路径连通性
        app.get('/', (_req, res) => {
            res.json({ status: 'ok', engine: 'node-ocr' });
        });
        // GET /health — 健康检查
        app.get('/health', (_req, res) => {
            res.json({
                status: 'ok',
                engine: 'node-ocr',
                fonts: this.ocrEngine.fontPaths.length,
            });
        });
        // POST /click — 验证码识别
        app.post('/click', async (req, res) => {
            const startTime = Date.now();
            try {
                const { image, remark } = req.body;
                if (!image || !remark) {
                    return res.status(400).json({ success: false, message: '缺少参数' });
                }
                const coords = await this.ocrEngine.recognize(image, remark);
                // 与 Python ddddocr_server.py 行为一致：
                // 检测不到目标时返回 {success: false, message: '未检测到任何目标'}
                // 而不是返回 {success: true, data: {result: ""}} 空结果
                // 油猴脚本检查 resp.success && resp.data && resp.data.result
                // 空字符串 "" 是 falsy，会导致无限重试循环
                if (!coords || coords.length === 0) {
                    return res.status(500).json({ success: false, message: '未检测到任何目标' });
                }
                const resultStr = coords.map(c => `${c.x},${c.y}`).join('|');
                const elapsed = Date.now() - startTime;
                console.log(`[OCR] 完成: prompt="${remark}" result="${resultStr}" 耗时=${elapsed}ms`);
                return res.json({
                    success: true,
                    data: { result: resultStr, id: '' },
                });
            }
            catch (e) {
                const elapsed = Date.now() - startTime;
                const message = e instanceof Error ? e.message : String(e);
                console.error(`[OCR] 失败 (${elapsed}ms): ${message}`);
                return res.status(500).json({ success: false, message });
            }
        });
        // ── 404 兜底 ────────────────────────────────
        app.use((_req, res) => {
            res.status(404).json({ error: 'Not Found' });
        });
        // ── 启动监听 ────────────────────────────────────
        const host = this.config.ocrServerHost;
        const port = this.config.ocrServerPort;
        this.server = app.listen(port, host, () => {
            console.log(`OCR 服务启动: http://${host}:${port}`);
        });
    }
    /**
     * 停止服务
     */
    stop() {
        if (this.server) {
            this.server.close();
            console.log('OCR 服务已停止');
        }
    }
}
//# sourceMappingURL=server.js.map