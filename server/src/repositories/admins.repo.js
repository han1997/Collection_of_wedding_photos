/**
 * 管理员表的数据访问。
 *
 * 所有 SQL 都集中在这里，路由层不直接写 SQL——
 * 这样「哪张表被谁改过」是可检索的，改 schema 时也不会漏掉调用点。
 */
import { all, get, run } from '../db/index.js';
import { nowIso } from '../lib/time.js';

/** 对外返回的管理员信息（绝不包含 password_hash） */
function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    mustChangePassword: Boolean(row.must_change_password),
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

export function count() {
  return get('SELECT COUNT(*) AS c FROM admins').c;
}

/** 含 password_hash，仅供登录校验使用 */
export function findByUsernameWithHash(username) {
  return get('SELECT * FROM admins WHERE username = ?', [username]);
}

export function findById(id) {
  return toPublic(get('SELECT * FROM admins WHERE id = ?', [id]));
}

/** 轻量查询，鉴权中间件每个请求都要跑，只取必要字段 */
export function findAuthState(id) {
  return get('SELECT id, username, token_version, must_change_password FROM admins WHERE id = ?', [id]);
}

/**
 * @param {{username: string, passwordHash: string, displayName?: string, mustChangePassword?: boolean}} data
 */
export function create(data) {
  const now = nowIso();
  const res = run(
    `INSERT INTO admins (username, password_hash, display_name, must_change_password, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [data.username, data.passwordHash, data.displayName ?? null, data.mustChangePassword ? 1 : 0, now],
  );
  return Number(res.lastInsertRowid);
}

export function updateLastLogin(id) {
  run('UPDATE admins SET last_login_at = ? WHERE id = ?', [nowIso(), id]);
}

export function updatePasswordHash(id, passwordHash) {
  run('UPDATE admins SET password_hash = ?, must_change_password = 0 WHERE id = ?', [passwordHash, id]);
}

/**
 * 作废该管理员所有已签发的 token。
 * 改密码、发现异常登录时都要调它。
 */
export function bumpTokenVersion(id) {
  run('UPDATE admins SET token_version = token_version + 1 WHERE id = ?', [id]);
}

export function listAll() {
  return all('SELECT * FROM admins ORDER BY id').map(toPublic);
}
