// ==UserScript==
// @name         GLM抢号-v2
// @namespace    05info
// @author       Spanky
// @version      2.2.5
// @description  纯接口抢购 - 无DOM依赖，直接API调用
// @match        https://*.bigmodel.cn/glm-coding*
// @match        https://*.gtimg.com/*
// @match        https://*.captcha.qcloud.com/*
// @require      https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js
// @require      https://cdn.bootcdn.net/ajax/libs/qrcode/1.5.0/qrcode.min.js
// @require      https://cdn.jsdelivr.net/npm/crypto-js@4.2.0/crypto-js.min.js
// @grant        GM_addStyle
// @grant        GM_getResourceText
// @grant        GM_xmlhttpRequest
// @connect      turing.captcha.qcloud.com
// @connect      127.0.0.1:9898
// @connect      127.0.0.1
// @connect      *
// @grant        unsafeWindow
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// ==/UserScript==

(function (win) {
    'use strict';

    // ==================== 检测是否在验证码 iframe 内 ====================
    var _host = '';
    try { _host = location.hostname || ''; } catch (e) {}
    var inCaptchaFrame = _host.indexOf('gtimg.com') >= 0 || _host.indexOf('captcha.qcloud.com') >= 0;

    if (inCaptchaFrame) {
        console.log('%c[CaptchaSolver] iframe 模式启动, host=' + _host, 'color:#f0c040');
        initCaptchaSolver();
        return;
    }

    // ==================== 验证码自动解题（iframe 内运行） ====================
    function initCaptchaSolver() {
        var CLICK_OCR_URL = 'http://127.0.0.1:9898/click';

        function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
        function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
        function getAntiDetect() {
            try { return GM_getValue('v2_anti_detect') === 'true' || GM_getValue('v2_anti_detect') === true; } catch (e) {}
            try { return localStorage.getItem('v2_anti_detect') === 'true'; } catch (e) {}
            return false;
        }
        function log(msg) { console.log('%c[CaptchaSolver] ' + msg, 'color:#58a6ff'); }

        function fetchImage(url) {
            return new Promise(function (resolve, reject) {
                if (typeof GM_xmlhttpRequest !== 'undefined') {
                    GM_xmlhttpRequest({
                        method: 'GET', url: url, responseType: 'blob',
                        onload: function (r) {
                            var reader = new FileReader();
                            reader.onload = function () { resolve(reader.result); };
                            reader.readAsDataURL(r.response);
                        },
                        onerror: function () { reject(new Error('下载图片失败')); }
                    });
                } else {
                    fetch(url).then(function (r) { return r.blob(); })
                    .then(function (b) {
                        var reader = new FileReader();
                        reader.onload = function () { resolve(reader.result); };
                        reader.readAsDataURL(b);
                    }).catch(reject);
                }
            });
        }

        function callClickOcr(imgData, text) {
            var base64 = imgData.replace(/^data:image\/\w+;base64,/, '');
            var body = JSON.stringify({ image: base64, remark: text });
            if (typeof GM_xmlhttpRequest !== 'undefined') {
                return new Promise(function (resolve, reject) {
                    GM_xmlhttpRequest({
                        method: 'POST', url: CLICK_OCR_URL,
                        headers: { 'Content-Type': 'application/json' },
                        data: body,
                        onload: function (r) {
                            try { resolve(JSON.parse(r.responseText)); }
                            catch (e) { reject(new Error('响应解析失败')); }
                        },
                        onerror: function () { reject(new Error('ddddocr 连接失败')); }
                    });
                });
            }
            return fetch(CLICK_OCR_URL, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body
            }).then(function (r) { return r.json(); });
        }

        async function ocrRecognize(imgData, text) {
            try {
                var resp = await callClickOcr(imgData, text);
                log('ddddocr: ' + JSON.stringify(resp).substring(0, 150));
                if (resp.success && resp.data && resp.data.result) {
                    return resp.data.result.split('|').map(function (p) {
                        var xy = p.split(',');
                        return { x: parseFloat(xy[0]), y: parseFloat(xy[1]) };
                    });
                }
            } catch (e) { log('ddddocr 失败: ' + e.message); }
            return [];
        }

        function getImageSize(dataUrl) {
            return new Promise(function (resolve) {
                var img = new Image();
                img.onload = function () { resolve({ w: img.naturalWidth, h: img.naturalHeight }); };
                img.onerror = function () { resolve(null); };
                img.src = dataUrl;
            });
        }

        function simulateClick(el, x, y, imgW, imgH) {
            var rect = el.getBoundingClientRect();
            var scaleX = imgW > 0 ? rect.width / imgW : 1;
            var scaleY = imgH > 0 ? rect.height / imgH : 1;
            // 点击偏移与防检测开关无关，始终带随机偏移，模拟真人落点散布（±20px）
            var offsetX = (Math.random() - 0.5) * 40;
            var offsetY = (Math.random() - 0.5) * 40;
            var cx = rect.left + x * scaleX + offsetX;
            var cy = rect.top + y * scaleY + offsetY;
            var win = el.ownerDocument.defaultView || window;

            var base = { clientX: cx, clientY: cy, bubbles: true, cancelable: true, view: win };
            var pointer = Object.assign({}, base, {
                pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, pressure: 0.5
            });

            try { if (win.PointerEvent) el.dispatchEvent(new win.PointerEvent('pointerdown', pointer)); } catch (e) {}
            el.dispatchEvent(new win.MouseEvent('mousedown', base));
            try { if (win.PointerEvent) el.dispatchEvent(new win.PointerEvent('pointerup', pointer)); } catch (e) {}
            el.dispatchEvent(new win.MouseEvent('mouseup', base));
            el.dispatchEvent(new win.MouseEvent('click', base));
        }

        function isSolved() {
            var el = document.querySelector('.tc-success');
            return el && el.style.visibility !== 'hidden' && el.style.visibility !== '';
        }

        function hasError() {
            var noteEl = document.querySelector('#tcaptcha_note');
            if (!noteEl) return false;
            var noteWrap = noteEl.closest('.tc-note');
            return noteWrap && noteWrap.style.visibility !== 'hidden' && noteWrap.style.visibility !== '';
        }

        var solving = false;
        var lastBgUrl = '';

        async function trySolveOnce() {
            var bgEl = document.querySelector('#slideBg');
            if (!bgEl) return 'wait';

            var bgStyle = bgEl.style.backgroundImage || '';
            var match = bgStyle.match(/url\(["']?([^"')]+)/);
            if (!match) return 'wait';

            if (isSolved()) return 'solved';

            if (hasError()) {
                log('错误提示，刷新');
                var rb = document.querySelector('#reload');
                if (rb) rb.click();
                lastBgUrl = '';
                await sleep(1500);
                return 'retry';
            }

            var bgUrl = match[1];
            if (bgUrl === lastBgUrl) return 'same';
            lastBgUrl = bgUrl;

            var instrEl = document.querySelector('#instructionText');
            if (!instrEl) return 'wait';
            var rawText = instrEl.textContent || '';
            if (rawText.indexOf('错误') >= 0 || rawText.indexOf('重试') >= 0 || rawText.indexOf('失败') >= 0) {
                log('错误文本，刷新');
                var rb2 = document.querySelector('#reload');
                if (rb2) rb2.click();
                lastBgUrl = '';
                await sleep(1500);
                return 'retry';
            }
            var text = rawText.replace(/请依次点击[：:]\s*/, '').replace(/\s+/g, '').trim();
            log('目标字符: ' + text);

            var imgData;
            try { imgData = await fetchImage(bgUrl); }
            catch (e) { log('图片下载失败: ' + e.message); return 'retry'; }

            var imgSize = await getImageSize(imgData);
            var imgW = imgSize ? imgSize.w : 340;
            var imgH = imgSize ? imgSize.h : 195;

            var coords = await ocrRecognize(imgData, text);
            if (!coords || coords.length === 0) { log('OCR 无结果'); return 'retry'; }

            log('坐标: ' + coords.map(function (c) { return c.x + ',' + c.y; }).join(' | ') + ' (' + imgW + 'x' + imgH + ')');

            for (var i = 0; i < coords.length; i++) {
                simulateClick(bgEl, coords[i].x, coords[i].y, imgW, imgH);
                await sleep(getAntiDetect() ? randInt(300, 600) : 150);
            }

            await sleep(getAntiDetect() ? randInt(400, 700) : 300);
            var confirmBtn = document.querySelector('.verify-btn');
            if (confirmBtn) confirmBtn.click();
            return 'clicked';
        }

        async function solveCurrentCaptcha() {
            if (solving) return;
            solving = true;
            for (var i = 0; i < 15; i++) {
                if (isSolved()) { log('验证通过!'); solving = false; return; }
                var result = await trySolveOnce();
                if (result === 'solved') { log('验证通过!'); solving = false; return; }
                if (result === 'same' || result === 'wait') { await sleep(800); continue; }
                if (result === 'clicked') {
                    await sleep(1500);
                    if (isSolved()) { log('验证通过!'); solving = false; return; }
                    if (hasError()) {
                        log('识别错误，刷新重试');
                        var refreshBtn = document.querySelector('#reload');
                        if (refreshBtn) refreshBtn.click();
                        lastBgUrl = '';
                        await sleep(1500);
                    }
                    continue;
                }
                await sleep(800);
            }
            solving = false;
        }

        function checkAndSolve() {
            if (solving || isSolved()) return;
            var bgEl = document.querySelector('#slideBg');
            if (!bgEl) return;
            var bgStyle = bgEl.style.backgroundImage || '';
            if (!bgStyle) return;
            solveCurrentCaptcha();
        }

        log('验证码解题器已启动 (持续监听, GM=' + (typeof GM_xmlhttpRequest !== 'undefined') + ')');
        var observer = new MutationObserver(function () { setTimeout(checkAndSolve, 100); });
        observer.observe(document.body || document.documentElement, {
            childList: true, subtree: true, attributes: true, attributeFilter: ['style']
        });
        setTimeout(checkAndSolve, 1000);
        setInterval(checkAndSolve, 2000);
    }

    // ==================== 产品ID映射（静态默认值，会被 batch-preview 动态更新） ====================
    // productId -> 静态配置（unit/type 用于分类）
    var PRODUCT_STATIC = {
        'product-02434c': { unit: 'month',   type: 'lite', name: 'Lite 月付' },
        'product-1df3e1': { unit: 'month',   type: 'pro',  name: 'Pro 月付'  },
        'product-2fc421': { unit: 'month',   type: 'max',  name: 'Max 月付'  },
        'product-b8ea38': { unit: 'quarter', type: 'lite', name: 'Lite 季付' },
        'product-fef82f': { unit: 'quarter', type: 'pro',  name: 'Pro 季付'  },
        'product-5d3a03': { unit: 'quarter', type: 'max',  name: 'Max 季付'  },
        'product-70a804': { unit: 'year',    type: 'lite', name: 'Lite 年付' },
        'product-5643e6': { unit: 'year',    type: 'pro',  name: 'Pro 年付'  },
        'product-d46f8b': { unit: 'year',    type: 'max',  name: 'Max 年付'  }
    };

    var PRODUCTS = {
        month: {
            lite: { productId: 'product-02434c', name: 'Lite 月付', price: 49,   soldOut: true },
            pro:  { productId: 'product-1df3e1', name: 'Pro 月付',  price: 149,  soldOut: true },
            max:  { productId: 'product-2fc421', name: 'Max 月付',  price: 469,  soldOut: true }
        },
        quarter: {
            lite: { productId: 'product-b8ea38', name: 'Lite 季付', price: 147,  soldOut: true },
            pro:  { productId: 'product-fef82f', name: 'Pro 季付',  price: 447,  soldOut: true },
            max:  { productId: 'product-5d3a03', name: 'Max 季付',  price: 1407, soldOut: true }
        },
        year: {
            lite: { productId: 'product-70a804', name: 'Lite 年付', price: 588,  soldOut: true },
            pro:  { productId: 'product-5643e6', name: 'Pro 年付',  price: 1788, soldOut: true },
            max:  { productId: 'product-d46f8b', name: 'Max 年付',  price: 5628, soldOut: true }
        }
    };

    // 用 batch-preview 响应动态更新 PRODUCTS
    function updateProductsFromBatchPreview(productList) {
        if (!Array.isArray(productList)) return;
        var updated = 0;
        productList.forEach(function (p) {
            var staticInfo = PRODUCT_STATIC[p.productId];
            if (!staticInfo) return;
            var target = PRODUCTS[staticInfo.unit] && PRODUCTS[staticInfo.unit][staticInfo.type];
            if (!target) return;
            target.price = p.originalAmount || target.price;
            target.payAmount = p.payAmount;
            target.soldOut = !!p.soldOut;
            target.renewAmount = p.renewAmount;
            updated++;
        });
        log('产品', '已更新 ' + updated + ' 个产品价格/库存');
    }

    // ==================== 配置 ====================
    var CONFIG = {
        BUY_TIME_DEFAULT: '10:00:00',
        PACKAGE_TYPE_DEFAULT: 'quarter',
        TIER_DEFAULT: 'max',
        INVITATION_CODE: 'V5UCF6QKLX',
        CAPTCHA_APP_ID: '196026326',
        OCR_BACKEND: 'ddddocr',
        DDDDOCR_URL: 'http://127.0.0.1:9898/click',
        CAPTCHA_MAX_RETRY: 10,
        RETRY_ON_BUSY: 0,
        RETRY_INTERVAL: 300,
        // 预存 token 之间 preview 请求间隔（ms）
        PRECACHE_INTERVAL: 1800,
        ENABLE_MANUAL_BIZID: false
    };

    // ==================== 状态 ====================
    var state = {
        running: false,
        timer: null,
        captchaHandling: false,
        userInfo: null,
        customerNumber: null,
        customerName: '',
        cachedTokens: [],
        lockOrderDone: false,
        lockOrderInProgress: false,
        precacheRunning: false
    };

    // ==================== 服务器时间同步 ====================
    var serverTimeOffset = 0; // ms, positive = server ahead

    async function measureServerOffset() {
        var offsets = [];
        for (var i = 0; i < 5; i++) {
            try {
                var t0 = performance.now();
                var wallBefore = Date.now();
                var resp = await fetch(location.origin + '/', {
                    method: 'HEAD', credentials: 'include', cache: 'no-store'
                });
                var t1 = performance.now();
                var dateStr = resp.headers.get('Date');
                if (!dateStr) continue;
                var serverTs = new Date(dateStr).getTime();
                var rtt = t1 - t0;
                var localMid = wallBefore + rtt / 2;
                offsets.push(serverTs - localMid);
            } catch (e) {
                log('时间同步', '采样失败: ' + e.message);
            }
            if (i < 4) await sleep(300);
        }
        if (offsets.length === 0) return 0;
        offsets.sort(function(a, b) { return a - b; });
        return offsets[Math.floor(offsets.length / 2)];
    }

    async function syncServerTime() {
        var offset = await measureServerOffset();
        serverTimeOffset = offset;
        var direction = offset > 0 ? '服务器快' : '本机快';
        log('时间同步', 'offset=' + offset.toFixed(0) + 'ms (' + direction + Math.abs(offset).toFixed(0) + 'ms)');
        // 面板上永久显示偏移量
        var offsetEl = document.getElementById('v2-time-offset');
        if (offsetEl) {
            offsetEl.textContent = (offset > 0 ? '+' : '') + (offset / 1000).toFixed(2) + 's';
            offsetEl.title = '时钟偏移: ' + direction + Math.abs(offset).toFixed(0) + 'ms';
        }
    }

    function getServerTime() {
        return Date.now() + serverTimeOffset;
    }

    // ==================== 连接预热 ====================
    var preheatTimer = null;

    function startConnectionPreheat() {
        if (preheatTimer) return;
        log('预热', '开始连接预热 (每2s一次 batch-preview)');
        preheatTimer = setInterval(function() {
            var xhr = new XMLHttpRequest();
            xhr.open('POST', '/api/biz/pay/batch-preview');
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.send(JSON.stringify({ invitationCode: getQueryString('ic') || CONFIG.INVITATION_CODE }));
        }, 2000);
    }

    function stopConnectionPreheat() {
        if (preheatTimer) {
            clearInterval(preheatTimer);
            preheatTimer = null;
            log('预热', '停止连接预热');
        }
    }

    var TOKEN_MAX_AGE = 180000;

    // ==================== 持久化存储（GM 优先，fallback localStorage） ====================
    function saveSetting(key, value) {
        console.log('[v2-storage] save', key, '=', value, '| GM_setValue?', typeof GM_setValue !== 'undefined');
        try { if (typeof GM_setValue !== 'undefined') GM_setValue(key, value); } catch (e) { console.warn('[v2-storage] GM_setValue fail', key, e); }
        try { localStorage.setItem(key, String(value)); } catch (e) { console.warn('[v2-storage] localStorage.setItem fail', key, e); }
    }
    function loadSetting(key, defaultVal) {
        var val = null;
        var gmVal = null;
        var lsVal = null;
        try { if (typeof GM_getValue !== 'undefined') gmVal = GM_getValue(key); } catch (e) {}
        try { lsVal = localStorage.getItem(key); } catch (e) {}
        val = (gmVal !== null && gmVal !== undefined) ? gmVal : lsVal;
        var result = (val !== null && val !== undefined) ? val : defaultVal;
        console.log('[v2-storage] load', key, '| GM=', gmVal, '| LS=', lsVal, '| default=', defaultVal, '→ result=', result);
        return result;
    }

    function getAntiDetect() {
        try { return GM_getValue('v2_anti_detect') === 'true' || GM_getValue('v2_anti_detect') === true; } catch (e) {}
        try { return localStorage.getItem('v2_anti_detect') === 'true'; } catch (e) {}
        return false;
    }

    function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

    // ==================== 工具函数 ====================
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    function log(tag, msg) {
        var time = new Date().toLocaleTimeString();
        console.log('[' + time + '][' + tag + '] ' + msg);
        updateLog(tag + ': ' + msg);
    }

    function getQueryString(name) {
        var reg = new RegExp('(^|&)' + name + '=([^&]*)(&|$)', 'i');
        var r = window.location.search.substr(1).match(reg);
        return r ? decodeURI(r[2]) : null;
    }

    // ==================== Auth ====================
    // Token 存在 cookie: bigmodel_token_production
    // OrgId / ProjectId 存在 localStorage
    var AUTH_COOKIE_KEY = 'bigmodel_token_production';
    var ORG_LS_KEY = 'Bigmodel-Organization';
    var PROJECT_LS_KEY = 'Bigmodel-Project';

    function getCookie(name) {
        var m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
        return m ? decodeURIComponent(m[1]) : '';
    }

    function getAuthHeaders() {
        var token = getCookie(AUTH_COOKIE_KEY);
        var orgId = localStorage.getItem(ORG_LS_KEY) || '';
        var projectId = localStorage.getItem(PROJECT_LS_KEY) || '';
        var headers = { 'Content-Type': 'application/json' };
        if (token) {
            headers['Authorization'] = token;
            headers['Bigmodel-Organization'] = orgId;
            headers['Bigmodel-Project'] = projectId;
        }
        return headers;
    }

    // ==================== API 调用 ====================
    function apiRequest(method, url, data) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open(method, '/api' + url);
            var headers = getAuthHeaders();
            for (var key in headers) {
                xhr.setRequestHeader(key, headers[key]);
            }
            xhr.onload = function () {
                try {
                    var resp = JSON.parse(xhr.responseText);
                    resolve(resp);
                } catch (e) {
                    reject(new Error('非JSON响应: HTTP ' + xhr.status));
                }
            };
            xhr.onerror = function () { reject(new Error('网络错误')); };
            if (data) {
                xhr.send(JSON.stringify(data));
            } else {
                xhr.send();
            }
        });
    }

    // 获取用户信息
    function fetchCustomerInfo() {
        return apiRequest('GET', '/biz/customer/getCustomerInfo');
    }

    // 批量预览（获取各产品最新价格和售卖状态）
    function fetchBatchPreview(params) {
        return apiRequest('POST', '/biz/pay/batch-preview', params);
    }

    // 单个产品预览（验证码通过后调用，获取 bizId）
    function fetchPreview(params) {
        return apiRequest('POST', '/biz/pay/preview', params);
    }

    // 查询支付状态
    function fetchPayStatus(bizId) {
        return apiRequest('GET', '/biz/pay/status?key=' + encodeURIComponent(bizId));
    }

    // 锁单（create-sign）
    function tryLockOrder(previewData) {
        return new Promise(function (resolve) {
            if (state.lockOrderInProgress || state.lockOrderDone) {
                resolve({ success: false, code: 'SKIP', msg: state.lockOrderDone ? '已锁单' : '锁单进行中' });
                return;
            }
            state.lockOrderInProgress = true;

            var customerId = state.customerNumber;
            if (!customerId) {
                log('锁单', '无法获取 customerId');
                state.lockOrderInProgress = false;
                resolve({ success: false, code: 'NO_CUSTOMER', msg: '无法获取 customerId' });
                return;
            }

            var invitationCode = getQueryString('ic') || CONFIG.INVITATION_CODE;
            var signUrl = previewData.lastSubscriptionSummary ? '/biz/pay/product/update/sign' : '/biz/pay/create-sign';

            apiRequest('POST', signUrl, {
                payType: 'ALI',
                productId: previewData.productId,
                customerId: customerId,
                bizId: previewData.bizId,
                invitationCode: invitationCode
            }).then(function (resp) {
                state.lockOrderInProgress = false;
                if (resp.code === 200 && resp.data && resp.data.sign) {
                    state.lockOrderDone = true;
                    log('锁单', '成功！bizId=' + previewData.bizId);
                    resolve({ success: true, sign: resp.data.sign, raw: resp });
                } else {
                    log('锁单', '失败: ' + (resp.msg || resp.code));
                    resolve({ success: false, code: resp.code, msg: resp.msg, raw: resp });
                }
            }).catch(function (e) {
                state.lockOrderInProgress = false;
                log('锁单', '异常: ' + e.message);
                resolve({ success: false, code: 'ERR', msg: e.message, raw: null });
            });
        });
    }

    // 展示锁单后的支付二维码
    function showPaymentQRPopup(signUrl, priceData) {
        var amount = priceData.thirdPartyAmount || priceData.payAmount;
        var productName = priceData.productName || '';

        // @require 加载的 QRCode 在油猴沙箱全局，不在 unsafeWindow 上
        var QR = (typeof QRCode !== 'undefined') ? QRCode
            : (typeof win.QRCode !== 'undefined') ? win.QRCode : null;

        if (!QR) {
            log('支付', 'QRCode 库未就绪');
            return;
        }

        QR.toDataURL(signUrl, {
            width: 600, margin: 4, errorCorrectionLevel: 'L'
        }, function (err, qrDataUrl) {
            if (err) {
                log('支付', 'QR生成失败: ' + err.message);
                return;
            }
            showQRPopup(qrDataUrl, amount, productName, '锁单成功！请用支付宝扫码支付', signUrl, true);
            // 自动下载二维码
            var a = document.createElement('a');
            a.href = qrDataUrl;
            a.download = 'pay_qr_' + Date.now() + '.png';
            a.click();
            // window.open 打开包含二维码的页面，多 tab 时方便识别哪个成功
            try {
                var w = window.open('', '_blank');
                if (w) {
                    w.document.write('<html><head><title>抢购成功 - 请扫码支付</title></head><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;font-family:system-ui,sans-serif;background:#f5f5f5;">' +
                        '<h2 style="color:#333;">抢购成功！请扫码支付</h2>' +
                        '<p style="color:#666;">' + (productName || '') + '　<strong style="color:#e6a23c;font-size:24px;">¥' + amount + '</strong></p>' +
                        '<img src="' + qrDataUrl + '" style="width:350px;height:350px;border:2px solid #eee;border-radius:8px;" />' +
                        '<p style="color:#999;font-size:13px;margin-top:12px;">请尽快用支付宝扫码支付</p>' +
                        '</body></html>');
                    w.document.close();
                }
            } catch (e) {}
            log('支付', '支付二维码已弹出');
        });
    }
    win.showPaymentQRPopup = showPaymentQRPopup;


    // ==================== 验证码识别 ====================
    function fetchImageBase64(url) {
        return new Promise(function (resolve, reject) {
            if (typeof GM_xmlhttpRequest !== 'undefined') {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: url,
                    responseType: 'blob',
                    onload: function (res) {
                        var reader = new FileReader();
                        reader.onloadend = function () {
                            resolve(String(reader.result).split(',')[1]);
                        };
                        reader.onerror = reject;
                        reader.readAsDataURL(res.response);
                    },
                    onerror: reject
                });
            } else {
                fetch(url).then(function (r) { return r.blob(); }).then(function (blob) {
                    var reader = new FileReader();
                    reader.onloadend = function () { resolve(String(reader.result).split(',')[1]); };
                    reader.onerror = reject;
                    reader.readAsDataURL(blob);
                }).catch(reject);
            }
        });
    }

    function getImageSize(base64) {
        return new Promise(function (resolve, reject) {
            var img = new Image();
            img.onload = function () { resolve({ w: img.naturalWidth, h: img.naturalHeight }); };
            img.onerror = reject;
            img.src = 'data:image/png;base64,' + base64;
        });
    }

    function ddddocrRecognize(base64, chars) {
        return new Promise(function (resolve, reject) {
            var payload = JSON.stringify({ image: base64, remark: chars });
            var handleRes = function (text) {
                try {
                    var obj = JSON.parse(text);
                    if (obj.success && obj.data && obj.data.result) {
                        var points = obj.data.result.split('|').map(function (p) {
                            var xy = p.split(',');
                            return { x: parseFloat(xy[0]), y: parseFloat(xy[1]) };
                        });
                        resolve({ id: obj.data.id || '', points: points });
                    } else {
                        reject(new Error('ddddocr fail: ' + text));
                    }
                } catch (e) { reject(e); }
            };
            if (typeof GM_xmlhttpRequest !== 'undefined') {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: CONFIG.DDDDOCR_URL,
                    headers: { 'Content-Type': 'application/json' },
                    data: payload,
                    onload: function (res) { handleRes(res.responseText); },
                    onerror: function () { reject(new Error('ddddocr 服务不可用')); }
                });
            } else {
                fetch(CONFIG.DDDDOCR_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: payload
                }).then(function (r) { return r.text(); }).then(handleRes).catch(function () {
                    reject(new Error('ddddocr 服务不可用'));
                });
            }
        });
    }

    function recognizeCaptcha(base64, chars) {
        return ddddocrRecognize(base64, chars);
    }

    // ==================== 腾讯验证码交互 ====================
    // 核心：通过 TencentCaptcha SDK 弹出验证码，用户完成后拿到 ticket+randstr
    // 同时尝试自动识别点选验证码

    // 获取 TencentCaptcha 构造函数（兼容油猴沙箱）
    function getTencentCaptcha() {
        return win.TencentCaptcha || window.TencentCaptcha || null;
    }

    function loadCaptchaScript() {
        return new Promise(function (resolve, reject) {
            if (getTencentCaptcha()) {
                resolve();
                return;
            }
            // 页面可能已经在加载，先等一等
            var waitCount = 0;
            var waitTimer = setInterval(function () {
                waitCount++;
                if (getTencentCaptcha()) {
                    clearInterval(waitTimer);
                    resolve();
                    return;
                }
                if (waitCount > 10) {
                    clearInterval(waitTimer);
                    // 手动加载
                    var script = document.createElement('script');
                    script.src = 'https://turing.captcha.qcloud.com/TCaptcha.js';
                    script.onload = function () {
                        // 等 SDK 初始化
                        setTimeout(function () {
                            if (getTencentCaptcha()) resolve();
                            else reject(new Error('TencentCaptcha SDK 加载后未初始化'));
                        }, 500);
                    };
                    script.onerror = function () { reject(new Error('TCaptcha.js 加载失败')); };
                    document.head.appendChild(script);
                }
            }, 500);
        });
    }

    // 弹出腾讯验证码并获取 ticket（自动识别+点击）
    function getCaptchaTicket() {
        return new Promise(function (resolve, reject) {
            var TC = getTencentCaptcha();
            if (!TC) {
                reject(new Error('验证码SDK未加载'));
                return;
            }

            var done = false;
            var captchaInstance = new TC(CONFIG.CAPTCHA_APP_ID, function (res) {
                done = true;
                clearTimeout(safetyTimer);
                if (res.ret === 0) {
                    resolve({ ticket: res.ticket, randstr: res.randstr });
                } else if (res.ret === 2) {
                    reject(new Error('用户取消验证'));
                } else {
                    reject(new Error('验证失败: ret=' + res.ret));
                }
            }, {
                mode: 'bind',
                type: 'popup',
                enableDarkMode: false,
                timeout: 60000
            });

            captchaInstance.show();

            // 兜底超时：如果 SDK 120 秒内没有回调，主动 reject
            var safetyTimer = setTimeout(function () {
                if (!done) {
                    done = true;
                    reject(new Error('验证码超时(120s)'));
                }
            }, 120000);

            // 延时启动自动识别（等验证码弹窗渲染完成）
            setTimeout(function () {
                if (!done) {
                    autoSolveCaptchaLoop(function () { return done; });
                }
            }, 800);
        });
    }

    // 自动识别验证码循环
    async function autoSolveCaptchaLoop(isDone) {
        for (var attempt = 0; attempt < CONFIG.CAPTCHA_MAX_RETRY; attempt++) {
            if (isDone()) return;

            try {
                log('验证码', '自动识别第 ' + (attempt + 1) + '/' + CONFIG.CAPTCHA_MAX_RETRY + ' 次');
                await autoSolveCaptchaOnce(isDone);

                // 等待结果
                await sleep(300);
                if (isDone()) {
                    log('验证码', '自动识别成功');
                    return;
                }

                // 检查是否有错误提示
                var errorEl = document.querySelector('.tencent-captcha-dy__verify-error-text');
                if (errorEl && isElementTrulyVisible(errorEl)) {
                    log('验证码', '识别错误，刷新重试');
                    var refreshBtn = document.querySelector('.tencent-captcha-dy__footer-icon--refresh img');
                    if (refreshBtn) refreshBtn.click();
                    await sleep(1000);
                    continue;
                }
            } catch (e) {
                log('验证码', '自动识别异常: ' + e.message);
                if (isDone()) return;
                await sleep(500);
            }
        }
        // 所有尝试用尽，不等待手动，直接 destroy 让上层重试
        log('验证码', '自动识别用尽，关闭验证码重新开始');
        try {
            var closeBtn = document.querySelector('.tencent-captcha-dy__close-btn') ||
                document.querySelector('#tcaptcha_transform_dy .close-btn');
            if (closeBtn) closeBtn.click();
        } catch (e) {}
    }

    // 单次自动识别
    async function autoSolveCaptchaOnce(isDone) {
        var bgEl = document.querySelector('.tencent-captcha-dy__verify-bg-img');
        if (!bgEl || !isElementTrulyVisible(bgEl)) {
            throw new Error('验证码未显示');
        }

        var bgImage = bgEl.style.backgroundImage || '';
        if (bgImage.indexOf('url(') === -1) {
            throw new Error('验证码背景图未加载');
        }

        // 提取提示汉字
        var headerEl = document.querySelector('.tencent-captcha-dy__header-text');
        if (!headerEl) throw new Error('未找到提示文字');
        var text = headerEl.textContent || '';
        var allChars = text.match(/[\u4e00-\u9fa5]/g) || [];
        var chars = allChars.filter(function (c) { return '请依次点击'.indexOf(c) < 0; }).join('');
        if (!chars) throw new Error('未提取到汉字');

        // 提取背景图 URL
        var urlMatch = bgImage.match(/url\(["']?([^"')]+)["']?\)/);
        if (!urlMatch) throw new Error('未提取到背景图URL');
        var bgUrl = urlMatch[1];

        log('验证码', '汉字: ' + chars);

        // 下载+识别
        var t0 = performance.now();
        var base64 = await fetchImageBase64(bgUrl);
        var size = await getImageSize(base64);
        var result = await recognizeCaptcha(base64, chars);
        log('验证码', 'OCR耗时: ' + (performance.now() - t0).toFixed(0) + 'ms');

        if (isDone()) return;

        // 模拟点击
        var antiDetect = getAntiDetect();
        for (var i = 0; i < result.points.length; i++) {
            if (isDone()) return;
            clickOnCaptchaImage(bgEl, result.points[i], size);
            await sleep(antiDetect ? randInt(300, 600) : 120);
        }

        // 点击确认
        await sleep(antiDetect ? randInt(400, 700) : 100);
        var confirmBtn = document.querySelector('.tencent-captcha-dy__verify-confirm-btn');
        if (confirmBtn && !isDone()) {
            confirmBtn.click();
        }
    }

    // 在验证码图片上模拟点击
    function clickOnCaptchaImage(bgEl, point, imgSize) {
        var rect = bgEl.getBoundingClientRect();
        var scaleX = rect.width / imgSize.w;
        var scaleY = rect.height / imgSize.h;
        // 点击偏移与防检测开关无关，始终带随机偏移，模拟真人落点散布（±15px）
        var offsetX = (Math.random() - 0.5) * 30;
        var offsetY = (Math.random() - 0.5) * 30;
        var clientX = rect.left + point.x * scaleX + offsetX;
        var clientY = rect.top + point.y * scaleY + offsetY;

        var baseOpts = {
            bubbles: true, cancelable: true,
            clientX: clientX, clientY: clientY,
            screenX: clientX, screenY: clientY,
            button: 0, buttons: 1
        };
        var pointerOpts = Object.assign({}, baseOpts, {
            pointerId: 1, pointerType: 'mouse', isPrimary: true,
            width: 1, height: 1, pressure: 0.5
        });

        bgEl.dispatchEvent(new MouseEvent('mouseover', baseOpts));
        bgEl.dispatchEvent(new MouseEvent('mousemove', baseOpts));
        if (window.PointerEvent) {
            bgEl.dispatchEvent(new PointerEvent('pointerdown', pointerOpts));
        }
        bgEl.dispatchEvent(new MouseEvent('mousedown', baseOpts));
        if (window.PointerEvent) {
            bgEl.dispatchEvent(new PointerEvent('pointerup', pointerOpts));
        }
        bgEl.dispatchEvent(new MouseEvent('mouseup', baseOpts));
        bgEl.dispatchEvent(new MouseEvent('click', baseOpts));
    }

    function isElementTrulyVisible(el) {
        if (!el) return false;
        var node = el;
        while (node && node.nodeType === 1) {
            var style = window.getComputedStyle(node);
            if (style.display === 'none') return false;
            if (style.visibility === 'hidden') return false;
            if (parseFloat(style.opacity) === 0) return false;
            node = node.parentElement;
        }
        var rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        if (rect.right <= 0 || rect.bottom <= 0) return false;
        if (rect.left >= window.innerWidth || rect.top >= window.innerHeight) return false;
        return true;
    }

    // ==================== Token 预存管理 ====================
    function addCachedToken(ticket, randstr) {
        state.cachedTokens.push({
            ticket: ticket,
            randstr: randstr,
            timestamp: Date.now()
        });
        updateTokenDisplay();
    }

    function getValidCachedTokens() {
        var now = Date.now();
        return state.cachedTokens.filter(function (t) {
            return (now - t.timestamp) < TOKEN_MAX_AGE && !t.previewSent;
        });
    }

    function clearCachedTokens() {
        state.cachedTokens = [];
        updateTokenDisplay();
        log('预存', '已清空');
    }

    function updateTokenDisplay() {
        var tbody = document.getElementById('v2-token-tbody');
        if (!tbody) return;

        var tokens = state.cachedTokens;
        var html = '';
        tokens.forEach(function (t, i) {
            var short = t.ticket.substring(0, 8);
            var now = Date.now();
            var expired = t.source !== '实时' && (now - t.timestamp) >= TOKEN_MAX_AGE;
            var cls = expired ? ' v2-token-expired' : '';

            // 请求时间：优先用 previewSentTime，否则用 timestamp
            var timeStr = t.previewSentTime
                ? new Date(t.previewSentTime).toLocaleTimeString()
                : new Date(t.timestamp).toLocaleTimeString();

            var sourceTag = t.source === '实时'
                ? '<span class="v2-tag v2-tag-sending">实时</span>'
                : '';

            var previewText = '-';
            if (t.previewResult) {
                if (t.previewResult.success) previewText = '<span class="v2-tag v2-tag-ok">成功</span>';
                else if (t.previewResult.soldOut) previewText = '<span class="v2-tag v2-tag-warn">售罄</span>';
                else previewText = '<span class="v2-tag v2-tag-err">' + (t.previewResult.code || '?') + '</span>';
            } else if (t.previewSent) {
                previewText = '<span class="v2-tag v2-tag-sending">...</span>';
            }

            var lockText = '-';
            if (t.lockResult) {
                if (t.lockResult.success) lockText = '<span class="v2-tag v2-tag-ok">已锁</span>';
                else {
                    var errTag = t.lockResult.raw ? (t.lockResult.raw.code || 'ERR') : '失败';
                    lockText = '<span class="v2-tag v2-tag-err" title="' + (t.lockResult.raw ? (t.lockResult.raw.msg || '') : '') + '">' + errTag + '</span>';
                }
            }

            var hasDetail = t.previewResult || t.lockResult;
            var clickAttr = hasDetail
                ? ' style="cursor:pointer;" onclick="window.__v2ShowDetail(' + i + ')"'
                : '';

            html += '<tr class="' + cls + '"' + clickAttr + '>' +
                '<td>' + (i + 1) + sourceTag + '</td>' +
                '<td title="' + t.ticket + '">' + short + '</td>' +
                '<td>' + timeStr + '</td>' +
                '<td>' + previewText + '</td>' +
                '<td>' + lockText + '</td>' +
                '</tr>';
        });
        if (tokens.length === 0) {
            html = '<tr><td colspan="5" class="v2-token-empty">暂无记录</td></tr>';
        }
        tbody.innerHTML = html;

        var countEl = document.getElementById('v2-token-count');
        if (countEl) {
            var validCount = getValidCachedTokens().length;
            countEl.textContent = validCount + '/' + tokens.length;
        }
        // 自动滚到底部
        if (tbody.scrollHeight > tbody.clientHeight) {
            tbody.scrollTop = tbody.scrollHeight;
        }
    }

    // 点击表格行展示详情
    win.__v2ShowDetail = function (idx) {
        var t = state.cachedTokens[idx];
        if (!t) return;
        var lines = [];
        lines.push('=== Token #' + (idx + 1) + ' ===');
        lines.push('ticket:  ' + t.ticket);
        lines.push('randstr: ' + t.randstr);
        lines.push('预存时间: ' + new Date(t.timestamp).toLocaleTimeString());
        lines.push('');
        if (t.previewResult) {
            lines.push('=== Preview 响应 ===');
            lines.push(JSON.stringify(t.previewResult.raw, null, 2));
        }
        if (t.lockResult) {
            lines.push('');
            lines.push('=== 锁单结果 ===');
            lines.push(t.lockResult.success ? '成功' : '失败: ' + (t.lockResult.msg || t.lockResult.code || '?'));
            if (t.lockResult.raw) {
                lines.push(JSON.stringify(t.lockResult.raw, null, 2));
            }
        }
        var overlay = document.getElementById('v2-detail-overlay');
        var title = document.getElementById('v2-detail-title');
        var body = document.getElementById('v2-detail-body');
        var footer = document.getElementById('v2-detail-footer');
        if (overlay && title && body) {
            title.textContent = 'Token #' + (idx + 1);
            body.textContent = lines.join('\n');
            overlay.style.display = 'flex';

            // 详情弹窗底部按钮区域
            if (footer) {
                footer.innerHTML = '';
                var sign = t.lockResult && t.lockResult.success &&
                           t.lockResult.raw && t.lockResult.raw.data &&
                           t.lockResult.raw.data.sign;
                var previewData = t.previewResult && t.previewResult.raw &&
                                  t.previewResult.raw.data;

                if (sign && previewData) {
                    // 检查 QRCode 库是否可用
                    var QR = (typeof QRCode !== 'undefined') ? QRCode
                        : (typeof win.QRCode !== 'undefined') ? win.QRCode : null;

                    if (QR) {
                        // QRCode 库可用 → 直接弹出支付二维码
                        var payBtn = document.createElement('button');
                        payBtn.textContent = '重新弹出支付二维码';
                        payBtn.style.cssText = 'background:#e6a23c;color:#fff;border:none;border-radius:6px;' +
                            'padding:8px 24px;font-size:14px;cursor:pointer;margin:0 4px;';
                        payBtn.addEventListener('click', function () {
                            showPaymentQRPopup(sign, previewData);
                        });
                        footer.appendChild(payBtn);
                    } else {
                        // QRCode 库不可用 → 引导用户去在线工具生成
                        var tipEl = document.createElement('div');
                        tipEl.style.cssText = 'font-size:12px;color:#e6a23c;margin-bottom:8px;line-height:1.6;';
                        tipEl.textContent = '二维码库未加载，请手动生成：';
                        footer.appendChild(tipEl);

                        var copyBtn = document.createElement('button');
                        copyBtn.textContent = '复制 sign 链接';
                        copyBtn.style.cssText = 'background:#409eff;color:#fff;border:none;border-radius:6px;' +
                            'padding:8px 20px;font-size:13px;cursor:pointer;margin:0 4px;';
                        copyBtn.addEventListener('click', function () {
                            try {
                                navigator.clipboard.writeText(sign).then(function () {
                                    copyBtn.textContent = '已复制!';
                                    setTimeout(function () { copyBtn.textContent = '复制 sign 链接'; }, 2000);
                                });
                            } catch (e) {
                                // fallback
                                var ta = document.createElement('textarea');
                                ta.value = sign;
                                document.body.appendChild(ta);
                                ta.select();
                                document.execCommand('copy');
                                ta.remove();
                                copyBtn.textContent = '已复制!';
                                setTimeout(function () { copyBtn.textContent = '复制 sign 链接'; }, 2000);
                            }
                        });
                        footer.appendChild(copyBtn);

                        var onlineBtn = document.createElement('button');
                        onlineBtn.textContent = '在线生成二维码';
                        onlineBtn.style.cssText = 'background:#e6a23c;color:#fff;border:none;border-radius:6px;' +
                            'padding:8px 20px;font-size:13px;cursor:pointer;margin:0 4px;';
                        onlineBtn.addEventListener('click', function () {
                            window.open('https://freetoolkit.cn/tools/%E4%BA%8C%E7%BB%B4%E7%A0%81%E7%94%9F%E6%88%90', '_blank');
                        });
                        footer.appendChild(onlineBtn);
                    }
                } else if (previewData && !sign) {
                    // preview 成功但未锁单 → 打开支付页面
                    var productInfo = PRODUCTS[getSelectedPackageType()] &&
                        PRODUCTS[getSelectedPackageType()][getSelectedTier()];
                    if (productInfo && previewData.bizId) {
                        var openBtn = document.createElement('button');
                        openBtn.textContent = '打开支付页面';
                        openBtn.style.cssText = 'background:#409eff;color:#fff;border:none;border-radius:6px;' +
                            'padding:8px 24px;font-size:14px;cursor:pointer;margin:0 4px;transform:translateY(-20px);';
                        openBtn.addEventListener('click', function () {
                            openPaymentDialog(previewData, productInfo);
                        });
                        footer.appendChild(openBtn);
                    }
                }
            }
        }
    };

    // 定时刷新 token 显示（检查过期状态）
    var tokenDisplayTimer = null;
    function startTokenDisplayRefresh() {
        if (tokenDisplayTimer) clearInterval(tokenDisplayTimer);
        tokenDisplayTimer = setInterval(function () {
            if (state.cachedTokens.length > 0) {
                updateTokenDisplay();
            }
        }, 10000);
    }

    async function precacheOneToken() {
        if (!getTencentCaptcha()) {
            log('预存', '验证码SDK未就绪');
            return false;
        }
        try {
            log('预存', '弹出验证码...');
            var result = await getCaptchaTicket();
            addCachedToken(result.ticket, result.randstr);
            log('预存', '成功！ticket: ' + result.ticket.substring(0, 20) + '...');
            return true;
        } catch (e) {
            log('预存', '失败: ' + e.message);
            return false;
        }
    }

    async function precacheTokens(count) {
        state.precacheRunning = true;
        updatePrecacheBtn(true);
        for (var i = 0; i < count; i++) {
            if (!state.precacheRunning) break;
            var success = await precacheOneToken();
            if (!success) {
                log('预存', '第 ' + (i + 1) + ' 个失败，停止');
                break;
            }
            log('预存', '进度: ' + (i + 1) + '/' + count);
            if (i < count - 1) await sleep(800);
        }
        state.precacheRunning = false;
        updatePrecacheBtn(false);
    }

    function stopPrecache() {
        state.precacheRunning = false;
        updatePrecacheBtn(false);
        log('预存', '已停止');
    }

    function updatePrecacheBtn(running) {
        var btn = document.getElementById('v2-precache-btn');
        if (btn) {
            btn.textContent = running ? '停止' : '预存';
            btn.className = running ? 'v2-btn v2-btn-danger' : 'v2-btn v2-btn-secondary';
        }
    }

    function getTargetPrecacheCount() {
        var el = document.getElementById('v2-precache-count');
        return Math.min(el ? (parseInt(el.textContent, 10) || 0) : 0, 5);
    }

    function getManualBizId() {
        var el = document.getElementById('v2-manual-bizid');
        return el ? el.value.trim() : '';
    }

    // ==================== 锁单失败后处理 ====================
    var PAY_AES_KEY = 'zhiPuAi123456789';

    function findCryptoJS() {
        // @require 在油猴沙箱里加载，变量名可能被隔离
        // 尝试多种方式查找
        var candidates = [];
        try { candidates.push(CryptoJS); } catch (e) {}
        try { candidates.push(win.CryptoJS); } catch (e) {}
        try { candidates.push(window.CryptoJS); } catch (e) {}
        try { candidates.push(unsafeWindow.CryptoJS); } catch (e) {}
        // 尝试通过 GM 信息脚本的全局
        try { candidates.push(self.CryptoJS); } catch (e) {}
        for (var i = 0; i < candidates.length; i++) {
            if (candidates[i] && candidates[i].AES && candidates[i].enc) {
                return candidates[i];
            }
        }
        return null;
    }

    function aesEncrypt(plaintext) {
        var CryptoJS = findCryptoJS();
        if (!CryptoJS) {
            log('支付', 'CryptoJS 未找到，尝试内联加载...');
            return null;
        }
        var key = CryptoJS.enc.Utf8.parse(PAY_AES_KEY);
        var encrypted = CryptoJS.AES.encrypt(plaintext, key, {
            mode: CryptoJS.mode.ECB,
            padding: CryptoJS.pad.Pkcs7
        });
        return encrypted.toString();
    }

    function buildPayMiddlePageUrl(previewData) {
        // 参考 SubscribePay.vue renderQrCode 方法：
        // info = { productId, productName, amount, customerId, customerName, bizId, ic, payType }
        // pay-middle-page 打开后会拿这些参数调 create-sign
        var info = {
            productId: previewData.productId,
            productName: previewData.productName || previewData.productBigTitle || '',
            amount: previewData.payAmount || previewData.thirdPartyAmount || 0,
            customerId: state.customerNumber || '',
            customerName: state.customerName || '',
            bizId: previewData.bizId || '',
            ic: getQueryString('ic') || CONFIG.INVITATION_CODE,
            payType: 'alipay'
        };
        var jsonStr = JSON.stringify(info);
        var encrypted = aesEncrypt(jsonStr);
        if (!encrypted) return null;
        return window.location.origin + '/pay-middle-page?info=' + encodeURIComponent(encrypted);
    }

    function showQRPopup(qrDataUrl, amount, productName, subtitle, payUrl, large) {
        var existing = document.getElementById('v2-lockfail-popup');
        if (existing) existing.remove();
        var existingOverlay = document.getElementById('v2-lockfail-overlay');
        if (existingOverlay) existingOverlay.remove();
        var qrSize = large ? 350 : 240;
        var popupWidth = large ? 490 : 440;

        var popup = document.createElement('div');
        popup.id = 'v2-lockfail-popup';
        popup.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);' +
            'background:#fff;border-radius:12px;padding:28px 32px;z-index:2000000030;min-width:340px;max-width:' + popupWidth + 'px;' +
            'box-shadow:0 8px 30px rgba(0,0,0,0.25);text-align:center;font-family:system-ui,sans-serif;';
        popup.innerHTML =
            '<div style="font-size:18px;font-weight:600;color:#333;margin-bottom:8px;">抢购成功！请扫码支付</div>' +
            '<div style="font-size:14px;color:#666;margin-bottom:4px;">' + (productName || '') + '</div>' +
            '<div style="font-size:28px;font-weight:bold;color:#e6a23c;margin-bottom:16px;">¥' + amount + '</div>' +
            '<div style="margin-bottom:12px;"><img id="v2-qr-img" src="' + qrDataUrl + '" style="width:' + qrSize + 'px;height:' + qrSize + 'px;border:1px solid #eee;border-radius:8px;" /></div>' +
            '<div style="font-size:12px;color:#999;margin-bottom:8px;">' + (subtitle || '请尽快用支付宝扫码支付') + '</div>' +
            (payUrl ? '<textarea readonly onclick="this.select();document.execCommand(\'copy\')" style="width:100%;max-width:360px;height:48px;font-size:11px;color:#409eff;border:1px solid #ddd;border-radius:4px;padding:4px 6px;resize:none;margin-bottom:16px;word-break:break-all;line-height:1.3;outline:none;cursor:pointer;" title="点击复制">' + payUrl + '</textarea>' : '') +
            '<div style="display:flex;gap:10px;justify-content:center;margin-top:12px;">' +
            '<button id="v2-lockfail-download" style="background:#67c23a;color:#fff;border:none;border-radius:6px;' +
            'padding:8px 20px;font-size:14px;cursor:pointer;">下载二维码</button>' +
            '<button id="v2-lockfail-close" style="background:#409eff;color:#fff;border:none;border-radius:6px;' +
            'padding:8px 28px;font-size:14px;cursor:pointer;">关闭</button></div>';
        document.body.appendChild(popup);

        var overlay = document.createElement('div');
        overlay.id = 'v2-lockfail-overlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.4);z-index:2000000029;';
        document.body.appendChild(overlay);

        var closePopup = function () { popup.remove(); overlay.remove(); };
        document.getElementById('v2-lockfail-close').onclick = closePopup;
        overlay.onclick = null;

        var dlBtn = document.getElementById('v2-lockfail-download');
        if (dlBtn) {
            dlBtn.onclick = function () {
                var a = document.createElement('a');
                a.href = qrDataUrl;
                a.download = 'pay_qr_' + Date.now() + '.png';
                a.click();
            };
        }
    }

    async function openPaymentDialog(previewData, product) {
        // 关闭残留验证码
        try {
            var captchaClose = document.querySelector('.tencent-captcha-dy__close-btn') ||
                document.querySelector('#tcaptcha_transform_dy .close-btn');
            if (captchaClose) captchaClose.click();
        } catch (e) {}

        // 构建 pay-middle-page URL 并用 QRCode 库生成二维码
        var payUrl = buildPayMiddlePageUrl(previewData);
        if (!payUrl) {
            log('支付', '构建支付 URL 失败');
            return false;
        }

        log('支付', '支付URL: ' + payUrl);

        var QR = (typeof QRCode !== 'undefined') ? QRCode
            : (typeof win.QRCode !== 'undefined') ? win.QRCode : null;
        if (!QR) {
            log('支付', 'QRCode 库未就绪');
            return false;
        }

        var amount = previewData.thirdPartyAmount || previewData.payAmount || 0;
        var productName = previewData.productName || '';

        QR.toDataURL(payUrl, {
            width: 600, margin: 4, errorCorrectionLevel: 'L'
        }, function (err, qrDataUrl) {
            if (err) {
                log('支付', 'QR生成失败: ' + err.message);
                return;
            }
            showQRPopup(qrDataUrl, amount, productName, '锁单失败，扫码后页面会自动请求锁单', payUrl);
            log('支付', '支付二维码已弹出');
        });

        return true;
    }

    // ==================== 截取官方 canvas 二维码 ====================
    async function generatePayQRCode(previewData, productInfo) {
        log('支付', '支付金额: ¥' + previewData.thirdPartyAmount);
        log('支付', 'bizId: ' + previewData.bizId);

        // 注意：generatePayQRCode 仅作为 QR 库不可用时的截图回退
        // 轮询等待 canvas 渲染完成（payPreviewFn 已在上层调用）
        var qrCanvas = null;
        for (var i = 0; i < 50; i++) {
            await sleep(200);
            qrCanvas = document.querySelector('.scan-qrcode-box canvas');
            if (qrCanvas && qrCanvas.width > 0 && qrCanvas.height > 0) {
                break;
            }
        }

        if (!qrCanvas || qrCanvas.width === 0 || qrCanvas.height === 0) {
            log('支付', '官方二维码未渲染，请手动查看页面弹窗');
            return;
        }

        var dataUrl = qrCanvas.toDataURL('image/png');
        var amount = previewData.thirdPartyAmount;
        var productName = productInfo.name || '';

        // 新窗口展示官方二维码
        try {
            var newWin = window.open('', '_blank');
            if (newWin) {
                newWin.document.write(
                    '<html><head><title>支付二维码</title></head>' +
                    '<body style="display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f5f5;">' +
                    '<div style="text-align:center;">' +
                    '<h2 style="color:#333;">请使用支付宝扫码支付' + (productName ? ' - ' + productName : '') + '</h2>' +
                    '<p style="color:#e6a23c;font-size:24px;font-weight:bold;">¥' + amount + '</p>' +
                    '<img src="' + dataUrl + '" style="width:300px;height:300px;border:1px solid #ddd;" />' +
                    '<p style="color:#999;font-size:14px;">请尽快扫码支付，二维码有效期有限</p>' +
                    '</div></body></html>'
                );
            }
        } catch (e) {
            log('支付', '新窗口打开失败: ' + e.message);
        }

        // 自动下载二维码图片
        try {
            var link = document.createElement('a');
            link.download = 'qrcode_' + productInfo.name + '_' + Date.now() + '.png';
            link.href = dataUrl;
            link.click();
            log('支付', '二维码图片已自动下载');
        } catch (e) {}

        log('支付', '官方二维码已截取并展示');
    }


    // ==================== 支付状态轮询 ====================
    var payPollTimer = null;

    function startPayStatusPolling(bizId) {
        if (payPollTimer) clearInterval(payPollTimer);

        var pollCount = 0;
        var maxPolls = 300; // 5分钟

        payPollTimer = setInterval(async function () {
            pollCount++;
            if (pollCount > maxPolls) {
                clearInterval(payPollTimer);
                log('支付', '轮询超时，请刷新页面查看支付状态');
                return;
            }

            try {
                var resp = await fetchPayStatus(bizId);
                if (resp.data === 'SUCCESS') {
                    clearInterval(payPollTimer);
                    log('支付', '支付成功！');
                    updatePayStatus('支付成功！');
                    state.running = false;
                    updatePanelState('支付成功！', 'success');
                }
            } catch (e) {
                // 静默忽略轮询错误
            }
        }, 1000);
    }

    function updatePayStatus(text) {
        var el = document.getElementById('v2-pay-status');
        if (el) el.textContent = text;
    }

    // ==================== 核心抢购流程 ====================
    // 架构：到点后流水线 — 解验证码 → 立即发 preview（不等结果）→ 解下一个
    // preview 是异步 HTTP，解第 N 个验证码时，前面 N-1 个 preview 已经在飞

    // 单次 preview（ticket 一次性使用，不可重试），检查 state.running 以便随时中止
    async function tryPreviewWithRetry(captchaResult, product) {
        if (!state.running) return null;
        var params = {
            productId: product.productId,
            invitationCode: getQueryString('ic') || CONFIG.INVITATION_CODE,
            ticket: captchaResult.ticket,
            randstr: captchaResult.randstr
        };

        try {
            var resp = await fetchPreview(params);
        } catch (e) {
            log('接口', 'preview 失败: ' + e.message);
            return null;
        }
        if (!state.running) return null;

        if (resp.code === 200) {
            if (resp.data && !resp.data.soldOut) return resp.data;
            log('接口', '已售罄');
            return null;
        }
        log('接口', 'preview: code=' + resp.code + ' ' + (resp.msg || ''));
        return null;
    }

    // 带 UI 记录的 preview（用于预存 token）
    async function tryPreviewWithRetryAndRecord(captchaResult, product, tokenObj) {
        if (!state.running) return null;
        tokenObj.previewSentTime = Date.now();
        var params = {
            productId: product.productId,
            invitationCode: getQueryString('ic') || CONFIG.INVITATION_CODE,
            ticket: captchaResult.ticket,
            randstr: captchaResult.randstr
        };

        try {
            var resp = await fetchPreview(params);
        } catch (e) {
            tokenObj.previewResult = { success: false, code: 'ERR', msg: e.message, raw: null };
            updateTokenDisplay();
            return null;
        }
        if (!state.running) return null;

        if (resp.code === 200) {
             if (resp.data && !resp.data.soldOut) {
                tokenObj.previewResult = { success: true, soldOut: false, code: 200, raw: resp };
                updateTokenDisplay();
                // 附带 captcha 信息，供触发 Vue 原生支付弹窗使用
                resp.data._captchaTicket = captchaResult.ticket;
                resp.data._captchaRandstr = captchaResult.randstr;
                return resp.data;
            }
            tokenObj.previewResult = { success: false, soldOut: true, code: 200, raw: resp };
            updateTokenDisplay();
            return null;
        }
        tokenObj.previewResult = { success: false, code: resp.code, msg: resp.msg, raw: resp };
        updateTokenDisplay();
        return null;
    }

    // 流水线：解验证码 → await preview → 成功立即返回，失败继续下一个
    async function solveAndFirePipeline(product) {
        for (var i = 0; i < 3 && state.running; i++) {
            // 等待 SDK 实例清理，避免验证码实例冲突导致拿到残留 ticket
            if (i > 0) await sleep(1500);

            try {
                log('线路' + (i + 1), '弹出验证码...');
                var captchaResult = await getCaptchaTicket();
            } catch (e) {
                log('线路' + (i + 1), '验证码失败: ' + e.message);
                continue;
            }
            if (!state.running) break;

            // 验证码结果基本校验
            if (!captchaResult || !captchaResult.ticket || captchaResult.ticket.length < 10) {
                log('线路' + (i + 1), '验证码返回无效 ticket，跳过');
                continue;
            }

            // 加入表格跟踪
            var tokenObj = {
                ticket: captchaResult.ticket,
                randstr: captchaResult.randstr,
                timestamp: Date.now(),
                previewSent: true,
                source: '实时'
            };
            state.cachedTokens.push(tokenObj);
            updateTokenDisplay();

            log('线路' + (i + 1), '验证码通过，请求 preview...');
            var data = await tryPreviewWithRetryAndRecord(captchaResult, product, tokenObj);
            if (data) return { data: data, tokenObj: tokenObj };

            // preview 失败后等待 SDK 清理，避免下一个 ticket 是残留的
            log('线路' + (i + 1), 'preview 失败，等待 SDK 清理...');
            await sleep(1000);
        }
        return null;
    }

    async function executePurchase() {
        var packageType = getSelectedPackageType();
        var tier = getSelectedTier();
        var product = PRODUCTS[packageType][tier];

        if (!product) {
            log('错误', '未找到产品: ' + packageType + '/' + tier);
            return false;
        }

        log('抢购', '目标: ' + product.name);
        clickPagePackageTab();

        // Phase 0: 手动 bizId 直通锁单（绕过 preview）
        var manualBizId = getManualBizId();
        if (manualBizId) {
            log('直通', '检测到手动 bizId，跳过 preview，直接锁单');
            var manualPreviewData = {
                productId: product.productId,
                bizId: manualBizId,
                thirdPartyAmount: product.payAmount || product.price
            };
            var manualLockResult = await tryLockOrder(manualPreviewData);
            var manualTokenObj = {
                ticket: '(手动bizId)',
                randstr: '',
                timestamp: Date.now(),
                previewSent: true,
                source: '手动',
                previewResult: { success: true, code: 200, raw: { data: manualPreviewData } }
            };
            if (manualLockResult.success) {
                manualTokenObj.lockResult = { success: true, raw: manualLockResult };
                state.cachedTokens.push(manualTokenObj);
                updateTokenDisplay();
                log('直通', '锁单成功！bizId=' + manualBizId);
                showPaymentQRPopup(manualLockResult.sign, manualPreviewData);
                return true;
            }
            manualTokenObj.lockResult = { success: false, raw: manualLockResult.raw };
            state.cachedTokens.push(manualTokenObj);
            updateTokenDisplay();
            log('直通', '锁单失败: ' + (manualLockResult.msg || manualLockResult.code) + '，触发原生弹窗');
            await openPaymentDialog(manualPreviewData, product);
            return true;
        }

        // Phase 1: 用预存 token 逐个请求（LIFO：后进先出，最新的 token 优先使用）
        var cachedTokens = getValidCachedTokens().reverse();
        if (cachedTokens.length > 0) {
            updatePanelState('预存token请求中 (' + cachedTokens.length + '个)...', 'running');
            log('预存', '逐个请求 preview，共 ' + cachedTokens.length + ' 个');

            for (var i = 0; i < cachedTokens.length; i++) {
                if (!state.running) break;
                var token = cachedTokens[i];
                token.previewSent = true;
                if (!token.source) token.source = '预存';
                token.previewSentTime = Date.now();
                updateTokenDisplay();

                var previewData = await tryPreviewWithRetryAndRecord(
                    { ticket: token.ticket, randstr: token.randstr },
                    product,
                    token
                );

                if (previewData) {
                    log('抢购', '预存token命中！¥' + previewData.thirdPartyAmount);

                    var lockResult = await tryLockOrder(previewData);
                    token.lockResult = { success: lockResult.success, raw: lockResult.raw };
                    updateTokenDisplay();

                    if (lockResult.success) {
                        showPaymentQRPopup(lockResult.sign, previewData);
                        return true;
                    }
                    // 锁单失败，直接弹出页面原生支付弹窗
                    log('抢购', '锁单失败，触发页面原生支付弹窗');
                    await openPaymentDialog(previewData, product);
                    return true;
                }

                if (i < cachedTokens.length - 1) {
                    await sleep(CONFIG.PRECACHE_INTERVAL);
                }
            }
            log('抢购', '预存token全部失败，进入普通抢购');
        }

        // Phase 2: 普通抢购
        while (state.running) {
            if (!getTencentCaptcha()) {
                log('抢购', '验证码SDK未就绪');
                break;
            }

            var pipelineResult = await solveAndFirePipeline(product);
            if (pipelineResult) {
                var data = pipelineResult.data;
                var tokenObj = pipelineResult.tokenObj;
                log('抢购', '抢到了！¥' + data.thirdPartyAmount);

                // 先尝试锁单
                var lockResult = await tryLockOrder(data);
                if (tokenObj) {
                    tokenObj.lockResult = { success: lockResult.success, raw: lockResult.raw };
                    updateTokenDisplay();
                }
                if (lockResult.success) {
                    showPaymentQRPopup(lockResult.sign, data);
                    return true;
                }
                // 锁单失败，直接弹出页面原生支付弹窗
                log('抢购', '锁单失败，触发页面原生支付弹窗');
                await openPaymentDialog(data, product);
                return true;
            }

            if (!state.running) {
                log('抢购', '已手动停止');
                return false;
            }
            log('抢购', '本轮全部失败，继续...');
            await sleep(800);
        }
        return false;
    }

    // ==================== 定时调度 ====================
    function getBuyTimeStr() {
        var el = document.getElementById('v2-buy-time');
        return (el && el.value) ? el.value : CONFIG.BUY_TIME_DEFAULT;
    }

    function parseBuyTime() {
        var parts = getBuyTimeStr().split(':');
        return {
            h: parseInt(parts[0], 10) || 0,
            m: parseInt(parts[1], 10) || 0,
            s: parseInt(parts[2], 10) || 0
        };
    }

    function getSecondsToBuyTime() {
        var now = new Date(getServerTime());
        var t = parseBuyTime();
        var target = new Date(now);
        target.setHours(t.h, t.m, t.s, 0);
        if (now >= target) return 0;
        return Math.floor((target - now) / 1000);
    }

    function getSelectedPackageType() {
        var radio = document.querySelector('input[name="v2-package"]:checked');
        return radio ? radio.value : CONFIG.PACKAGE_TYPE_DEFAULT;
    }

    function getSelectedTier() {
        var radio = document.querySelector('input[name="v2-tier"]:checked');
        return radio ? radio.value : CONFIG.TIER_DEFAULT;
    }

    // 主循环
    async function mainLoop() {
        if (!state.running) return;

        var secs = getSecondsToBuyTime();

        if (secs > 0) {
            var m = Math.floor(secs / 60);
            var s = secs % 60;
            updatePanelState('等待 ' + getBuyTimeStr() + ' (' + m + ':' + (s < 10 ? '0' : '') + s + ')', 'waiting');

            // 自动预存：倒计时 < 30s 时触发（用 precacheRunning 阻止重复）
            var autoPrecache = document.getElementById('v2-auto-precache')?.checked;
            if (autoPrecache && secs <= 30 && secs > 1 && !state.precacheRunning) {
                var validCount = getValidCachedTokens().length;
                var targetCount = getTargetPrecacheCount();
                if (validCount < targetCount) {
                    log('预存', '自动预存启动 (' + validCount + '/' + targetCount + ')');
                    precacheTokens(targetCount - validCount);
                }
            }

            // 连接预热：倒计时 ≤ 30s 开始
            if (secs <= 30 && secs > 0) {
                startConnectionPreheat();
            }

            // 轮询加速：1s 内切 50ms 精确卡点
            var interval = secs <= 1 ? 50 : 1000;
            state.timer = setTimeout(mainLoop, interval);
            return;
        }

        // 停止正在进行的预存
        state.precacheRunning = false;
        updatePrecacheBtn(false);
        // 停止连接预热
        stopConnectionPreheat();

        // 关闭可能正在显示的验证码弹窗，让 precacheOneToken 的 await 尽快返回
        try {
            var captchaCloseBtn = document.querySelector('.tencent-captcha-dy__close-btn');
            if (captchaCloseBtn) captchaCloseBtn.click();
        } catch (e) {}

        // 等待预存流程收尾（getCaptchaTicket reject → precacheOneToken 返回 → 循环 break）
        await sleep(500);

        // 到点！
        updatePanelState('抢购中...', 'running');

        // 检查验证码SDK是否就绪
        if (!getTencentCaptcha()) {
            log('等待', '验证码SDK未就绪，3秒后重试...');
            updatePanelState('等待SDK加载...', 'waiting');
            state.timer = setTimeout(mainLoop, 3000);
            return;
        }

        try {
            var success = await executePurchase();
            if (success) {
                state.running = false;
                resetStartButton();
                updatePanelState('抢购成功！', 'success');
                return;
            }
        } catch (e) {
            log('错误', e.message);
        }

        if (state.running) {
            updatePanelState('重试中...', 'running');
            state.timer = setTimeout(mainLoop, 1000);
        }
    }

    // ==================== 检测本地OCR服务 ====================
    function checkLocalOcrService() {
        var baseUrl = CONFIG.DDDDOCR_URL.replace(/\/click$/, '/');
        var onError = function () {
            log('OCR', '本地服务未启动，请先启动 captcha/ddddocr_server.py');
        };
        var onSuccess = function () {
            log('OCR', '本地识别服务已连接');
        };
        if (typeof GM_xmlhttpRequest !== 'undefined') {
            GM_xmlhttpRequest({
                method: 'GET', url: baseUrl, timeout: 2000,
                onload: onSuccess, onerror: onError, ontimeout: onError
            });
        } else {
            var controller = new AbortController();
            var tid = setTimeout(function () { controller.abort(); }, 2000);
            fetch(baseUrl, { mode: 'no-cors', signal: controller.signal })
                .then(function () { clearTimeout(tid); onSuccess(); })
                .catch(function () { clearTimeout(tid); onError(); });
        }
    }

    // ==================== 控制面板UI ====================
    function createControlPanel() {
        var panel = document.createElement('div');
        panel.id = 'v2-control-panel';

        var savedTime = loadSetting('v2_buy_time', CONFIG.BUY_TIME_DEFAULT);
        var savedPkg = loadSetting('v2_package', CONFIG.PACKAGE_TYPE_DEFAULT);
        var savedTier = loadSetting('v2_tier', CONFIG.TIER_DEFAULT);
        var savedInterval = loadSetting('v2_precache_interval', String(CONFIG.PRECACHE_INTERVAL));
        var savedPrecacheCount = Math.min(parseInt(loadSetting('v2_precache_count', '1'), 10) || 1, 5);
        var savedAutoPrecache = loadSetting('v2_auto_precache', 'true');
        var savedShowLog = loadSetting('v2_show_log', 'false');
        var savedAntiDetect = loadSetting('v2_anti_detect', 'false');

        // 恢复 CONFIG
        CONFIG.PRECACHE_INTERVAL = parseInt(savedInterval, 10) || 1800;

        panel.innerHTML =
            '<div class="v2-panel-row">' +
            '<div class="v2-status-dot" id="v2-status-dot"></div>' +
            '<span id="v2-status-text">就绪</span>' +
            '<span id="v2-time-offset" style="color:#67c23a;font-size:10px;margin-left:auto;"></span>' +
            '<button id="v2-help-btn" class="v2-btn-mini" style="margin-left:4px;">说明</button>' +
            '</div>' +
            '<div class="v2-panel-row">' +
            '<span class="v2-label">套餐</span>' +
            '<div class="v2-radio-group">' +
            '<input type="radio" name="v2-package" id="v2-pkg-month" value="month"' + (savedPkg === 'month' ? ' checked' : '') + '><label for="v2-pkg-month">月</label>' +
            '<input type="radio" name="v2-package" id="v2-pkg-quarter" value="quarter"' + (savedPkg === 'quarter' ? ' checked' : '') + '><label for="v2-pkg-quarter">季</label>' +
            '<input type="radio" name="v2-package" id="v2-pkg-year" value="year"' + (savedPkg === 'year' ? ' checked' : '') + '><label for="v2-pkg-year">年</label>' +
            '</div>' +
            '</div>' +
            '<div class="v2-panel-row">' +
            '<span class="v2-label">档位</span>' +
            '<div class="v2-radio-group">' +
            '<input type="radio" name="v2-tier" id="v2-tier-lite" value="lite"' + (savedTier === 'lite' ? ' checked' : '') + '><label for="v2-tier-lite">Lite</label>' +
            '<input type="radio" name="v2-tier" id="v2-tier-pro" value="pro"' + (savedTier === 'pro' ? ' checked' : '') + '><label for="v2-tier-pro">Pro</label>' +
            '<input type="radio" name="v2-tier" id="v2-tier-max" value="max"' + (savedTier === 'max' ? ' checked' : '') + '><label for="v2-tier-max">Max</label>' +
            '</div>' +
            '</div>' +
            '<div class="v2-panel-row">' +
            '<span class="v2-label">时间</span>' +
            '<input type="time" id="v2-buy-time" step="1" value="' + savedTime + '">' +
            '</div>' +
            '<div class="v2-panel-row">' +
            '<span class="v2-label">产品</span>' +
            '<span id="v2-product-info" class="v2-product-info"></span>' +
            '<button id="v2-refresh-btn" class="v2-btn-mini">刷新</button>' +
            '</div>' +
            '<div class="v2-separator"></div>' +
            '<div class="v2-panel-row"' + (CONFIG.ENABLE_MANUAL_BIZID ? '' : ' style="display:none;"') + '>' +
            '<span class="v2-label">bizId</span>' +
            '<input type="text" id="v2-manual-bizid" class="v2-bizid-input" placeholder="留空走正常流程">' +
            '<span class="v2-hint">直通锁单</span>' +
            '</div>' +
            '<div class="v2-separator"></div>' +
            '<div class="v2-panel-row v2-precache-row">' +
            '<span class="v2-label" style="width:50px;">预存<button id="v2-precache-help" class="v2-help-btn" title="预存说明">?</button></span>' +
            '<div class="v2-stepper">' +
            '<button id="v2-precache-minus" class="v2-stepper-btn">-</button>' +
            '<span id="v2-precache-count" class="v2-stepper-val">' + savedPrecacheCount + '</span>' +
            '<button id="v2-precache-plus" class="v2-stepper-btn">+</button>' +
            '</div>' +
            '<span class="v2-hint">个</span>' +
            '<span id="v2-token-count" class="v2-token-count">0/0</span>' +
            '<button id="v2-precache-btn" class="v2-btn-mini">预存</button>' +
            '<button id="v2-clear-tokens-btn" class="v2-btn-mini">清空</button>' +
            '</div>' +
            '<div class="v2-panel-row">' +
            '<span class="v2-label">间隔</span>' +
            '<input type="number" id="v2-precache-interval" min="0" value="' + savedInterval + '" class="v2-num-input" style="width:52px;">' +
            '<span class="v2-hint">ms(预存消耗间隔)</span>' +
            '</div>' +
            '<table class="v2-token-table" id="v2-token-table">' +
            '<thead><tr><th>#</th><th>ticket</th><th>时间</th><th>preview</th><th>锁单</th></tr></thead>' +
            '<tbody id="v2-token-tbody"><tr><td colspan="5" class="v2-token-empty">暂无预存</td></tr></tbody>' +
            '</table>' +
            '<div class="v2-panel-row">' +
            '<label class="v2-checkbox-label">' +
            '<input type="checkbox" id="v2-auto-precache"' + (savedAutoPrecache !== 'false' ? ' checked' : '') + ' />' +
            '自动预存(倒计时&lt;30s)' +
            '</label>' +
            '<label class="v2-checkbox-label">' +
            '<input type="checkbox" id="v2-show-log"' + (savedShowLog === 'true' ? ' checked' : '') + ' />' +
            '日志' +
            '</label>' +
            '<label class="v2-checkbox-label">' +
            '<input type="checkbox" id="v2-anti-detect"' + (savedAntiDetect === 'true' ? ' checked' : '') + ' />' +
            '防检测' +
            '</label>' +
            '</div>' +
            '<div class="v2-separator"></div>' +
            '<div class="v2-panel-row v2-btn-row">' +
            '<button id="v2-start-btn" class="v2-btn v2-btn-primary">开始抢购</button>' +
            '<button id="v2-test-btn" class="v2-btn v2-btn-secondary" style="display:none;">测试验证码</button>' +
            '</div>' +
            '<div style="text-align:right;font-size:10px;color:#999;padding:2px 4px 0 0;">v2.2.4</div>' +
            '<div class="v2-log-area v2-log-hidden" id="v2-log-area"></div>' +
            '<div class="v2-detail-overlay" id="v2-detail-overlay" style="display:none;">' +
            '<div class="v2-detail-box">' +
            '<div class="v2-detail-header"><span id="v2-detail-title">详情</span><button id="v2-detail-close">&times;</button></div>' +
            '<pre class="v2-detail-body" id="v2-detail-body"></pre>' +
            '<div id="v2-detail-footer" style="padding:0 16px 12px;text-align:center;transform: translateY(-20px);"></div>' +
            '</div>' +
            '</div>' +
            '<div class="v2-help-overlay" id="v2-help-overlay" style="display:none;">' +
            '<div class="v2-help-box">' +
            '<h3>预存功能说明</h3>' +
            '<p><span class="v2-help-highlight">什么是预存？</span><br/>' +
            '预存是指在抢购倒计时结束前，提前完成验证码识别并缓存获得的 ticket 凭证。这样在正式抢购时可以直接使用缓存的凭证发起请求，跳过验证码识别环节，从而大幅减少延迟。</p>' +
            '<p><span class="v2-help-step">工作流程：</span></p>' +
            '<p>1. 手动点击"预存"或开启"自动预存"（倒计时 ≤ 30s 自动触发）<br/>' +
            '2. 脚本自动弹出腾讯验证码并通过 OCR 识别完成验证<br/>' +
            '3. 验证通过后获得 ticket + randstr，存入缓存（有效期 180 秒）<br/>' +
            '4. 到达抢购时间时，脚本用缓存的 ticket 直接请求 preview 接口（后进先出）<br/>' +
            '5. 每个预存 token 会独立请求 preview，命中即可锁单</p>' +
            '<p><span class="v2-help-highlight">使用建议：</span><br/>' +
            '- 预存 1~5 个即可，太多可能触发验证码频率限制<br/>' +
            '- token 有效期 180 秒，预存过早会过期失效<br/>' +
            '- 表格中可以看到每个 token 的 preview 和锁单结果</p>' +
            '<p><span class="v2-help-highlight">请求间隔：</span><br/>' +
            '面板中的"间隔"设置控制抢购时每个预存 token 发起 preview 请求之间的等待时间。默认 1800ms，间隔太短容易触发服务端繁忙（555），间隔太长则可能错过抢购窗口。建议根据网络状况调整，网络好可适当缩短。</p>' +
            '<button class="v2-help-close" id="v2-help-close">知道了</button>' +
            '</div>' +
            '</div>' +
            '<div class="v2-help-overlay" id="v2-main-help-overlay" style="display:none;">' +
            '<div class="v2-help-box" style="max-width:460px;">' +
            '<h3>使用说明 <span style="font-size:11px;color:#888;font-weight:normal;">v2.2.4</span></h3>' +
            '<div class="v2-help-item"><span class="v2-help-num">1.</span>请<span class="v2-help-highlight">提前进入抢号界面</span>，高峰期页面可能无法加载。进入后<span class="v2-help-highlight">不要刷新</span>。选择套餐和档位，设置抢购时间，点击"开始抢购"即可到点自动抢购。</div>' +
            '<div class="v2-help-item"><span class="v2-help-num">2.</span>可将倒计时设置为当日更早的时间进行<span class="v2-help-highlight">测试</span>，验证脚本是否正常工作。</div>' +
            '<div class="v2-help-item"><span class="v2-help-num">3.</span>验证码识别使用本地 ddddocr 服务（<span class="v2-help-highlight">需提前启动 captcha/ddddocr_server.py</span>），识别速度约 100ms。若未启动本地服务，脚本启动时会弹出警告提示。</div>' +
            '<div class="v2-help-item"><span class="v2-help-num">4.</span>脚本原理是自动激活购买按钮并通过接口直接调用，不使用暴力手段。能否抢到仍需运气，祝您好运！</div>' +
            '<div class="v2-help-item"><span class="v2-help-num">5.</span><span class="v2-help-highlight">锁单机制</span>：preview 成功后自动调 create-sign 接口锁单，锁住订单后弹出支付二维码。若锁单失败，会自动弹出页面原生支付弹窗供您扫码。若锁单成功但二维码未弹出，可在接口记录详情中点击「重新弹出支付二维码」，或复制 sign 链接到 <a href="https://freetoolkit.cn/tools/%E4%BA%8C%E7%BB%B4%E7%A0%81%E7%94%9F%E6%88%90" target="_blank" style="color:#409eff;">在线二维码生成工具</a> 手动生成。</div>' +
            '<div class="v2-help-item"><span class="v2-help-num">6.</span><span class="v2-help-highlight">预存</span>：在抢购前提前解验证码缓存 ticket，到点直接用缓存请求。详情请点击预存旁的 <span style="color:#409eff;">?</span> 按钮。</div>' +
            '<div class="v2-help-item"><span class="v2-help-num">7.</span><span class="v2-help-highlight">间隔</span>：抢购时每个预存 token 发起 preview 请求之间的等待时间（ms），默认 1800，太快可能触发服务端繁忙。</div>' +
            '<div style="margin-top:16px;padding-top:12px;border-top:1px solid rgba(0,0,0,0.08);text-align:center;">' +
            '<p style="color:#409eff;margin-bottom:4px;font-size:12px;">QQ交流群: <strong>981656846</strong></p>' +
            '<p style="color:#e6a23c;font-size:11px;margin-bottom:0;">支持作者 👉 <a href="https://www.bigmodel.cn/glm-coding?ic=V5UCF6QKLX" target="_blank" style="color:#409eff;">用邀请链接购买享5%优惠</a></p>' +
            '</div>' +
            '<button class="v2-help-close" id="v2-main-help-close">我知道了</button>' +
            '</div>' +
            '</div>';

        document.body.appendChild(panel);

        // 绑定事件
        document.getElementById('v2-start-btn').addEventListener('click', function () {
            state.running = !state.running;
            if (state.running) {
                this.textContent = '停止';
                this.className = 'v2-btn v2-btn-danger';
                mainLoop();
            } else {
                this.textContent = '开始抢购';
                this.className = 'v2-btn v2-btn-primary';
                clearTimeout(state.timer);
                updatePanelState('已停止', 'idle');
            }
        });

        // 预存间隔
        document.getElementById('v2-precache-interval').addEventListener('input', function () {
            var val = parseInt(this.value, 10);
            if (val > 0) {
                CONFIG.PRECACHE_INTERVAL = val;
                saveSetting('v2_precache_interval', val);
            }
        });

        // 预存按钮
        document.getElementById('v2-precache-btn').addEventListener('click', function () {
            if (state.precacheRunning) {
                stopPrecache();
                return;
            }
            var count = getTargetPrecacheCount();
            precacheTokens(count);
        });

        // 清空 token
        document.getElementById('v2-clear-tokens-btn').addEventListener('click', function () {
            stopPrecache();
            clearCachedTokens();
        });

        // 预存数量 +/\-
        function adjustPrecacheCount(delta) {
            var el = document.getElementById('v2-precache-count');
            var v = parseInt(el.textContent, 10) || 0;
            v = Math.max(0, Math.min(5, v + delta));
            el.textContent = v;
            saveSetting('v2_precache_count', v);
        }
        document.getElementById('v2-precache-minus').addEventListener('click', function () { adjustPrecacheCount(-1); });
        document.getElementById('v2-precache-plus').addEventListener('click', function () { adjustPrecacheCount(1); });

        // 自动预存
        document.getElementById('v2-auto-precache').addEventListener('change', function () {
            saveSetting('v2_auto_precache', String(this.checked));
        });

        // 日志 toggle
        document.getElementById('v2-show-log').addEventListener('change', function () {
            var el = document.getElementById('v2-log-area');
            if (this.checked) {
                el.classList.remove('v2-log-hidden');
            } else {
                el.classList.add('v2-log-hidden');
            }
            saveSetting('v2_show_log', String(this.checked));
        });

        // 防检测 toggle
        document.getElementById('v2-anti-detect').addEventListener('change', function () {
            saveSetting('v2_anti_detect', String(this.checked));
            if (this.checked) {
                try {
                    var msgEl = document.createElement('div');
                    msgEl.id = 'v2-anti-detect-tip';
                    msgEl.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);' +
                        'background:rgba(0,0,0,0.85);color:#e6a23c;padding:12px 24px;border-radius:8px;' +
                        'font:14px/1.6 system-ui,sans-serif;z-index:2000000025;pointer-events:none;';
                    msgEl.textContent = '防检测已开启：点击验证码速度会调慢一点';
                    document.body.appendChild(msgEl);
                    setTimeout(function () { msgEl.remove(); }, 2500);
                } catch (e) {}
            }
        });

        // 详情弹窗关闭
        document.getElementById('v2-detail-close').addEventListener('click', function () {
            document.getElementById('v2-detail-overlay').style.display = 'none';
        });
        document.getElementById('v2-detail-overlay').addEventListener('click', function (e) {
            if (e.target === this) this.style.display = 'none';
        });

        // 预存帮助弹窗
        document.getElementById('v2-precache-help').addEventListener('click', function (e) {
            e.stopPropagation();
            document.getElementById('v2-help-overlay').style.display = 'flex';
        });
        document.getElementById('v2-help-close').addEventListener('click', function () {
            document.getElementById('v2-help-overlay').style.display = 'none';
        });
        document.getElementById('v2-help-overlay').addEventListener('click', function (e) {
            if (e.target === this) this.style.display = 'none';
        });

        // 主说明弹窗
        document.getElementById('v2-help-btn').addEventListener('click', function () {
            document.getElementById('v2-main-help-overlay').style.display = 'flex';
        });
        document.getElementById('v2-main-help-close').addEventListener('click', function () {
            document.getElementById('v2-main-help-overlay').style.display = 'none';
        });
        document.getElementById('v2-main-help-overlay').addEventListener('click', function (e) {
            if (e.target === this) this.style.display = 'none';
        });

        // 刷新产品数据
        document.getElementById('v2-refresh-btn').addEventListener('click', function () {
            var btn = this;
            btn.disabled = true;
            btn.textContent = '...';
            fetchBatchPreview({
                invitationCode: getQueryString('ic') || CONFIG.INVITATION_CODE
            }).then(function (resp) {
                if (resp.code === 200 && resp.data && resp.data.productList) {
                    updateProductsFromBatchPreview(resp.data.productList);
                    updateProductInfo();
                } else if (resp.code === 555) {
                    var infoEl = document.getElementById('v2-product-info');
                    if (infoEl) {
                        infoEl.textContent = '繁忙';
                        infoEl.style.color = '#e6a23c';
                    }
                } else {
                    log('产品', '刷新失败: ' + (resp.msg || resp.code));
                }
            }).catch(function (e) {
                log('产品', '刷新失败: ' + e.message);
            }).finally(function () {
                btn.disabled = false;
                btn.textContent = '刷新';
            });
        });

        document.getElementById('v2-test-btn').addEventListener('click', async function () {
            this.disabled = true;
            this.textContent = '识别中...';
            try {
                log('测试', '弹出验证码...');
                var result = await getCaptchaTicket();
                log('测试', '验证码通过！ticket: ' + result.ticket.substring(0, 30) + '...');
            } catch (e) {
                log('测试', '失败: ' + e.message);
            } finally {
                this.disabled = false;
                this.textContent = '测试验证码';
            }
        });

        // 保存设置
        document.getElementById('v2-buy-time').addEventListener('change', function () {
            saveSetting('v2_buy_time', this.value);
        });
        document.querySelectorAll('input[name="v2-package"]').forEach(function (r) {
            r.addEventListener('change', function () {
                saveSetting('v2_package', this.value);
                updateProductInfo();
                clickPagePackageTab();
                highlightPackageTab();
                // 切换套餐后等待页面卡片更新再高亮
                setTimeout(highlightPackageCard, 500);
            });
        });
        document.querySelectorAll('input[name="v2-tier"]').forEach(function (r) {
            r.addEventListener('change', function () {
                saveSetting('v2_tier', this.value);
                updateProductInfo();
                highlightPackageCard();
            });
        });

        // 拖拽
        makeDraggable(panel);

        // 恢复位置（clamp 防止负值导致面板不可见）
        var savedPos = loadSetting('v2_panel_pos', null);
        if (savedPos) {
            try {
                var pos = JSON.parse(savedPos);
                var clamped = clampPanelPos(pos.left, pos.top, 280, 100);
                panel.style.left = clamped.left + 'px';
                panel.style.top = clamped.top + 'px';
                panel.style.right = 'auto';
            } catch (e) {}
        }

        updateProductInfo();
    }

    function updateProductInfo() {
        var pkg = getSelectedPackageType();
        var tier = getSelectedTier();
        var product = PRODUCTS[pkg][tier];
        var el = document.getElementById('v2-product-info');
        if (el && product) {
            var priceText = product.payAmount ? '¥' + product.payAmount : '¥' + product.price;
            var stockText = product.soldOut ? ' [售罄]' : ' [有货]';
            el.textContent = product.productId + ' ' + priceText + stockText;
            el.style.color = product.soldOut ? '#f56c6c' : '#67c23a';
        }
    }

    function updatePanelState(text, statusClass) {
        var dot = document.getElementById('v2-status-dot');
        var textEl = document.getElementById('v2-status-text');
        if (textEl) textEl.textContent = text;
        if (dot) {
            dot.className = 'v2-status-dot';
            if (statusClass) dot.classList.add('v2-' + statusClass);
        }
    }

    function resetStartButton() {
        var btn = document.getElementById('v2-start-btn');
        if (btn) {
            btn.textContent = '开始抢购';
            btn.className = 'v2-btn v2-btn-primary';
        }
    }

    var logLines = [];
    function updateLog(msg) {
        logLines.push(new Date().toLocaleTimeString() + ' ' + msg);
        if (logLines.length > 50) logLines.shift();
        var el = document.getElementById('v2-log-area');
        if (el) {
            el.textContent = logLines.join('\n');
            el.scrollTop = el.scrollHeight;
        }
    }

    function clampPanelPos(left, top, elWidth, elHeight) {
        var vw = window.innerWidth;
        var vh = window.innerHeight;
        var minVisible = 40;
        var w = elWidth || 280;
        var h = elHeight || 100;
        // 左侧至少 minVisible 可见：left >= -(w - minVisible)
        // 右侧至少 minVisible 可见：left <= vw - minVisible
        var clampedLeft = Math.max(-(w - minVisible), Math.min(left, vw - minVisible));
        var clampedTop = Math.max(-(h - minVisible), Math.min(top, vh - minVisible));
        return { left: clampedLeft, top: clampedTop };
    }

    function makeDraggable(el) {
        var isDragging = false;
        var startX, startY, elStartX, elStartY;

        el.addEventListener('mousedown', function (e) {
            if (['BUTTON', 'INPUT', 'LABEL', 'TEXTAREA'].indexOf(e.target.tagName) >= 0) return;
            // 详情弹窗内允许文本选择，不触发拖拽
            if (e.target.closest && e.target.closest('.v2-detail-overlay')) return;
            isDragging = true;
            el.classList.add('v2-dragging');
            startX = e.clientX;
            startY = e.clientY;
            var rect = el.getBoundingClientRect();
            elStartX = rect.left;
            elStartY = rect.top;
            e.preventDefault();
        });

        document.addEventListener('mousemove', function (e) {
            if (!isDragging) return;
            el.style.left = (elStartX + e.clientX - startX) + 'px';
            el.style.top = (elStartY + e.clientY - startY) + 'px';
            el.style.right = 'auto';
        });

        document.addEventListener('mouseup', function () {
            if (isDragging) {
                isDragging = false;
                el.classList.remove('v2-dragging');
                var rect = el.getBoundingClientRect();
                var clamped = clampPanelPos(rect.left, rect.top, rect.width, rect.height);
                el.style.left = clamped.left + 'px';
                el.style.top = clamped.top + 'px';
                saveSetting('v2_panel_pos', JSON.stringify(clamped));
            }
        });
    }

    // ==================== 样式 ====================
    function injectStyles() {
        var css = '' +
            '#v2-control-panel {' +
            '  position: fixed; top: 50px; right: 10px; z-index: 2000000022;' +
            '  background: rgba(0,0,0,0.88); color: #fff;' +
            '  padding: 10px 14px; border-radius: 8px;' +
            '  font: 13px/1.6 "SF Mono", Consolas, monospace;' +
            '  user-select: none; cursor: move;' +
            '  box-shadow: 0 2px 8px rgba(0,0,0,0.3);' +
            '  min-width: 280px; max-width: 380px;' +
            '}' +
            '#v2-control-panel.v2-dragging { opacity: 0.8; }' +
            '.v2-panel-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }' +
            '.v2-label { color: #ccc; font-size: 12px; width: 32px; flex-shrink: 0; }' +
            '.v2-radio-group { display: flex; gap: 2px; }' +
            '.v2-radio-group input { display: none; }' +
            '.v2-radio-group label {' +
            '  padding: 2px 10px; border-radius: 4px; font-size: 11px; cursor: pointer;' +
            '  background: rgba(255,255,255,0.15); border: 1px solid rgba(255,255,255,0.3);' +
            '  transition: all 0.15s;' +
            '}' +
            '.v2-radio-group input:checked + label {' +
            '  background: #409eff; border-color: #409eff; color: #fff;' +
            '}' +
            'input[name="v2-package"]:checked + label { background: #e6a23c; border-color: #e6a23c; }' +
            '#v2-buy-time {' +
            '  width: 90px; background: rgba(255,255,255,0.15); color: #fff;' +
            '  border: 1px solid rgba(255,255,255,0.3); border-radius: 4px;' +
            '  padding: 2px 6px; font: 12px monospace;' +
            '}' +
            '.v2-status-dot {' +
            '  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;' +
            '  background: #909399;' +
            '}' +
            '.v2-status-dot.v2-running { background: #67c23a; animation: v2-pulse 1s infinite; }' +
            '.v2-status-dot.v2-waiting { background: #e6a23c; }' +
            '.v2-status-dot.v2-success { background: #67c23a; }' +
            '.v2-status-dot.v2-idle { background: #909399; }' +
            '@keyframes v2-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }' +
            '.v2-btn-row { margin-top: 8px; }' +
            '.v2-btn {' +
            '  cursor: pointer; color: #fff; border: none; border-radius: 4px;' +
            '  padding: 5px 14px; font: 12px monospace;' +
            '}' +
            '.v2-btn-primary { background: #409eff; }' +
            '.v2-btn-primary:hover { background: #66b1ff; }' +
            '.v2-btn-danger { background: #f56c6c; }' +
            '.v2-btn-danger:hover { background: #f78989; }' +
            '.v2-btn-secondary { background: #67c23a; }' +
            '.v2-btn-secondary:hover { background: #85ce61; }' +
            '.v2-btn:disabled { background: #909399; cursor: not-allowed; }' +
            '.v2-btn-mini {' +
            '  cursor: pointer; background: rgba(255,255,255,0.15); color: #fff;' +
            '  border: 1px solid rgba(255,255,255,0.3); border-radius: 4px;' +
            '  padding: 2px 10px; font-size: 12px; margin-left: 4px;' +
            '}' +
            '.v2-btn-mini:hover { background: rgba(255,255,255,0.25); }' +
            '.v2-btn-mini:disabled { opacity: 0.5; cursor: not-allowed; }' +
            '.v2-stepper { display: flex; align-items: center; gap: 0; }' +
            '.v2-stepper-btn {' +
            '  width: 22px; height: 22px; border: 1px solid rgba(255,255,255,0.3);' +
            '  background: rgba(255,255,255,0.15); color: #fff; font-size: 14px;' +
            '  cursor: pointer; display: flex; align-items: center; justify-content: center;' +
            '  line-height: 1; padding: 0;' +
            '}' +
            '.v2-stepper-btn:first-child { border-radius: 4px 0 0 4px; }' +
            '.v2-stepper-btn:last-child { border-radius: 0 4px 4px 0; }' +
            '.v2-stepper-btn:hover { background: rgba(255,255,255,0.3); }' +
            '.v2-stepper-val {' +
            '  width: 28px; height: 22px; border-top: 1px solid rgba(255,255,255,0.3);' +
            '  border-bottom: 1px solid rgba(255,255,255,0.3); background: rgba(0,0,0,0.3);' +
            '  color: #fff; font-size: 12px; text-align: center; line-height: 22px;' +
            '}' +
            '.v2-num-input {' +
            '  width: 40px; background: rgba(255,255,255,0.15); color: #fff;' +
            '  border: 1px solid rgba(255,255,255,0.3); border-radius: 4px;' +
            '  padding: 2px 4px; font: 12px monospace; text-align: center;' +
            '}' +
            '.v2-hint { color: #999; font-size: 11px; }' +
            '.v2-help-btn {' +
            '  display: inline-flex; align-items: center; justify-content: center;' +
            '  width: 14px; height: 14px; border-radius: 50%;' +
            '  background: rgba(255,255,255,0.2); color: #fff; font-size: 10px;' +
            '  border: 1px solid rgba(255,255,255,0.3); cursor: pointer;' +
            '  margin-left: 4px; padding: 0; line-height: 1; vertical-align: middle;' +
            '}' +
            '.v2-help-btn:hover { background: #409eff; border-color: #409eff; }' +
            '.v2-help-overlay {' +
            '  position: fixed; top: 0; left: 0; right: 0; bottom: 0;' +
            '  z-index: 2000000024; display: flex; align-items: center; justify-content: center;' +
            '  background: rgba(0,0,0,0.5);' +
            '}' +
            '.v2-help-box {' +
            '  background: #fff; color: #333; border-radius: 12px;' +
            '  max-width: 480px; width: 90%; max-height: 80vh; overflow-y: auto; padding: 24px 32px;' +
            '  box-shadow: 0 4px 20px rgba(0,0,0,0.3);' +
            '}' +
            '.v2-help-box h3 { margin: 0 0 16px 0; font-size: 18px; color: #409eff; border-bottom: 1px solid #eee; padding-bottom: 12px; }' +
            '.v2-help-box p { margin: 6px 0; font-size: 13px; line-height: 1.8; color: #333; }' +
            '.v2-help-box .v2-help-highlight { color: #e6a23c; font-weight: bold; }' +
            '.v2-help-box .v2-help-step { color: #67c23a; font-weight: bold; }' +
            '.v2-help-close {' +
            '  margin-top: 20px; cursor: pointer; background: #409eff; color: #fff;' +
            '  border: none; border-radius: 6px; padding: 8px 32px; font-size: 14px;' +
            '}' +
            '.v2-help-close:hover { background: #66b1ff; }' +
            '.v2-help-item {' +
            '  margin-bottom: 16px; padding-left: 24px; position: relative;' +
            '  font-size: 14px; line-height: 1.8; color: #333;' +
            '}' +
            '.v2-help-num {' +
            '  position: absolute; left: 0; color: #409eff; font-weight: bold;' +
            '}' +
            '.v2-bizid-input {' +
            '  flex: 1; min-width: 0; background: rgba(255,255,255,0.15); color: #fff;' +
            '  border: 1px solid rgba(255,255,255,0.3); border-radius: 4px;' +
            '  padding: 2px 6px; font: 11px monospace;' +
            '}' +
            '.v2-bizid-input::placeholder { color: rgba(255,255,255,0.4); }' +
            '.v2-product-info { color: #67c23a; font-size: 11px; }' +
            '.v2-log-area {' +
            '  margin-top: 8px; max-height: 120px; overflow-y: auto;' +
            '  background: rgba(0,0,0,0.3); border-radius: 4px; padding: 6px 8px;' +
            '  font-size: 10px; color: #ccc; white-space: pre-wrap; word-break: break-all;' +
            '}' +
            '.v2-log-area::-webkit-scrollbar { width: 4px; }' +
            '.v2-log-area::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 2px; }' +
            '.v2-log-hidden { display: none; }' +
            '.v2-separator { border-top: 1px solid rgba(255,255,255,0.15); margin: 6px 0; }' +
            '.v2-precache-row { gap: 4px !important; }' +
            '.v2-token-count { font-size: 12px; color: #e6a23c; min-width: 30px; text-align: center; }' +
            '.v2-token-table {' +
            '  width: 100%; border-collapse: collapse; margin: 4px 0;' +
            '  font-size: 10px; color: #ccc;' +
            '  display: block;' +
            '}' +
            '.v2-token-table thead { display: table; width: 100%; table-layout: fixed; }' +
            '.v2-token-table tbody {' +
            '  display: block; max-height: 220px; overflow-y: auto; width: 100%;' +
            '}' +
            '.v2-token-table thead tr, .v2-token-table tbody tr { display: table; width: 100%; table-layout: fixed; }' +
            '.v2-token-table tbody::-webkit-scrollbar { width: 3px; }' +
            '.v2-token-table tbody::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 2px; }' +
            '.v2-token-table th {' +
            '  text-align: left; padding: 2px 4px; color: #999; font-weight: normal;' +
            '  border-bottom: 1px solid rgba(255,255,255,0.15);' +
            '}' +
            '.v2-token-table td { padding: 2px 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }' +
            '.v2-token-table tr:hover { background: rgba(255,255,255,0.08); }' +
            '.v2-token-expired td { color: #666; text-decoration: line-through; }' +
            '.v2-token-empty { color: #666; font-style: italic; text-align: center; }' +
            '.v2-tag {' +
            '  display: inline-block; padding: 0 4px; border-radius: 2px; font-size: 9px;' +
            '}' +
            '.v2-tag-ok { background: rgba(103,194,58,0.2); color: #67c23a; }' +
            '.v2-tag-warn { background: rgba(230,162,60,0.2); color: #e6a23c; }' +
            '.v2-tag-err { background: rgba(245,108,108,0.2); color: #f56c6c; }' +
            '.v2-tag-sending { background: rgba(64,158,255,0.2); color: #409eff; }' +
            '.v2-checkbox-label {' +
            '  display: flex; align-items: center; gap: 4px; cursor: pointer;' +
            '  font-size: 12px; color: #ccc;' +
            '}' +
            '.v2-checkbox-label input { margin: 0; }' +
            '.v2-detail-overlay {' +
            '  position: fixed; top: 0; left: 0; right: 0; bottom: 0;' +
            '  z-index: 2000000023; display: flex; align-items: center; justify-content: center;' +
            '  background: rgba(0,0,0,0.5);' +
            '}' +
            '.v2-detail-box {' +
            '  background: #fff; color: #333; border-radius: 12px;' +
            '  max-width: 500px; width: 90%; max-height: 60vh; overflow: hidden;' +
            '  box-shadow: 0 4px 20px rgba(0,0,0,0.3);' +
            '  user-select: text; -webkit-user-select: text;' +
            '}' +
            '.v2-detail-header {' +
            '  display: flex; justify-content: space-between; align-items: center;' +
            '  padding: 12px 16px; border-bottom: 1px solid #eee;' +
            '  font-size: 14px; font-weight: bold; color: #333;' +
            '}' +
            '.v2-detail-header button {' +
            '  background: none; border: none; color: #999; font-size: 18px; cursor: pointer;' +
            '}' +
            '.v2-detail-body {' +
            '  padding: 16px; overflow-y: auto; max-height: 50vh; margin: 0;' +
            '  font-size: 12px; white-space: pre-wrap; word-break: break-all;' +
            '  color: #333; background: none;' +
            '}' +
            /* 套餐卡片高亮 */
            '.package-card-box.auto-buy-selected {' +
            '  border: 3px solid #e6a23c !important;' +
            '  box-shadow: 0 0 12px rgba(230, 162, 60, 0.5) !important;' +
            '}' +
            '.switch-tab-item.auto-buy-pkg-selected {' +
            '  border: 2px solid #e6a23c !important;' +
            '  box-shadow: 0 0 8px rgba(230, 162, 60, 0.5) !important;' +
            '  border-radius: 6px;' +
            '}';

        if (typeof GM_addStyle !== 'undefined') {
            GM_addStyle(css);
        } else {
            var style = document.createElement('style');
            style.textContent = css;
            document.head.appendChild(style);
        }
    }

    // ==================== 页面套餐高亮 ====================
    // 点击页面上对应的套餐 tab（月/季/年）
    function clickPagePackageTab() {
        var pkgType = getSelectedPackageType();
        var tabIndex;
        switch (pkgType) {
            case 'month':   tabIndex = 0; break;
            case 'quarter': tabIndex = 1; break;
            case 'year':    tabIndex = 2; break;
            default:        tabIndex = 1;
        }
        var tabItems = document.querySelectorAll('.switch-tab-box .switch-tab-item');
        if (tabItems.length > tabIndex) {
            var targetTab = tabItems[tabIndex];
            if (targetTab && !targetTab.classList.contains('active')) {
                targetTab.click();
            }
        }
    }

    // 高亮页面上当前选择的档位卡片（Lite=0, Pro=1, Max=2）
    function highlightPackageCard() {
        var tier = getSelectedTier();
        var idx;
        switch (tier) {
            case 'lite': idx = 0; break;
            case 'pro':  idx = 1; break;
            case 'max':  idx = 2; break;
            default:     idx = 2;
        }
        var cards = document.querySelectorAll('.package-card-box');
        cards.forEach(function (card, i) {
            if (i === idx) {
                card.classList.add('auto-buy-selected');
            } else {
                card.classList.remove('auto-buy-selected');
            }
        });
    }

    // 高亮页面上当前选择的套餐 tab
    function highlightPackageTab() {
        var pkgType = getSelectedPackageType();
        var tabIndex;
        switch (pkgType) {
            case 'month':   tabIndex = 0; break;
            case 'quarter': tabIndex = 1; break;
            case 'year':    tabIndex = 2; break;
            default:        tabIndex = 1;
        }
        var tabItems = document.querySelectorAll('.switch-tab-box .switch-tab-item');
        tabItems.forEach(function (item, i) {
            if (i === tabIndex) {
                item.classList.add('auto-buy-pkg-selected');
            } else {
                item.classList.remove('auto-buy-pkg-selected');
            }
        });
    }

    // ==================== 激活页面购买按钮 ====================
    // 修改 Vue 组件的产品数据，让页面上所有"已售罄"的按钮变为可点击
    function activatePageButtons() {
        function tryActivate() {
            var claudeBox = document.querySelector('.claude-code-box');
            var vue = claudeBox && claudeBox.__vue__;
            if (!vue || !Array.isArray(vue.allCardDataList) || vue.allCardDataList.length === 0) {
                setTimeout(tryActivate, 300);
                return;
            }
            vue.allCardDataList.forEach(function (item) {
                item.soldOut = false;
                item.canPurchase = true;
                item.disabled = false;
            });
            win.vueApp = vue;
            log('页面', '已激活所有购买按钮（soldOut=false）');

            // 初始化高亮
            highlightPackageCard();
            clickPagePackageTab();
            highlightPackageTab();
            // 点击tab后等待卡片更新再高亮一次
            setTimeout(highlightPackageCard, 600);
        }
        setTimeout(tryActivate, 500);
    }

    // ==================== 邀请码检查 ====================
    function checkAndFixInvitationCode() {
        if (location.pathname !== '/glm-coding') return;
        var currentIc = getQueryString('ic');
        if (currentIc !== CONFIG.INVITATION_CODE) {
            var url = new URL(location.href);
            url.searchParams.set('ic', CONFIG.INVITATION_CODE);
            log('初始化', '邀请码修正: ' + currentIc + ' -> ' + CONFIG.INVITATION_CODE);
            location.replace(url.toString());
        }
    }

    // ==================== 初始化 ====================
    async function init() {
        if (inCaptchaFrame) return;
        checkAndFixInvitationCode();
        injectStyles();
        createControlPanel();

        log('初始化', 'v2 纯接口模式启动');

        // 服务器时间同步
        syncServerTime();

        // 加载验证码SDK（重试3次）
        var sdkLoaded = false;
        for (var sdkRetry = 0; sdkRetry < 3; sdkRetry++) {
            try {
                await loadCaptchaScript();
                log('初始化', '腾讯验证码SDK已加载');
                sdkLoaded = true;
                break;
            } catch (e) {
                log('初始化', '验证码SDK加载失败(第' + (sdkRetry + 1) + '次): ' + e.message);
                if (sdkRetry < 2) await sleep(2000);
            }
        }
        if (!sdkLoaded) {
            log('初始化', '验证码SDK多次加载失败，将在抢购时继续尝试');
        }

        // 并行：获取用户信息 + 产品价格 + 检测OCR
        var initTasks = [];

        // 获取用户信息
        initTasks.push(
            fetchCustomerInfo().then(function (resp) {
                if (resp.code === 200 && resp.data) {
                    state.userInfo = resp.data;
                    state.customerNumber = resp.data.customerNumber;
                    state.customerName = resp.data.customerName;
                    log('初始化', '用户: ' + resp.data.customerName + ' (' + resp.data.customerNumber + ')');
                }
            }).catch(function (e) {
                log('初始化', '获取用户信息失败: ' + e.message);
            })
        );

        // 调用 batch-preview 获取最新产品价格和库存
        initTasks.push(
            fetchBatchPreview({
                invitationCode: getQueryString('ic') || CONFIG.INVITATION_CODE
            }).then(function (resp) {
                if (resp.code === 200 && resp.data && resp.data.productList) {
                    updateProductsFromBatchPreview(resp.data.productList);
                    updateProductInfo();
                } else {
                    log('产品', 'batch-preview 返回异常: ' + (resp.msg || resp.code));
                }
            }).catch(function (e) {
                log('产品', 'batch-preview 失败: ' + e.message);
            })
        );

        await Promise.all(initTasks);

        // 检测本地OCR
        checkLocalOcrService();

        // 激活页面按钮（参考v1：把Vue组件中所有产品的 soldOut/disabled 修改为可购买状态）
        activatePageButtons();

        // 启动 token 显示刷新
        startTokenDisplayRefresh();

        log('初始化', '就绪，点击「开始抢购」启动');
    }

    // ==================== 启动 ====================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
    win.win2 = window;
})(unsafeWindow);
