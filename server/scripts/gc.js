/**
 * 手动跑一轮清理。
 *
 *   npm run gc
 *
 * 服务运行时每 30 分钟会自动跑一次（见 services/gc.js），
 * 这个脚本是给「想立刻清一下」或者排查磁盘占用时用的。
 */
import config from '../src/config.js';
import { closeDb, openDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { ensureDataDirs } from '../src/services/storage.js';
import { runGc } from '../src/services/gc.js';

ensureDataDirs();
openDb({ file: config.paths.dbFile });
migrate({ log: () => {} });

console.log(`[gc] 数据目录：${config.dataRoot}`);
const result = await runGc();

console.log('');
console.log('清理结果：');
console.log(`  过期上传会话   ${result.expiredSessions} 个`);
console.log(`  回收站文件     ${result.gcFiles} 个`);
console.log(`  归档上传记录   ${result.completedSessions} 条`);
console.log(`  数据库备份     ${result.backups} 份`);
console.log(`  约释放         ${(result.bytesFreed / 1024 / 1024).toFixed(1)} MB`);

closeDb();
