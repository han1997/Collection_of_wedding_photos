/**
 * Fastify 应用装配。
 *
 * 这里只负责「把插件和路由拼起来」，不做监听、不做迁移——
 * 那些是 index.js 的事，好让测试可以直接 buildApp() 而不起端口。
 *
 * 注册顺序有讲究：限流和鉴权插件必须在路由之前注册，
 * 它们靠 hook/decorate 生效。
 */
import Fastify from 'fastify';
import config from './config.js';
import { errorHandler } from './lib/errors.js';

import securityHeaders from './plugins/securityHeaders.js';
import rateLimit from './plugins/rateLimit.js';
import binaryParser from './plugins/binaryParser.js';
import authGuest from './plugins/authGuest.js';
import authAdmin from './plugins/authAdmin.js';

import healthRoutes from './routes/health.js';
import authRoutes from './routes/auth.js';
import eventRoutes from './routes/events.js';
import mediaRoutes from './routes/media.js';
import uploadRoutes from './routes/upload.js';
import fileRoutes from './routes/files.js';
import adminRoutes from './routes/admin.js';
import qrcodeRoutes from './routes/qrcode.js';
import publicRoutes from './routes/public.js';

/**
 * 建一个 Fastify 实例（不监听）。
 * @param {{logger?: boolean|object}} [opts]
 */
export async function buildApp(opts = {}) {
  const app = Fastify({
    // 反代后面才拿得到真实 IP。⚠️ 若容器直接暴露公网，这会让直连者
    // 伪造 X-Forwarded-For —— 所以 compose 里只绑 127.0.0.1。
    trustProxy: config.trustProxy,

    // 请求体上限保持默认的 1MB 不动。
    // 分片上传刻意绕过它：原始流直接交给 handler，不缓冲（见 plugins/binaryParser.js）。
    bodyLimit: 1024 * 1024,

    // 路由参数长度上限。Fastify 默认 100，而 /f/:token 里的签名令牌
    // 光是 payload 加上 HMAC 就超过 100 字符，会被直接判成 414。
    maxParamLength: 512,

    logger:
      opts.logger === false
        ? false
        : {
            level: config.isProduction ? 'info' : 'debug',
            // 这些字段一旦进日志就等于泄露凭据
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.body.code',
                'req.body.password',
                'req.body.currentPassword',
                'req.body.newPassword',
                'req.body.session_key',
                'res.headers["set-cookie"]',
              ],
              censor: '[已隐藏]',
            },
            ...(typeof opts.logger === 'object' ? opts.logger : {}),
          },
  });

  app.setErrorHandler(errorHandler);

  // 未匹配的路由也走统一信封，别把 Fastify 的默认格式漏出去
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      ok: false,
      error: { code: 'NOT_FOUND', message: '接口不存在' },
    });
  });

  // --- 插件（顺序重要）-----------------------------------------------------
  await app.register(securityHeaders);
  await app.register(rateLimit);
  await app.register(binaryParser);
  await app.register(authGuest);
  await app.register(authAdmin);

  // --- 路由 ---------------------------------------------------------------
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(eventRoutes);
  await app.register(mediaRoutes);
  await app.register(uploadRoutes);
  await app.register(fileRoutes);
  await app.register(adminRoutes);
  await app.register(qrcodeRoutes);
  await app.register(publicRoutes);

  return app;
}
