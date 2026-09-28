/**
 * 裸流请求体解析器（只处理 application/octet-stream）。
 *
 * ★ 为什么需要它：Fastify 默认的 `bodyLimit` 是 1MB，而且默认解析器会把
 *   请求体整个读进内存。分片上传两者都不能接受。
 *
 * 这里把**原始流**原样交给 handler，让 handler 直接管道到磁盘——
 * 峰值内存只有一个流缓冲（约 64KB），不管分片多大。
 *
 * ⚠️ 刻意**不调大** bodyLimit。调大它等于允许任何人往内存里灌 100MB；
 *    交给裸流处理才是对的。
 *
 * 大小控制由 uploadService 里的 Transform 负责：超过该分片应有的大小就中断。
 */
import fp from 'fastify-plugin';

async function plugin(app) {
  app.addContentTypeParser(
    'application/octet-stream',
    (_request, payload, done) => {
      // 直接把流交出去，不做任何缓冲
      done(null, payload);
    },
  );
}

export default fp(plugin, { name: 'binary-body-parser' });
