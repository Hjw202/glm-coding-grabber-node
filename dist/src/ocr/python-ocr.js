/**
 * Python ddddocr 服务引擎（独立模块）
 * HTTP 调用兼容原 ddddocr 接口：POST /click
 *
 * 用途：当 Node.js 本地 OCR 精度不足时，可 fallback 到 Python ddddocr 服务
 * 需要先启动 Python 端：python captcha/ddddocr_server.py
 */
import { request } from 'undici';
export class PythonOCREngine {
    url;
    constructor(config) {
        this.url = config.ocrServiceUrl || 'http://127.0.0.1:9898';
    }
    /**
     * 识别点选验证码
     * @param imageBase64 验证码图片 base64
     * @param promptText 提示文字
     * @returns 点选坐标数组
     */
    async recognize(imageBase64, promptText) {
        const { statusCode, body } = await request(`${this.url}/click`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: imageBase64, remark: promptText }),
        });
        const responseText = await body.text();
        const result = JSON.parse(responseText);
        if (result.success && result.data?.result) {
            return result.data.result.split('|').map(p => {
                const [x, y] = p.split(',');
                return { x: parseFloat(x), y: parseFloat(y) };
            });
        }
        return [];
    }
}
//# sourceMappingURL=python-ocr.js.map