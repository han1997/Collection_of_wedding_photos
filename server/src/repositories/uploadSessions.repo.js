/**
 * 分片上传会话。
 *
 * ★ 续传的唯一真相来源就是这张表。
 *   客户端只缓存 sessionId（用来提示「继续上次上传」），
 *   **「哪些分片已经收到了」必须以服务端的 upload_parts 为准**。
 *   客户端本地记录可能在杀进程、清缓存、换设备后失真。
 */
import { all, get, run } from '../db/index.js';
import { nowIso } from '../lib/time.js';

const FIELDS = `
  id, event_id, guest_id, kind, mime, ext,
  declared_name, declared_bytes, declared_sha256,
  chunk_size, total_parts, tmp_dir, status, media_id,
  created_at, updated_at, expires_at
`;

function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    eventId: row.event_id,
    guestId: row.guest_id,
    kind: row.kind,
    mime: row.mime,
    ext: row.ext,
    declaredName: row.declared_name,
    declaredBytes: row.declared_bytes,
    declaredSha256: row.declared_sha256,
    chunkSize: row.chunk_size,
    totalParts: row.total_parts,
    tmpDir: row.tmp_dir,
    status: row.status,
    mediaId: row.media_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

export function create(data) {
  const now = nowIso();
  run(
    `INSERT INTO upload_sessions (
       id, event_id, guest_id, kind, mime, ext,
       declared_name, declared_bytes, declared_sha256,
       chunk_size, total_parts, tmp_dir, status,
       created_at, updated_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
    [
      data.id,
      data.eventId,
      data.guestId,
      data.kind,
      data.mime,
      data.ext,
      data.declaredName ?? null,
      data.declaredBytes,
      data.declaredSha256 ?? null,
      data.chunkSize,
      data.totalParts,
      data.tmpDir,
      now,
      now,
      data.expiresAt,
    ],
  );
  return findById(data.id);
}

export function findById(id) {
  if (typeof id !== 'string' || id.length === 0) return null;
  return toPublic(get(`SELECT ${FIELDS} FROM upload_sessions WHERE id = ?`, [id]));
}

/** ★ 按 (id, guest_id) 查找——所有权是查询条件的一部分 */
export function findOwned({ id, guestId }) {
  return toPublic(
    get(`SELECT ${FIELDS} FROM upload_sessions WHERE id = ? AND guest_id = ?`, [id, guestId]),
  );
}

// ---------------------------------------------------------------------------
// 分片
// ---------------------------------------------------------------------------

/**
 * 记录一个已收分片。**按 partNo 幂等**——客户端重发同一片不会出错，
 * 也不会把 total_parts 算多。
 * @returns {boolean} 是否是新增（false 表示这片之前就收到了）
 */
export function addPart(sessionId, partNo, bytes) {
  const existing = get('SELECT 1 AS ok FROM upload_parts WHERE session_id = ? AND part_no = ?', [
    sessionId,
    partNo,
  ]);
  if (existing) return false;

  run('INSERT INTO upload_parts (session_id, part_no, bytes, received_at) VALUES (?, ?, ?, ?)', [
    sessionId,
    partNo,
    bytes,
    nowIso(),
  ]);
  run('UPDATE upload_sessions SET updated_at = ? WHERE id = ?', [nowIso(), sessionId]);
  return true;
}

/** 已收到的分片号，升序 */
export function listParts(sessionId) {
  return all(
    'SELECT part_no, bytes FROM upload_parts WHERE session_id = ? ORDER BY part_no ASC',
    [sessionId],
  ).map((r) => ({ partNo: r.part_no, bytes: r.bytes }));
}

export function countParts(sessionId) {
  return get('SELECT COUNT(*) AS c FROM upload_parts WHERE session_id = ?', [sessionId]).c;
}

/** 已收分片的字节总数——用于和 declared_bytes 交叉核对 */
export function sumPartBytes(sessionId) {
  return (
    get('SELECT COALESCE(SUM(bytes), 0) AS b FROM upload_parts WHERE session_id = ?', [sessionId]).b ?? 0
  );
}

// ---------------------------------------------------------------------------
// 状态流转
// ---------------------------------------------------------------------------

export function setStatus(id, status, mediaId = undefined) {
  if (mediaId !== undefined) {
    run('UPDATE upload_sessions SET status = ?, media_id = ?, updated_at = ? WHERE id = ?', [
      status,
      mediaId,
      nowIso(),
      id,
    ]);
  } else {
    run('UPDATE upload_sessions SET status = ?, updated_at = ? WHERE id = ?', [status, nowIso(), id]);
  }
}

// ---------------------------------------------------------------------------
// 清理与配额
// ---------------------------------------------------------------------------

/** 已过期且未完成的会话，供 gc 清理 */
export function listExpired(nowIsoStr, limit = 200) {
  return all(
    `SELECT ${FIELDS} FROM upload_sessions
      WHERE expires_at < ? AND status IN ('open', 'assembling', 'failed')
      ORDER BY expires_at ASC
      LIMIT ?`,
    [nowIsoStr, limit],
  ).map(toPublic);
}

/** 已完成的旧会话（分片已删，记录留作审计） */
export function listCompletedBefore(iso, limit = 500) {
  return all(
    `SELECT id, status, created_at FROM upload_sessions
      WHERE status = 'completed' AND created_at < ?
      ORDER BY created_at ASC
      LIMIT ?`,
    [iso, limit],
  );
}

export function remove(id) {
  run('DELETE FROM upload_sessions WHERE id = ?', [id]);
}

/** 该宾客在该活动近期的上传会话数，用于限流/配额 */
export function countRecentByGuest(eventId, guestId, sinceIso) {
  return get(
    `SELECT COUNT(*) AS c FROM upload_sessions
      WHERE event_id = ? AND guest_id = ? AND created_at >= ?`,
    [eventId, guestId, sinceIso],
  ).c;
}

/** 该宾客在该活动尚未完成的会话（供客户端提示「继续上次上传」） */
export function listOpenByGuest(eventId, guestId) {
  return all(
    `SELECT ${FIELDS} FROM upload_sessions
      WHERE event_id = ? AND guest_id = ? AND status IN ('open', 'assembling')
        AND expires_at > ?
      ORDER BY created_at DESC
      LIMIT 20`,
    [eventId, guestId, nowIso()],
  ).map(toPublic);
}
