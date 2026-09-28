/**
 * 宾客鉴权。
 *
 * 把 `requireGuest` 挂成 preHandler，路由里显式声明——
 * **绝不从 query/body 里猜身份**。身份只能来自签名过的 token。
 *
 * 用 fastify-plugin 包住，装饰才能穿透到各个路由插件里。
 */
import fp from 'fastify-plugin';
import { unauthorized } from '../lib/errors.js';
import { extractBearer, verifyToken } from '../lib/jwt.js';
import * as guestsRepo from '../repositories/guests.repo.js';

async function plugin(app) {
  /**
   * preHandler：校验 token、载入宾客、拒绝被封禁者。
   * 成功后把宾客对象挂在 request.guest 上。
   */
  app.decorate('requireGuest', async function requireGuest(request) {
    const token = extractBearer(request);
    if (!token) throw unauthorized('缺少登录凭证');

    let payload;
    try {
      payload = await verifyToken(token);
    } catch {
      // 具体原因（过期/签名错/格式错）不回给客户端——
      // 客户端一律「重新 wx.login 再试一次」，不需要区分。
      throw unauthorized('登录已失效，请重新进入');
    }

    if (payload.typ !== 'guest') throw unauthorized('凭证类型不匹配');

    const guest = guestsRepo.findById(payload.sub);
    if (!guest) throw unauthorized('用户不存在，请重新进入');

    // 每个请求都查一次 banned，而不是只在登录时判断：
    // 否则封禁要等 token 过期才生效，最长 7 天。
    if (guest.banned) throw unauthorized('该账号已被限制');

    request.guest = guest;
    request.guestTokenPayload = payload;
  });

  /**
   * 可选鉴权：有 token 就解析，没有也不拦。
   * 目前只用于「落地页」这类既想展示个性化信息、又要允许匿名访问的场景。
   */
  app.decorate('optionalGuest', async function optionalGuest(request) {
    const token = extractBearer(request);
    if (!token) return;
    try {
      const payload = await verifyToken(token);
      if (payload.typ !== 'guest') return;
      const guest = guestsRepo.findById(payload.sub);
      if (guest && !guest.banned) request.guest = guest;
    } catch {
      // 可选路径上静默失败即可
    }
  });
}

export default fp(plugin, { name: 'auth-guest' });
