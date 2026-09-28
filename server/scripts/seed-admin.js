/**
 * 从环境变量创建初始管理员。
 *
 *   npm run seed-admin
 *
 * 服务启动时也会自动做这件事（仅当 admins 表为空），所以这个脚本主要是
 * 给「忘了配 ADMIN_PASSWORD 想补上」或者「想重置初始账号」用的。
 *
 * ⚠️ 已存在同用户名时**不会**覆盖密码——静默改掉管理员密码太危险了。
 * 真要重置，用 --force（会同时作废所有已签发的会话）。
 */
import config from '../src/config.js';
import { closeDb, openDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { checkPasswordStrength, hashPassword } from '../src/lib/password.js';
import * as adminsRepo from '../src/repositories/admins.repo.js';
import { ensureDataDirs } from '../src/services/storage.js';

const force = process.argv.includes('--force');

ensureDataDirs();
openDb({ file: config.paths.dbFile });
migrate({ log: () => {} });

const username = config.admin.username;
const password = config.admin.password;

if (!password) {
  console.error('未配置 ADMIN_PASSWORD（请在 .env 或环境变量里设置）');
  process.exit(1);
}

const problem = checkPasswordStrength(password);
if (problem) {
  console.error(`ADMIN_PASSWORD 不合格：${problem}`);
  process.exit(1);
}

const existing = adminsRepo.findByUsernameWithHash(username);

if (existing && !force) {
  console.log(`管理员「${username}」已存在（id=${existing.id}），未做改动。`);
  console.log('如需重置密码，加 --force（会作废该账号所有已登录会话）。');
  closeDb();
  process.exit(0);
}

const hash = hashPassword(password);

if (existing) {
  adminsRepo.updatePasswordHash(existing.id, hash);
  adminsRepo.bumpTokenVersion(existing.id);
  console.log(`已重置管理员「${username}」的密码，并作废其所有旧会话。`);
} else {
  const id = adminsRepo.create({
    username,
    passwordHash: hash,
    displayName: username,
    // 从环境变量来的初始密码视为「临时密码」，首次登录必须改
    mustChangePassword: true,
  });
  console.log(`已创建管理员「${username}」（id=${id}）。`);
  console.log('首次登录后必须修改密码。');
}

closeDb();
