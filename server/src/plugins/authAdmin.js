/**
 * 管理员鉴权。
 *
 * 与宾客侧的关键差别：每次请求都要拿 token 里的 `ver` 和数据库里的
 * `admins.token_version` 比对。**改密码或强制下线只需把 token_version 加一，
 * 该账号所有已签发的 token 立即作废**——不需要维护黑名单。
 */
import fp from 'fastify-plugin';
import { forbidden, unauthorized } from '../lib/errors.js';
import { extractBearer, verifyToken } from '../lib/jwt.js';
import * as adminsRepo from '../repositories/admins.repo.js';

async function plugin(app) {
  app.decorate('requireAdmin', async function requireAdmin(request) {
    const token = extractBearer(request);
    if (!token) throw unauthorized('请先登录管理后台');

    let payload;
    try {
      payload = await verifyToken(token);
    } catch {
      throw unauthorized('登录已失效，请重新登录');
    }

    if (payload.typ !== 'admin') throw unauthorized('凭证类型不匹配');

    const state = adminsRepo.findAuthState(payload.sub);
    if (!state) throw unauthorized('账号不存在');

    if (Number(payload.ver) !== Number(state.token_version)) {
      throw unauthorized('登录已失效，请重新登录');
    }

    request.admin = {
      id: state.id,
      username: state.username,
      mustChangePassword: Boolean(state.must_change_password),
    };
  });

  /**
   * 强制改密拦截。
   * 初始密码来自环境变量，属于「临时密码」，改掉之前不允许使用其它管理接口——
   * 否则那个初始密码会一直有效，而它很可能被写在某处明文里。
   */
  app.decorate('requireAdminReady', async function requireAdminReady(request) {
    await app.requireAdmin(request);
    if (request.admin.mustChangePassword) {
      throw forbidden('请先修改初始密码');
    }
  });
}

export default fp(plugin, { name: 'auth-admin' });
