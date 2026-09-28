/**
 * 安全响应头。
 *
 * 域名是公网 HTTPS，上线几小时内必然被扫。这些头成本极低，
 * 挡掉的是整类自动化扫描器。
 */
import fp from 'fastify-plugin';

async function plugin(app) {
  app.addHook('onSend', async (request, reply, payload) => {
    // 禁止浏览器猜类型——上传的文件绝不能被当成可执行内容渲染
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

    // 只在 HTTPS 下发 HSTS（本地 http 调试时发了会把自己锁死）
    if (request.protocol === 'https') {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    return payload;
  });
}

export default fp(plugin, { name: 'security-headers' });
