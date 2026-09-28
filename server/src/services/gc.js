/**
 * 清理任务。没有它，NAS 的磁盘会被慢慢吃掉。
 *
 * 清理三类东西：
 *   1. **过期的上传会话**——宾客传了一半就走了（弱网、没耐心、手机没电）。
 *      分片文件留在 tmp/ 里，不清理就会一直堆积。
 *   2. **回收站里的软删除文件**——留 24 小时是为了让误删可恢复，
 *      但过了就该真删，否则「删除」等于没删。
 *   3. **数据库备份轮转**——每晚做一份 VACUUM INTO 快照，只留最近若干份。
 *
 * 刻意不引入定时任务框架：进程内 setInterval 就够了，
 * 单容器部署也没有多副本竞争的问题。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import config from '../config.js';
import { exec } from '../db/index.js';
import { nowIso } from '../lib/time.js';
import * as uploadSessionsRepo from '../repositories/uploadSessions.repo.js';

/** 回收站里的文件保留多久 */
const GC_GRACE_MS = 24 * 60 * 60 * 1000;
/** 已完成的上传会话记录保留多久（分片早删了，记录只留作审计） */
const COMPLETED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** 备份保留份数 */
const BACKUP_KEEP = 14;

/**
 * 跑一轮清理。
 * @param {{log?: (...a: any[]) => void}} [opts]
 */
export async function runGc({ log = console.log } = {}) {
  const result = {
    expiredSessions: 0,
    gcFiles: 0,
    completedSessions: 0,
    backups: 0,
    bytesFreed: 0,
  };

  // --- 1. 过期上传会话 ------------------------------------------------------
  const now = nowIso();
  const expired = uploadSessionsRepo.listExpired(now);

  for (const session of expired) {
    try {
      const dir = path.join(config.paths.tmpUploads, session.id);
      result.bytesFreed += await dirSize(dir);
      await fsp.rm(dir, { recursive: true, force: true });
    } catch {
      // 目录可能已经没了
    }
    uploadSessionsRepo.remove(session.id);
    result.expiredSessions += 1;
  }

  if (result.expiredSessions) {
    log(`[gc] 清理了 ${result.expiredSessions} 个过期上传会话`);
  }

  // --- 2. 回收站 ------------------------------------------------------------
  try {
    const entries = await fsp.readdir(config.paths.tmpGc, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(config.paths.tmpGc, e.name);
      try {
        const st = await fsp.stat(p);
        if (Date.now() - st.mtimeMs < GC_GRACE_MS) continue;
        if (st.isDirectory()) {
          result.bytesFreed += await dirSize(p);
          await fsp.rm(p, { recursive: true, force: true });
        } else {
          result.bytesFreed += st.size;
          await fsp.unlink(p);
        }
        result.gcFiles += 1;
      } catch {
        // 文件刚好被别的进程删了
      }
    }
  } catch {
    // tmp/gc 还不存在
  }

  if (result.gcFiles) {
    log(`[gc] 从回收站永久删除了 ${result.gcFiles} 个文件`);
  }

  // --- 3. 已完成会话的旧记录 ------------------------------------------------
  const cutoff = new Date(Date.now() - COMPLETED_KEEP_MS).toISOString();
  const old = uploadSessionsRepo.listCompletedBefore(cutoff, 1000);
  for (const s of old) {
    uploadSessionsRepo.remove(s.id);
    result.completedSessions += 1;
  }
  if (result.completedSessions) {
    log(`[gc] 归档了 ${result.completedSessions} 条已完成的上传记录`);
  }

  // --- 4. 数据库备份 --------------------------------------------------------
  try {
    result.backups = await backupDatabase({ log });
  } catch (err) {
    log(`[gc] 数据库备份失败：${err.message}`);
  }

  return result;
}

/**
 * 用 VACUUM INTO 做一份数据库快照。
 *
 * 为什么用它而不是直接拷 .db 文件：WAL 模式下直接拷贝可能拿到一个
 * 「主文件是旧的、更新还在 WAL 里」的不一致快照。VACUUM INTO 会
 * 输出一个完整且一致的单文件。
 *
 * @param {{log?: (...a: any[]) => void}} [opts]
 */
async function backupDatabase({ log = console.log } = {}) {
  await fsp.mkdir(config.paths.dbBackups, { recursive: true });

  const stamp = nowIso().slice(0, 16).replace(/[-:T]/g, '').replace(/(\d{8})(\d{4})/, '$1-$2');
  const dest = path.join(config.paths.dbBackups, `app-${stamp}.db`);

  // VACUUM 不是普通语句，prepare 不了，必须用 exec 直接执行；
  // 也正因为如此它不接受参数绑定，路径要自己转义单引号。
  const escaped = dest.replace(/'/g, "''");
  exec(`VACUUM INTO '${escaped}'`);

  // 轮转：只留最近的若干份
  const files = (await fsp.readdir(config.paths.dbBackups))
    .filter((f) => f.startsWith('app-') && f.endsWith('.db'))
    .sort()
    .reverse();

  let removed = 0;
  for (const f of files.slice(BACKUP_KEEP)) {
    await fsp.unlink(path.join(config.paths.dbBackups, f)).catch(() => {});
    removed += 1;
  }

  if (removed) log(`[gc] 轮转掉 ${removed} 份旧备份`);
  return 1;
}

/** 目录占用字节数（不精确，用于统计释放量） */
async function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      total += await dirSize(p);
    } else if (e.isFile()) {
      total += (await fsp.stat(p).catch(() => ({ size: 0 }))).size;
    }
  }
  return total;
}

/**
 * 起一个定时清理。返回停止函数。
 * 进程启动时先跑一次——重启往往意味着之前不正常退出，
 * 正是最该清理的时候。
 * @param {{intervalMs?: number, log?: (...a: any[]) => void}} [opts]
 */
export function startGcSchedule({ intervalMs = 30 * 60 * 1000, log = console.log } = {}) {
  runGc({ log }).catch((err) => log(`[gc] 首次清理失败：${err.message}`));

  const timer = setInterval(() => {
    runGc({ log }).catch((err) => log(`[gc] 清理失败：${err.message}`));
  }, intervalMs);

  // 不要因为这个定时器让进程无法退出
  if (typeof timer.unref === 'function') timer.unref();

  return () => clearInterval(timer);
}
