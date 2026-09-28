/**
 * 配置：从环境变量读取、校验、定型。
 *
 * 设计原则：**缺关键配置就在启动时炸掉，并一次列全部问题**。
 * 最糟的情况是服务起来了、婚礼当天第一位宾客上传时才发现 AppSecret 没配。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** server/ 目录的绝对路径 */
export const SERVER_ROOT = path.resolve(__dirname, '..');
/** 仓库根目录的绝对路径 */
export const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

const isTest = process.env.NODE_ENV === 'test';

/** @type {string[]} */
const problems = [];

function str(name, fallback = undefined) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw;
}

function req(name) {
  const v = str(name);
  if (v === undefined) {
    problems.push(`缺少必填环境变量 ${name}`);
    return '';
  }
  return v;
}

function num(name, fallback) {
  const raw = str(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    problems.push(`环境变量 ${name} 必须是数字，当前是 ${JSON.stringify(raw)}`);
    return fallback;
  }
  return n;
}

function bool(name, fallback) {
  const raw = str(name);
  if (raw === undefined) return fallback;
  const v = raw.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  problems.push(`环境变量 ${name} 必须是布尔值（true/false/1/0），当前是 ${JSON.stringify(raw)}`);
  return fallback;
}

function enumOf(name, allowed, fallback) {
  const raw = str(name);
  if (raw === undefined) return fallback;
  if (!allowed.includes(raw)) {
    problems.push(`环境变量 ${name} 只能是 ${allowed.join(' | ')}，当前是 ${JSON.stringify(raw)}`);
    return fallback;
  }
  return raw;
}

/** 去掉末尾斜杠，避免拼出 https://x.com//api 这种地址 */
function trimSlash(u) {
  return u ? u.replace(/\/+$/, '') : u;
}

const nodeEnv = enumOf('NODE_ENV', ['development', 'production', 'test'], 'development');

// --- 基础 ---------------------------------------------------------------
const dataRoot = path.resolve(str('DATA_ROOT', path.join(REPO_ROOT, '_data')));
const port = num('PORT', 3000);

// --- 对外地址 -----------------------------------------------------------
const publicBaseUrl = trimSlash(str('PUBLIC_BASE_URL', `http://127.0.0.1:${port}`));
const mediaBaseUrl = trimSlash(str('MEDIA_BASE_URL') ?? publicBaseUrl);

// --- 密钥 ---------------------------------------------------------------
const jwtSecret = isTest ? (str('JWT_SECRET') ?? 'test-jwt-secret-not-for-production') : req('JWT_SECRET');
const fileTokenSecret = isTest
  ? (str('FILE_TOKEN_SECRET') ?? 'test-file-token-secret-not-for-production')
  : req('FILE_TOKEN_SECRET');

if (!isTest) {
  for (const [name, val] of [['JWT_SECRET', jwtSecret], ['FILE_TOKEN_SECRET', fileTokenSecret]]) {
    if (val && val.includes('CHANGE_ME')) {
      problems.push(`${name} 还是样例里的占位值，请用 \`openssl rand -base64 48\` 生成真实密钥`);
    } else if (val && val.length < 16) {
      problems.push(`${name} 太短（${val.length} 字符），至少 32 字符`);
    }
  }
  if (jwtSecret && jwtSecret === fileTokenSecret) {
    problems.push('JWT_SECRET 和 FILE_TOKEN_SECRET 必须不同：一个泄露不应导致另一个也失守');
  }
}

// --- 微信 ---------------------------------------------------------------
const wxAppId = str('WX_APPID', '');
const wxSecret = str('WX_SECRET', '');

// --- 上传限制 -----------------------------------------------------------
const maxUploadMb = num('MAX_UPLOAD_MB', 4096);
const chunkSizeMb = num('CHUNK_SIZE_MB', 4);

if (chunkSizeMb < 1 || chunkSizeMb > 16) {
  problems.push(`CHUNK_SIZE_MB 必须在 1..16 之间，当前是 ${chunkSizeMb}`);
}

// --- 生产环境的额外要求 -------------------------------------------------
if (nodeEnv === 'production' && !isTest) {
  if (!publicBaseUrl.startsWith('https://')) {
    problems.push(
      `PUBLIC_BASE_URL 在生产环境必须是 https://（小程序强制要求 HTTPS）。当前是 ${publicBaseUrl}`,
    );
  }
}

const config = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  isTest,
  port,
  dataRoot,

  publicBaseUrl,
  mediaBaseUrl,
  trustProxy: bool('TRUST_PROXY', false),

  secrets: {
    jwt: jwtSecret,
    fileToken: fileTokenSecret,
  },

  admin: {
    username: str('ADMIN_USERNAME', 'admin'),
    password: str('ADMIN_PASSWORD'),
  },

  wechat: {
    appId: wxAppId,
    secret: wxSecret,
    /** 是否具备调微信接口的条件；没有就走本地二维码兜底 */
    get configured() {
      return Boolean(wxAppId && wxSecret);
    },
    envVersion: enumOf('WX_ENV_VERSION', ['release', 'trial', 'develop'], 'trial'),
    qrPage: str('WX_QR_PAGE', 'pages/event/index'),
  },

  upload: {
    maxUploadBytes: Math.round(maxUploadMb * 1024 * 1024),
    maxGuestBytes: Math.round(num('MAX_GUEST_GB', 20) * 1024 ** 3),
    maxEventBytes: Math.round(num('MAX_EVENT_GB', 200) * 1024 ** 3),
    maxEventUploadsPerHour: num('MAX_EVENT_UPLOADS_PER_HOUR', 500),
    chunkSizeBytes: Math.round(chunkSizeMb * 1024 * 1024),
    /** 分片会话存活时长 */
    sessionTtlMs: 24 * 60 * 60 * 1000,
  },

  media: {
    thumbConcurrency: Math.max(1, num('THUMB_CONCURRENCY', 1)),
    transcodeEnabled: bool('TRANSCODE_ENABLED', false),
    remuxEnabled: bool('REMUX_ENABLED', false),
    /** 允许 resolve 的 ffmpeg / ffprobe 路径，找不到就优雅降级 */
    ffmpegPath: str('FFMPEG_PATH', 'ffmpeg'),
    ffprobePath: str('FFPROBE_PATH', 'ffprobe'),
  },

  contentCheck: {
    enabled: bool('CONTENT_CHECK_ENABLED', true),
  },

  /** 数据根目录下的固定子路径 */
  paths: {
    db: path.join(dataRoot, 'db'),
    dbFile: path.join(dataRoot, 'db', 'app.db'),
    dbBackups: path.join(dataRoot, 'db', 'backups'),
    events: path.join(dataRoot, 'events'),
    tmp: path.join(dataRoot, 'tmp'),
    tmpUploads: path.join(dataRoot, 'tmp', 'uploads'),
    tmpGc: path.join(dataRoot, 'tmp', 'gc'),
    qrCache: path.join(dataRoot, 'qrcache'),
    migrations: path.join(SERVER_ROOT, 'src', 'db', 'migrations'),
  },
};

if (problems.length) {
  const msg = [
    '',
    '配置有问题，服务无法启动：',
    ...problems.map((p) => `  · ${p}`),
    '',
    '参考 .env.example，或在项目根目录创建 .env 文件。',
    '',
  ].join('\n');
  throw new Error(msg);
}

export default config;
