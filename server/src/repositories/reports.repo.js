/**
 * 举报。
 *
 * 审核角度这是**性价比最高的一个功能**：任何带上传能力的小程序，
 * 审核都会找举报入口。实现成本极低，缺了却可能直接被拒。
 */
import { all, get, run } from '../db/index.js';
import { nowIso } from '../lib/time.js';

const REASONS = ['色情低俗', '违法违规', '侵权', '广告骚扰', '其他'];

export function isValidReason(reason) {
  return REASONS.includes(reason);
}

export const REASON_OPTIONS = REASONS;

/**
 * @param {{mediaId: string, reporterGuestId?: number, reason: string, detail?: string}} data
 */
export function create(data) {
  const res = run(
    `INSERT INTO reports (media_id, reporter_guest_id, reason, detail, status, created_at)
     VALUES (?, ?, ?, ?, 'open', ?)`,
    [data.mediaId, data.reporterGuestId ?? null, data.reason, data.detail ?? null, nowIso()],
  );
  return Number(res.lastInsertRowid);
}

/** 同一个人对同一条素材重复举报时，只保留一条，避免刷量 */
export function existsFromReporter(mediaId, reporterGuestId) {
  const row = get('SELECT 1 AS ok FROM reports WHERE media_id = ? AND reporter_guest_id = ?', [
    mediaId,
    reporterGuestId,
  ]);
  return Boolean(row);
}

export function listOpen(limit = 100) {
  return all(
    `SELECT r.*, m.event_id, m.guest_id, m.kind, m.ext
       FROM reports r
       JOIN media m ON m.id = r.media_id
      WHERE r.status = 'open'
      ORDER BY r.created_at DESC
      LIMIT ?`,
    [limit],
  );
}

export function countOpen() {
  return get("SELECT COUNT(*) AS c FROM reports WHERE status = 'open'").c;
}

export function setStatus(id, status) {
  run('UPDATE reports SET status = ? WHERE id = ?', [status, id]);
}
