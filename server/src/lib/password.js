/**
 * 管理员密码哈希。
 *
 * 用 node:crypto 的 scrypt，不引第三方库：
 *   · 它是内存硬的（memory-hard），比 PBKDF2 抗 GPU 爆破
 *   · 内置意味着零原生依赖 —— 和选 node:sqlite 是同一个理由
 *
 * 存储格式：scrypt$N$r$p$saltB64$keyB64
 * 把参数一起存下来，将来调高 N 也能继续校验老密码。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// 参数取值：N=2^15（32768）在弱 NAS 上单次约几十毫秒，够用且不拖慢登录。
const N = 32768;
const R = 8;
const P = 1;
const KEY_LEN = 64;
const SALT_LEN = 32;

// scrypt 的内存用量约为 128 * N * r 字节，需要显式放宽 maxmem
const MAX_MEM = 128 * N * R * 2;

/**
 * @param {string} password
 * @returns {string} 形如 scrypt$32768$8$1$<saltB64>$<keyB64>
 */
export function hashPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('密码不能为空');
  }
  const salt = randomBytes(SALT_LEN);
  const key = scryptSync(password, salt, KEY_LEN, { N, r: R, p: P, maxmem: MAX_MEM });
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

/**
 * 校验密码。用 timingSafeEqual 做定长比较，避免通过响应时间侧信道猜密码。
 * @param {string} password
 * @param {string} stored
 * @returns {boolean}
 */
export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, nStr, rStr, pStr, saltB64, keyB64] = parts;
  const n = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(saltB64, 'base64');
    expected = Buffer.from(keyB64, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual;
  try {
    actual = scryptSync(password, salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: 128 * n * r * 2,
    });
  } catch {
    return false;
  }

  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export const MIN_PASSWORD_LENGTH = 8;

/**
 * 密码强度下限。只有这条要求——不搞「必须有大写字母和符号」那一套，
 * 那种规则只会逼出 `Password1!` 这种更差的密码。
 * @param {string} password
 * @returns {string|null} 不合格时返回原因，合格返回 null
 */
export function checkPasswordStrength(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `密码至少 ${MIN_PASSWORD_LENGTH} 位`;
  }
  if (/^(.)\1*$/.test(password)) return '密码不能是单一重复字符';
  return null;
}
