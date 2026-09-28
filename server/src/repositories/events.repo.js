/**
 * 活动（每场婚礼）。
 *
 * id 是 10 位 [A-Za-z0-9] 的 nanoid：既做数据库主键、又做目录名的一部分，
 * 还进 wxacode 的 scene 参数（那个字段对字符集有限制）。
 */
import { all, get, run } from '../db/index.js';
import { newEventId } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';
import { buildEventSlug } from '../services/storage.js';

const PUBLIC_FIELDS = `
  id, title, couple_names, event_date, venue, welcome_text, slug,
  qr_path, qr_env_version, qr_generated_at, qr_mode,
  upload_enabled, status, created_at, updated_at
`;

function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    coupleNames: row.couple_names,
    eventDate: row.event_date,
    venue: row.venue,
    welcomeText: row.welcome_text,
    slug: row.slug,
    qrPath: row.qr_path,
    qrEnvVersion: row.qr_env_version,
    qrGeneratedAt: row.qr_generated_at,
    qrMode: row.qr_mode,
    uploadEnabled: Boolean(row.upload_enabled),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // 这些只在管理端视图里出现
    ...(row.upload_count !== undefined
      ? { uploadCount: row.upload_count, guestCount: row.guest_count, totalBytes: row.total_bytes }
      : {}),
  };
}

/**
 * 建活动。slug 由标题/新人/日期派生，结尾带 eventId 保证唯一。
 * @param {{title: string, coupleNames?: string, eventDate?: string, venue?: string,
 *          welcomeText?: string, createdBy?: number}} data
 */
export function create(data) {
  const id = newEventId();
  const now = nowIso();

  const slug = buildEventSlug({
    id,
    title: data.title,
    couple_names: data.coupleNames,
    event_date: data.eventDate,
  });

  run(
    `INSERT INTO events
       (id, title, couple_names, event_date, venue, welcome_text, slug, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    [
      id,
      data.title,
      data.coupleNames ?? null,
      data.eventDate ?? null,
      data.venue ?? null,
      data.welcomeText ?? null,
      slug,
      data.createdBy ?? null,
      now,
      now,
    ],
  );

  return findById(id);
}

/** 未删除的活动 */
export function findById(id) {
  if (typeof id !== 'string' || id.length === 0) return null;
  return toPublic(
    get(`SELECT ${PUBLIC_FIELDS} FROM events WHERE id = ? AND deleted_at IS NULL`, [id]),
  );
}

export function findBySlug(slug) {
  return toPublic(
    get(`SELECT ${PUBLIC_FIELDS} FROM events WHERE slug = ? AND deleted_at IS NULL`, [slug]),
  );
}

/**
 * 管理端列表：带每场的上传数、宾客数、总字节数。
 * 用 LEFT JOIN 而不是子查询，一场都没传的活动也要显示出来（计数为 0）。
 */
export function listWithStats({ includeArchived = true } = {}) {
  const rows = all(`
    SELECT
      e.id, e.title, e.couple_names, e.event_date, e.venue, e.welcome_text, e.slug,
      e.qr_path, e.qr_env_version, e.qr_generated_at, e.qr_mode,
      e.upload_enabled, e.status, e.created_at, e.updated_at,
      COALESCE(COUNT(m.id), 0)               AS upload_count,
      COUNT(DISTINCT m.guest_id)             AS guest_count,
      COALESCE(SUM(m.bytes), 0)              AS total_bytes
    FROM events e
    LEFT JOIN media m
      ON m.event_id = e.id AND m.deleted_at IS NULL AND m.status <> 'deleted'
    WHERE e.deleted_at IS NULL
      ${includeArchived ? '' : "AND e.status = 'active'"}
    GROUP BY e.id
    ORDER BY COALESCE(e.event_date, e.created_at) DESC
  `);
  return rows.map(toPublic);
}

/** 请求体字段 → 数据库列名 */
const CAMEL_TO_SNAKE = {
  title: 'title',
  coupleNames: 'couple_names',
  eventDate: 'event_date',
  venue: 'venue',
  welcomeText: 'welcome_text',
  uploadEnabled: 'upload_enabled',
  status: 'status',
};

/** 允许更新的字段白名单：请求体字段名 → 入库前的转换函数 */
const UPDATABLE = {
  title: (v) => v,
  coupleNames: (v) => v,
  eventDate: (v) => v,
  venue: (v) => v,
  welcomeText: (v) => v,
  uploadEnabled: (v) => (v ? 1 : 0),
  status: (v) => v,
};

/**
 * 局部更新。只更新传进来的字段。
 * 字段名走白名单映射，绝不把请求体的键直接拼进 SQL。
 */
export function update(id, patch) {
  const sets = [];
  const params = [];

  for (const [key, mapFn] of Object.entries(UPDATABLE)) {
    if (patch[key] === undefined) continue;
    sets.push(`${CAMEL_TO_SNAKE[key]} = ?`);
    params.push(mapFn(patch[key]));
  }

  if (sets.length === 0) return findById(id);

  sets.push('updated_at = ?');
  params.push(nowIso(), id);

  run(`UPDATE events SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`, params);
  return findById(id);
}

/** 软删除。文件和媒体记录都保留，只是不再出现在任何列表里。 */
export function softDelete(id) {
  const now = nowIso();
  run('UPDATE events SET deleted_at = ?, updated_at = ?, status = ? WHERE id = ?', [
    now,
    now,
    'archived',
    id,
  ]);
}

export function setQr(id, { path, envVersion, mode }) {
  run(
    `UPDATE events
       SET qr_path = ?, qr_env_version = ?, qr_mode = ?, qr_generated_at = ?, updated_at = ?
     WHERE id = ?`,
    [path, envVersion ?? null, mode, nowIso(), nowIso(), id],
  );
}

/** 近一小时的上传次数，用于「单活动每小时上传上限」的配额判断 */
export function recentUploadCount(eventId, sinceIso) {
  const row = get(
    `SELECT COUNT(*) AS c FROM media
      WHERE event_id = ? AND created_at >= ? AND status <> 'deleted'`,
    [eventId, sinceIso],
  );
  return row?.c ?? 0;
}

/** 该活动已占用的总字节数（配额判断） */
export function totalBytes(eventId) {
  const row = get(
    `SELECT COALESCE(SUM(bytes), 0) AS b FROM media
      WHERE event_id = ? AND status <> 'deleted' AND deleted_at IS NULL`,
    [eventId],
  );
  return row?.b ?? 0;
}
