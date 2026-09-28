/** 格式化工具 */

/** 字节数 → 人话 */
function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 毫秒 → mm:ss */
function formatDuration(ms) {
  const total = Math.round((Number(ms) || 0) / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * ISO 时间 → 上海时区的可读时间。
 * 服务端存的是 UTC，展示要给现场的北京时间。
 */
function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';

  // 用 toLocaleString 会受设备时区影响，所以手动按 UTC+8 算，
  // 保证不管宾客手机是什么时区，看到的都是现场时间。
  const shanghai = new Date(d.getTime() + 8 * 60 * 60 * 1000);

  const y = shanghai.getUTCFullYear();
  const mo = String(shanghai.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shanghai.getUTCDate()).padStart(2, '0');
  const h = String(shanghai.getUTCHours()).padStart(2, '0');
  const mi = String(shanghai.getUTCMinutes()).padStart(2, '0');

  return `${y}-${mo}-${day} ${h}:${mi}`;
}

/** 只取日期部分 */
function formatDate(iso) {
  const full = formatDateTime(iso);
  return full ? full.slice(0, 10) : '';
}

/** 时间差 → 「刚刚 / 5 分钟前 / 3 小时前」 */
function formatRelative(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (isNaN(then)) return '';

  const diff = Date.now() - then;
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / 86400000)} 天前`;
  return formatDate(iso);
}

module.exports = {
  formatBytes,
  formatDuration,
  formatDateTime,
  formatDate,
  formatRelative,
};
