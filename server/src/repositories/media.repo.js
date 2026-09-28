/**
 * 媒体表。
 *
 * ★ 本文件是所有权的执行点。
 *   「宾客只能看到自己上传的内容」这条产品规则，最终就落在这里：
 *   **每一个宾客侧查询都必须同时带 event_id 和 guest_id**。
 *   任何只带其中一个的查询都是数据泄露，评审时必须重点看。
 *
 * 分页一律用游标（created_at + id 二元组），不用 offset：
 * 婚礼当天素材是持续涌入的，offset 分页会出现重复行和漏行。
 */
import { all, get, run } from '../db/index.js';
import { nowIso } from '../lib/time.js';

const FIELDS = `
  id, event_id, guest_id, kind, ext, mime, bytes,
  width, height, duration_ms, sha256,
  rel_path, preview_path, thumb_path, poster_path,
  status, fail_reason, needs_transcode, playable_path,
  sec_status, sec_label, sec_checked_at,
  client_taken_at, device_info, created_at, updated_at
`;

/** 宾客可见的状态。processing 和 ready 都能展示（processing 显示占位图）。 */
const GUEST_VISIBLE_STATUSES = "('processing', 'ready')";

function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    eventId: row.event_id,
    guestId: row.guest_id,
    kind: row.kind,
    ext: row.ext,
    mime: row.mime,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    status: row.status,
    failReason: row.fail_reason,
    needsTranscode: Boolean(row.needs_transcode),
    secStatus: row.sec_status,
    takenAt: row.client_taken_at,
    createdAt: row.created_at,
    // 路径不直接暴露给客户端——出网的是签名 URL，不是存储路径
    paths: {
      original: row.rel_path,
      preview: row.preview_path,
      thumb: row.thumb_path,
      poster: row.poster_path,
      playable: row.playable_path,
    },
  };
}

// ---------------------------------------------------------------------------
// 游标
// ---------------------------------------------------------------------------

/**
 * @param {{created_at: string, id: string}} row
 * @returns {string}
 */
export function encodeCursor(row) {
  if (!row) return '';
  return Buffer.from(`${row.created_at}|${row.id}`, 'utf8').toString('base64url');
}

/**
 * @param {string|undefined} cursor
 * @returns {{createdAt: string, id: string}|null}
 */
export function decodeCursor(cursor) {
  if (!cursor || typeof cursor !== 'string') return null;
  let raw;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const sep = raw.lastIndexOf('|');
  if (sep <= 0) return null;
  const createdAt = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  if (!createdAt || !id) return null;
  return { createdAt, id };
}

/**
 * 把游标条件拼成 SQL 片段。
 * 按 created_at DESC, id DESC 排序，所以「下一页」是严格小于。
 */
function cursorClause(cursor, params) {
  const c = decodeCursor(cursor);
  if (!c) return '';
  params.push(c.createdAt, c.createdAt, c.id);
  return ' AND (created_at < ? OR (created_at = ? AND id < ?))';
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

/**
 * @param {object} data
 * @returns {string} mediaId
 */
export function create(data) {
  const now = nowIso();

  run(
    `INSERT INTO media (
       id, event_id, guest_id, kind, ext, mime, bytes,
       width, height, duration_ms, sha256,
       rel_path, preview_path, thumb_path, poster_path,
       status, needs_transcode, sec_status,
       client_taken_at, device_info, source_ip,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.id,
      data.eventId,
      data.guestId,
      data.kind,
      data.ext,
      data.mime,
      data.bytes,
      data.width ?? null,
      data.height ?? null,
      data.durationMs ?? null,
      data.sha256 ?? null,
      data.relPath,
      data.previewPath ?? null,
      data.thumbPath ?? null,
      data.posterPath ?? null,
      data.status ?? 'processing',
      data.needsTranscode ? 1 : 0,
      data.secStatus ?? 'pending',
      data.clientTakenAt ?? null,
      data.deviceInfo ?? null,
      data.sourceIp ?? null,
      now,
      now,
    ],
  );

  return data.id;
}

/** 不经所有权校验的查找。仅供内部使用（例如 /f/ 签名 URL 已验证过持有者）。 */
export function findById(id) {
  return toPublic(get(`SELECT ${FIELDS} FROM media WHERE id = ? AND deleted_at IS NULL`, [id]));
}

/** 含已软删的原始行，用于删除、清理等需要完整信息的场合 */
export function findRawById(id) {
  return get('SELECT * FROM media WHERE id = ?', [id]);
}

/**
 * ★ 按 (id, event_id, guest_id) 三元组查找——宾客侧唯一的取文件路径。
 *
 * 越权时返回 null，路由层再转成 **404**（不是 403）：
 * 403 等于确认「这个 ID 存在」，本身就是信息泄露。
 *
 * @param {{id: string, eventId: string, guestId: number}} q
 */
export function findOwned({ id, eventId, guestId }) {
  return toPublic(
    get(
      `SELECT ${FIELDS} FROM media
        WHERE id = ? AND event_id = ? AND guest_id = ?
          AND deleted_at IS NULL AND status IN ${GUEST_VISIBLE_STATUSES}`,
      [id, eventId, guestId],
    ),
  );
}

/**
 * ★ 只按 (id, guest_id) 查找。
 *
 * 适用于「URL 里只有 mediaId、没有 eventId」的场合（删除、举报、换签名 URL）。
 * 这里用 `guest_id = ?` 而不是「先查出来再在 JS 里比 owner」——
 * **把所有权判断留在 SQL 里**，就不会出现「某条代码路径忘了比」的疏漏。
 * event_id 在那些接口里不是必需条件，guest_id 才是决定性的那一个。
 *
 * @param {{id: string, guestId: number}} q
 */
export function findOwnedAnyEvent({ id, guestId }) {
  return toPublic(
    get(
      `SELECT ${FIELDS} FROM media
        WHERE id = ? AND guest_id = ?
          AND deleted_at IS NULL AND status IN ${GUEST_VISIBLE_STATUSES}`,
      [id, guestId],
    ),
  );
}

/**
 * ★「我上传的」——唯一一个宾客侧的列表查询。
 * event_id 和 guest_id 一个都不能少。
 */
export function listMine({ eventId, guestId, cursor, limit = 30 }) {
  const params = [eventId, guestId];
  const clause = cursorClause(cursor, params);
  params.push(Math.min(Math.max(1, limit), 100));

  return all(
    `SELECT ${FIELDS} FROM media
      WHERE event_id = ? AND guest_id = ?
        AND deleted_at IS NULL AND status IN ${GUEST_VISIBLE_STATUSES}
        ${clause}
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
    params,
  ).map(toPublic);
}

/** 管理端：某场活动的全部素材，可按状态/类型/宾客过滤 */
export function listByEventAdmin({ eventId, guestId, kind, status, cursor, limit = 50 }) {
  const params = [eventId];
  let where = 'WHERE event_id = ? AND deleted_at IS NULL';

  if (guestId !== undefined && guestId !== null) {
    where += ' AND guest_id = ?';
    params.push(guestId);
  }
  if (kind) {
    where += ' AND kind = ?';
    params.push(kind);
  }
  if (status) {
    where += ' AND status = ?';
    params.push(status);
  }

  const clause = cursorClause(cursor, params);
  params.push(Math.min(Math.max(1, limit), 200));

  return all(
    `SELECT ${FIELDS} FROM media ${where} ${clause}
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
    params,
  ).map(toPublic);
}

/** 管理端：跨活动的全部素材 */
export function listAllAdmin({ eventId, guestId, kind, status, cursor, limit = 50 }) {
  const params = [];
  let where = 'WHERE deleted_at IS NULL';

  if (eventId) {
    where += ' AND event_id = ?';
    params.push(eventId);
  }
  if (guestId !== undefined && guestId !== null) {
    where += ' AND guest_id = ?';
    params.push(guestId);
  }
  if (kind) {
    where += ' AND kind = ?';
    params.push(kind);
  }
  if (status) {
    where += ' AND status = ?';
    params.push(status);
  }

  const clause = cursorClause(cursor, params);
  params.push(Math.min(Math.max(1, limit), 200));

  return all(
    `SELECT ${FIELDS} FROM media ${where} ${clause}
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
    params,
  ).map(toPublic);
}

// ---------------------------------------------------------------------------
// 更新
// ---------------------------------------------------------------------------

export function updateStatus(id, status, failReason = null) {
  run('UPDATE media SET status = ?, fail_reason = ?, updated_at = ? WHERE id = ?', [
    status,
    failReason,
    nowIso(),
    id,
  ]);
}

/** 处理管线回填衍生物信息 */
export function updateDerivatives(id, d) {
  run(
    `UPDATE media
        SET preview_path = ?, thumb_path = ?, poster_path = ?,
            width = COALESCE(?, width), height = COALESCE(?, height),
            duration_ms = COALESCE(?, duration_ms),
            needs_transcode = COALESCE(?, needs_transcode),
            updated_at = ?
      WHERE id = ?`,
    [
      d.previewPath ?? null,
      d.thumbPath ?? null,
      d.posterPath ?? null,
      d.width ?? null,
      d.height ?? null,
      d.durationMs ?? null,
      d.needsTranscode === undefined ? null : d.needsTranscode ? 1 : 0,
      nowIso(),
      id,
    ],
  );
}

export function updateSecurity(id, { status, label }) {
  run(
    'UPDATE media SET sec_status = ?, sec_label = ?, sec_checked_at = ?, updated_at = ? WHERE id = ?',
    [status, label ?? null, nowIso(), nowIso(), id],
  );
}

/**
 * 软删除。文件由调用方移进回收站。
 * 刻意不在这里 unlink——误触要能恢复，而且主持人可能想撤回删除。
 */
export function softDelete(id) {
  const now = nowIso();
  run('UPDATE media SET status = ?, deleted_at = ?, updated_at = ? WHERE id = ?', [
    'deleted',
    now,
    now,
    id,
  ]);
}

/** 启动时恢复中断的处理任务 */
export function listPendingProcessing(limit = 500) {
  return all(
    `SELECT ${FIELDS} FROM media
      WHERE status = 'processing' AND deleted_at IS NULL
      ORDER BY created_at ASC
      LIMIT ?`,
    [limit],
  ).map(toPublic);
}

export function countByEvent(eventId) {
  return get(
    `SELECT COUNT(*) AS c FROM media
      WHERE event_id = ? AND deleted_at IS NULL AND status <> 'deleted'`,
    [eventId],
  ).c;
}
