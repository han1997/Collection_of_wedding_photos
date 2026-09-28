/**
 * 只跑迁移，不起服务。
 *
 *   npm run migrate
 *
 * 部署时很有用：可以先确认 schema 就位，再启动容器。
 */
import config from '../src/config.js';
import { closeDb, openDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { ensureDataDirs } from '../src/services/storage.js';

ensureDataDirs();
openDb({ file: config.paths.dbFile });

console.log(`[migrate] 数据库：${config.paths.dbFile}`);
const { applied, skipped } = migrate();

if (applied.length) {
  console.log(`[migrate] 完成，新应用 ${applied.length} 个迁移`);
} else {
  console.log(`[migrate] 已完成，无需变更（已应用 ${skipped} 个）`);
}

closeDb();
