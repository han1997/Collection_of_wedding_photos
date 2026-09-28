/**
 * 时间处理。
 *
 * 全部时间戳以 ISO-8601 UTC 字符串入库。
 * 「哪一天」的判定必须按上海时区现算——**不能依赖进程 TZ**，
 * 因为 Docker 里 TZ 可能没设，而婚礼照片按天分目录是用户直接看得见的。
 */

/** 上海时区的格式化器（en-CA 的日期格式正好是 YYYY-MM-DD） */
const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** 当前时刻，ISO-8601 UTC 字符串 */
export function nowIso() {
  return new Date().toISOString();
}

/**
 * 把任意时间转为 ISO 字符串（已经是字符串的原样返回）。
 * @param {string|number|Date|undefined|null} v
 * @returns {string|null}
 */
export function toIso(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'string') return v;
  return new Date(v).toISOString();
}

/**
 * 上海时区下的 'YYYY-MM-DD'，用于按天分目录。
 * @param {Date|string|number} [d]
 */
export function shanghaiDay(d = new Date()) {
  return dayFmt.format(typeof d === 'string' || typeof d === 'number' ? new Date(d) : d);
}

/**
 * 上海时区下的 'HHMMSS'，用于文件名前缀。
 * 这样在 NAS 文件管理器里按文件名排序天然就是时间顺序。
 * @param {Date|string|number} [d]
 */
export function shanghaiHms(d = new Date()) {
  return timeFmt.format(typeof d === 'string' || typeof d === 'number' ? new Date(d) : d).replace(/:/g, '');
}

/**
 * 时间是否已过（用于 token / 会话过期判断）。
 * @param {string|null|undefined} iso
 */
export function isPast(iso) {
  if (!iso) return true;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return true;
  return t <= Date.now();
}

/**
 * 从某个时刻起算的 ISO 字符串。
 * @param {number} ms
 * @param {Date} [from]
 */
export function isoAfter(ms, from = new Date()) {
  return new Date(from.getTime() + ms).toISOString();
}
