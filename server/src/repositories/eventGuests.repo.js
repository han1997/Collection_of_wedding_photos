/**
 * 活动 × 宾客 关联表。
 *
 * 这张表同时承担两个职责：
 *   1. 记录「谁进过哪场活动」（用于按活动隔离）
 *   2. 缓存每场活动下每个人的上传统计（用于配额判断和展示）
 *
 * 计数必须在插入 media 的**同一个事务**里更新，否则会和实际条数漂移。
 */
import { all, get, run } from '../db/index.js';
import { nowIso } from '../lib/time.js';

function toPublic(row) {
  if (!row) return null;
  return {
    eventId: row.event_id,
    guestId: row.guest_id,
    displayName: row.display_name,
    firstJoinAt: row.first_join_at,
    lastActiveAt: row.last_active_at,
    uploadCount: row.upload_count,
    bytesUploaded: row.bytes_uploaded,
  };
}

/**
 * 确保关联存在（幂等）。重复进入同一场活动不会重复插入。
 *
 * displayName 是「有则更新」：宾客第二次进来填了新的称呼，以最新的为准。
 * 它只是个显示名，不是身份标识。
 * @param {string} eventId
 * @param {number} guestId
 * @param {string|null} [displayName]
 */
export function ensure(eventId, guestId, displayName = null) {
  const now = nowIso();

  const existing = get('SELECT * FROM event_guests WHERE event_id = ? AND guest_id = ?', [
    eventId,
    guestId,
  ]);

  if (existing) {
    const next = displayName ?? existing.display_name;
    run(
      'UPDATE event_guests SET last_active_at = ?, display_name = ? WHERE event_id = ? AND guest_id = ?',
      [now, next, eventId, guestId],
    );
    return toPublic({ ...existing, last_active_at: now, display_name: next });
  }

  run(
    `INSERT INTO event_guests
       (event_id, guest_id, display_name, first_join_at, last_active_at, upload_count, bytes_uploaded)
     VALUES (?, ?, ?, ?, ?, 0, 0)`,
    [eventId, guestId, displayName, now, now],
  );

  return toPublic({
    event_id: eventId,
    guest_id: guestId,
    display_name: displayName,
    first_join_at: now,
    last_active_at: now,
    upload_count: 0,
    bytes_uploaded: 0,
  });
}

export function find(eventId, guestId) {
  return toPublic(
    get('SELECT * FROM event_guests WHERE event_id = ? AND guest_id = ?', [eventId, guestId]),
  );
}

/**
 * 累加计数（上传成功后调用）。
 * @param {string} eventId
 * @param {number} guestId
 * @param {number} bytes
 */
export function bumpCounters(eventId, guestId, bytes) {
  run(
    `UPDATE event_guests
        SET upload_count = upload_count + 1,
            bytes_uploaded = bytes_uploaded + ?,
            last_active_at = ?
      WHERE event_id = ? AND guest_id = ?`,
    [bytes, nowIso(), eventId, guestId],
  );
}

/** 回退计数（软删除时调用）。用 MAX(0, …) 兜底，避免出现负数。 */
export function reduceCounters(eventId, guestId, bytes) {
  run(
    `UPDATE event_guests
        SET upload_count = MAX(0, upload_count - 1),
            bytes_uploaded = MAX(0, bytes_uploaded - ?)
      WHERE event_id = ? AND guest_id = ?`,
    [bytes, eventId, guestId],
  );
}

/** 该活动下的所有宾客（管理端看「谁传了多少」） */
export function listByEvent(eventId) {
  return all(
    `SELECT * FROM event_guests
      WHERE event_id = ?
      ORDER BY upload_count DESC, first_join_at ASC`,
    [eventId],
  ).map(toPublic);
}

/** 该活动下的宾客总数 */
export function countByEvent(eventId) {
  return get('SELECT COUNT(*) AS c FROM event_guests WHERE event_id = ?', [eventId]).c;
}
