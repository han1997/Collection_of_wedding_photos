/**
 * 迁移器：按文件名顺序执行 migrations/*.sql，已执行过的跳过。
 *
 * 迁移文件命名：NNN_name.sql（如 001_init.sql）。
 * 每个文件整体跑在一个事务里；失败就回滚，不会留下半张表。
 *
 * 规矩：**已发布的迁移文件不可修改**——只能新增。改旧的会导致
 * 别人的库和你的库结构不一致，而且不会有任何报错。
 */
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import { all, exec, run, tx } from './index.js';

const MIGRATION_RE = /^(\d+)_([\w-]+)\.sql$/;

/** 读取迁移目录，返回按版本号排序的列表 */
function listMigrations(dir = config.paths.migrations) {
  if (!fs.existsSync(dir)) return [];

  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const m = MIGRATION_RE.exec(name);
    if (!m) continue;
    out.push({ version: Number(m[1]), name: m[2], file: path.join(dir, name) });
  }
  out.sort((a, b) => a.version - b.version);

  // 版本号重复是配置错误，早炸掉
  for (let i = 1; i < out.length; i += 1) {
    if (out[i].version === out[i - 1].version) {
      throw new Error(`迁移版本号重复：${out[i - 1].file} 与 ${out[i].file}`);
    }
  }
  return out;
}

function ensureMigrationsTable() {
  exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

/**
 * 执行所有未应用的迁移。
 * @param {{dir?: string, log?: (...args: any[]) => void}} [opts]
 * @returns {{applied: number[], skipped: number}}
 */
export function migrate({ dir, log = console.log } = {}) {
  ensureMigrationsTable();

  const already = new Set(all('SELECT version FROM schema_migrations').map((r) => r.version));
  const applied = [];
  const migrations = listMigrations(dir);

  for (const mig of migrations) {
    if (already.has(mig.version)) continue;

    const sql = fs.readFileSync(mig.file, 'utf8');
    log(`[migrate] 应用 ${path.basename(mig.file)} …`);
    try {
      tx(() => {
        exec(sql);
        run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
          mig.version,
          mig.name,
          new Date().toISOString(),
        ]);
      });
    } catch (err) {
      throw new Error(`迁移 ${path.basename(mig.file)} 失败：${err.message}`, { cause: err });
    }
    applied.push(mig.version);
  }

  const skipped = migrations.length - applied.length;
  if (applied.length === 0) log(`[migrate] 无新迁移（共 ${skipped} 个已应用）`);
  return { applied, skipped };
}
