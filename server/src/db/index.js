/**
 * 数据库连接 —— node:sqlite（Node 内置）的薄封装。
 *
 * 为什么用内置的 node:sqlite 而不是 better-sqlite3：
 * 它能彻底去掉原生编译依赖，而原生模块正是 Docker 镜像在 ARM / 弱 NAS 上
 * 最容易构建失败的一环（见 plan 第三节）。
 *
 * 代价：node:sqlite 目前仍标记为 experimental，API 有变动可能。
 * 所以**所有 SQL 都必须经过这个文件**——将来要换回 better-sqlite3，
 * 只改这一处即可（两者 API 形状很接近：prepare/run/get/all）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let db = null;

/**
 * node:sqlite 的绑定参数只接受 null / number / bigint / string / Uint8Array。
 * JS 里习惯传的 undefined 和 boolean 会直接抛错，这里统一转掉。
 * @param {unknown[]} params
 * @returns {(null|number|bigint|string|Uint8Array)[]}
 */
function normalize(params) {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p instanceof Date) return p.toISOString();
    return /** @type {any} */ (p);
  });
}

/** 打开数据库（幂等）。目录不存在会自动建。 */
export function openDb({ file, verbose = false } = {}) {
  if (db) return db;
  if (!file) throw new Error('openDb 需要一个 file 参数');

  fs.mkdirSync(path.dirname(file), { recursive: true });

  db = new DatabaseSync(file);
  // 顺序有讲究：先设置 journal_mode 再设 synchronous。
  // WAL 只有在本地文件系统上才有效——绝不能把 DATA_ROOT 指向 NFS/SMB。
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');

  if (verbose) {
    const mode = db.prepare('PRAGMA journal_mode').get();
    console.log('[db] journal_mode =', mode?.journal_mode);
  }
  return db;
}

/** 拿到已打开的连接；未打开则抛错（保证启动顺序明确）。 */
export function getDb() {
  if (!db) throw new Error('数据库尚未打开，请先调用 openDb()');
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

/** 执行多条语句，不返回结果。 */
export function exec(sql) {
  return getDb().exec(sql);
}

/**
 * 查询多行。
 * @param {string} sql
 * @param {unknown[]} [params]
 */
export function all(sql, params = []) {
  return getDb().prepare(sql).all(...normalize(params));
}

/**
 * 查询单行，没有则返回 undefined。
 * @param {string} sql
 * @param {unknown[]} [params]
 */
export function get(sql, params = []) {
  return getDb().prepare(sql).get(...normalize(params));
}

/**
 * 执行写操作。
 * @param {string} sql
 * @param {unknown[]} [params]
 * @returns {{changes: number, lastInsertRowid: number}}
 */
export function run(sql, params = []) {
  return getDb().prepare(sql).run(...normalize(params));
}

/**
 * 在事务里执行。抛错自动回滚。
 * 注意：node:sqlite 没有 better-sqlite3 那样的 .transaction() 包装，手写即可。
 * 不支持嵌套——内层调用会直接复用同一事务（SQLite 本身不支持真正的嵌套事务）。
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
let inTx = false;
export function tx(fn) {
  if (inTx) return fn();
  const d = getDb();
  d.exec('BEGIN');
  inTx = true;
  try {
    const out = fn();
    d.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      d.exec('ROLLBACK');
    } catch {
      // 回滚本身失败时保留原始错误，它更有诊断价值
    }
    throw err;
  } finally {
    inTx = false;
  }
}

/**
 * 建表助手：检查某张表是否存在。
 * @param {string} name
 */
export function tableExists(name) {
  const row = get("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?", [name]);
  return Boolean(row);
}
