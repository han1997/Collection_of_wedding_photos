/**
 * 宾客表。
 *
 * ⚠️ 这里的核心认知：**openid 是「相对该小程序」唯一的**。
 * 同一部手机上的同一个人，参加第一场婚礼和第二场婚礼，openid 是同一个。
 * 所以宾客是全局的，一个人一行；「谁参加过哪场」在 event_guests 里。
 *
 * 由此推出的结论：**不能拿 openid 去当某场活动的过滤条件**。
 * 要过滤「我在这场活动上传的东西」，必须用 (event_id, guest_id)。
 */
import { get, run } from '../db/index.js';
import { nowIso } from '../lib/time.js';

function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    openid: row.openid,
    banned: Boolean(row.banned),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

/**
 * 按 openid 找到或创建宾客，并刷新 last_seen_at。
 * @param {string} openid
 * @param {string|undefined} unionid
 */
export function upsertByOpenid(openid, unionid) {
  const now = nowIso();

  const existing = get('SELECT * FROM guests WHERE openid = ?', [openid]);
  if (existing) {
    run('UPDATE guests SET last_seen_at = ?, unionid = COALESCE(?, unionid) WHERE id = ?', [
      now,
      unionid ?? null,
      existing.id,
    ]);
    return toPublic({ ...existing, last_seen_at: now });
  }

  const res = run(
    'INSERT INTO guests (openid, unionid, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)',
    [openid, unionid ?? null, now, now],
  );

  return toPublic({
    id: Number(res.lastInsertRowid),
    openid,
    unionid: unionid ?? null,
    banned: 0,
    first_seen_at: now,
    last_seen_at: now,
  });
}

export function findById(id) {
  return toPublic(get('SELECT * FROM guests WHERE id = ?', [id]));
}

export function setBanned(id, banned) {
  run('UPDATE guests SET banned = ? WHERE id = ?', [banned ? 1 : 0, id]);
}
