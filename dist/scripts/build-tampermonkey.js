/**
 * 油猴脚本构建器
 * 油猴脚本保持原样，不做任何修改
 * 只是从 tampermonkey/ 目录复制到 dist/ 目录，加 .user.js 后缀方便 Tampermonkey 识别
 *
 * 使用：
 *   node scripts/build-tampermonkey.js                # 构建所有版本
 *   node scripts/build-tampermonkey.js --version v2   # 只构建 v2
 *   node scripts/build-tampermonkey.js --version v1   # 只构建 v1
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TM_DIR = path.join(__dirname, '..', 'tampermonkey');
const OUTPUT_DIR = path.join(__dirname, '..', 'dist');
const VERSIONS = {
    v1: { file: 'index-v1.js', outputFile: 'glm-grabber-v1.user.js', desc: 'v1 - DOM寄生型（依赖页面Vue实例，XHR拦截）' },
    v2: { file: 'index-v2.js', outputFile: 'glm-grabber-v2.user.js', desc: 'v2 - 纯接口型（无DOM依赖，直接API调用）' },
};
const args = process.argv.slice(2);
let version = 'all';
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--version' && args[i + 1]) {
        version = args[i + 1];
        i++;
    }
}
// 确保输出目录存在
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}
console.log('╔══════════════════════════════════════╗');
console.log('║  油猴脚本构建器                       ║');
console.log('╚══════════════════════════════════════╝');
console.log('');
console.log('油猴脚本保持原样，不做任何修改');
console.log('Node.js OCR 服务与 Python ddddocr 接口完全兼容');
console.log('油猴脚本无需改动即可对接 Node.js OCR 服务');
console.log('');
function buildVersion(verKey) {
    const ver = VERSIONS[verKey];
    const srcPath = path.join(TM_DIR, ver.file);
    const outputPath = path.join(OUTPUT_DIR, ver.outputFile);
    if (!fs.existsSync(srcPath)) {
        console.error(`源文件不存在: ${srcPath}`);
        return;
    }
    fs.copyFileSync(srcPath, outputPath);
    console.log(`  ✓ ${ver.desc}`);
    console.log(`  ✓ 输出: ${outputPath}`);
    console.log('');
}
if (version === 'all') {
    console.log('构建所有版本:');
    console.log('');
    for (const key of Object.keys(VERSIONS)) {
        console.log(`── ${key} ──`);
        buildVersion(key);
    }
}
else if (VERSIONS[version]) {
    console.log(`构建 ${version}:`);
    console.log('');
    buildVersion(version);
}
else {
    console.error(`未知版本: ${version}`);
    console.error('可选版本: v1, v2, all');
    process.exit(1);
}
console.log('安装方法:');
console.log('  1. 打开 Tampermonkey 管理面板');
console.log('  2. 点击「实用工具」标签');
console.log('  3. 在「从文件导入」区域选择生成的 .user.js 文件');
console.log('  4. 或者直接复制文件内容，新建脚本粘贴');
console.log('');
console.log('注意:');
console.log('  v1 和 v2 脚本功能不同，不要同时安装两个版本');
console.log('  v1 = DOM寄生型，依赖页面Vue实例');
console.log('  v2 = 纯接口型，更稳定推荐使用');
console.log('  OCR 服务默认端口 9898，与油猴脚本中硬编码的地址一致');
//# sourceMappingURL=build-tampermonkey.js.map