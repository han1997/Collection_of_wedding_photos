/**
 * 测试环境准备。
 *
 * ⚠️ 这个模块必须在任何 src/ 模块**之前**被 import——
 * config.js 在 import 时就会读 process.env 并定型。
 * ESM 的静态 import 按书写顺序执行，所以测试文件里把它写在第一行即可。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NODE_ENV = 'test';
process.env.TZ = 'Asia/Shanghai';

// 每次跑测试用一个独立的临时数据目录，避免污染开发数据
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wedding-test-'));
process.env.DATA_ROOT = dir;

// 测试环境的密钥（config.js 在 test 模式下不强制要求）
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef0123456789';
process.env.FILE_TOKEN_SECRET = 'test-file-secret-0123456789abcdef0123456789';
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:3000';

// 微信凭据：测试里不会真的调微信，而是把 globalThis.fetch 换成假的
// （见 integration.test.js）。但 config.wechat.configured 必须为真，
// 否则 code2Session 会提前抛 503，测不到后面的逻辑。
process.env.WX_APPID = 'wxtestappid';
process.env.WX_SECRET = 'test-secret';

process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'test-admin-password';

// 关掉内容安全检测：它要真的去调微信接口，而测试里的假 fetch 会拒绝非登录的地址。
// 关掉之后走的是 'skipped' 分支，仍然是生产代码里一条正常路径。
process.env.CONTENT_CHECK_ENABLED = 'false';

export const TEST_DATA_ROOT = dir;

process.on('exit', () => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 临时目录清不掉不值得让测试失败
  }
});
