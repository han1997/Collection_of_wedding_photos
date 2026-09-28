/**
 * ID 生成。
 *
 * eventId 刻意只用大写 [A-Z0-9]：
 *   · 会进 wxacode 的 scene 参数，微信对这个字段的字符集有限制，
 *     绝不能用中文或 URL。
 *   · 也是目录名的一部分，避开可能引起麻烦的符号。
 *   · 只用大写：用户手输活动码时小程序端会统一转大写再发给后端，
 *     而后端按 id 精确匹配。如果 id 里有小写，「1eu」和「1EU」就分家了——
 *     同一个活动用大小写两种写法都查得到，恰恰是重复活动的温床。
 *     纯大写让「转大写」变成无害操作，而不是制造歧义。
 */
import { customAlphabet } from 'nanoid';

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * 活动 ID：10 位。
 * 加前缀 "e=" 后是 12 字符，远低于 wxacode scene 的 32 字符上限。
 */
export const newEventId = customAlphabet(ALNUM, 10);

/** 媒体 ID：16 位。不可猜，且作为签名 URL 的载荷一部分。仅服务端流转，保留完整字母表。 */
export const newMediaId = customAlphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 16);

/** 上传会话 ID：21 位（与 nanoid 默认长度一致）。 */
export const newUploadId = customAlphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 21);

/** 文件名里的 4 位随机后缀，用于防碰撞。 */
export const newFileSuffix = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 4);

/**
 * 数值 ID 的短表示（base36，定长 6），用于文件名里标识「谁传的」。
 * 让用户在文件管理器里不看数据库也能认出上传者。
 * @param {number} n
 */
export function shortId(n) {
  return Number(n).toString(36).padStart(6, '0').slice(-6);
}
