/**
 * 启动时的自举：建初始管理员、恢复中断的处理任务。
 *
 * 这两件事都属于「进程重启后要把世界恢复成该有的样子」，
 * 放在一起是为了让 index.js 的启动顺序一眼看清。
 */
import config from '../config.js';
import { checkPasswordStrength, hashPassword } from '../lib/password.js';
import { enqueue } from '../jobs/queue.js';
import { processMedia } from '../jobs/processMedia.js';
import * as adminsRepo from '../repositories/admins.repo.js';
import * as mediaRepo from '../repositories/media.repo.js';

/**
 * 首次启动且 admins 表为空时，用环境变量里的账号建一个管理员。
 *
 * 只在表为空时动手——**绝不覆盖已存在的账号**。
 * 静默改掉管理员密码是那种「平时看不出问题、出事时无法登录」的设计。
 *
 * @param {{log?: (...a: any[]) => void}} [opts]
 */
export function seedInitialAdmin({ log = console.log } = {}) {
  if (adminsRepo.count() > 0) return { created: false };

  const { username, password } = config.admin;

  if (!password) {
    log(
      '[bootstrap] ⚠️ 还没有管理员账号，且未配置 ADMIN_PASSWORD。\n' +
        '           管理后台无法登录。请在 .env 里设置 ADMIN_PASSWORD 后重启，\n' +
        '           或执行 npm run seed-admin。',
    );
    return { created: false, reason: 'no-password' };
  }

  const problem = checkPasswordStrength(password);
  if (problem) {
    log(`[bootstrap] ⚠️ ADMIN_PASSWORD 不合格（${problem}），未创建管理员。`);
    return { created: false, reason: 'weak-password' };
  }

  adminsRepo.create({
    username,
    passwordHash: hashPassword(password),
    displayName: username,
    // 来自环境变量的初始密码视为临时密码，首登强制修改
    mustChangePassword: true,
  });

  log(`[bootstrap] 已创建管理员「${username}」，首次登录后必须修改密码。`);
  return { created: true };
}

/**
 * 恢复中断的处理任务。
 *
 * 队列本身不持久——持久性靠 media.status 字段。进程重启后，
 * 把所有还是 'processing' 的记录重新入队即可。
 * 这比引入 Redis/BullMQ 简单得多，而效果对单容器部署来说是等价的。
 *
 * @param {{log?: (...a: any[]) => void}} [opts]
 */
export function recoverJobs({ log = console.log } = {}) {
  const pending = mediaRepo.listPendingProcessing();
  if (pending.length === 0) return { recovered: 0 };

  for (const media of pending) {
    enqueue(media.id, processMedia);
  }
  log(`[bootstrap] 已重新排队 ${pending.length} 个未完成的处理任务`);
  return { recovered: pending.length };
}
