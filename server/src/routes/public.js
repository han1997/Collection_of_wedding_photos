/**
 * 公开页面：H5 落地页、隐私政策。
 *
 * /e/:eventId 有两个用途：
 *   ① 小程序码生成失败时的**兜底二维码**指向这里
 *   ② 如果小程序**审核没过**，这套 H5 就是逃生通道——
 *      同一套后端、同一套存储布局，只是把上传前端从小程序换成网页，
 *      完全不需要微信审批
 *
 * 另外这两个页面也是**审核会去看的页面**：隐私政策要有一份能从
 * 「关于」点进来的全文，服务器上也要有一个可公开访问的地址。
 */
import * as eventsRepo from '../repositories/events.repo.js';

export default async function publicRoutes(app) {
  /**
   * H5 落地页。
   *
   * ⚠️ 它**不能**直接拉起小程序：从普通网页跳到小程序需要
   *    `wx-open-launch-weapp` 标签，而那个要求有已认证的**公众号**。
   *    本项目没有公众号，所以这里只能老实引导用户去微信里搜索。
   *    这也是为什么优先走小程序码——那条路是一步到位的。
   */
  app.get('/e/:eventId', async (request, reply) => {
    const event = eventsRepo.findById(request.params.eventId);

    const title = event ? event.title : '';
    const sub = event && event.coupleNames ? event.coupleNames : '';
    const date = event && event.eventDate ? event.eventDate : '';
    const venue = event && event.venue ? event.venue : '';

    reply.header('Content-Type', 'text/html; charset=utf-8');
    reply.header(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'none'",
    );

    if (!event) {
      return reply.code(404).send(htmlPage({
        title: '活动不存在',
        body: `<p class="muted">这个链接对应的活动不存在，或已经结束了。</p>`,
      }));
    }

    return reply.send(htmlPage({
      title: title || '婚礼照片收集',
      body: `
        <div class="hero">
          <div class="icon">💐</div>
          <h1>${esc(title)}</h1>
          ${sub ? `<p class="sub">${esc(sub)}</p>` : ''}
          ${date || venue ? `<p class="muted">${esc([date, venue].filter(Boolean).join(' · '))}</p>` : ''}
        </div>

        <div class="card">
          <p class="lead">请用微信扫一扫现场海报上的小程序码，即可上传你在婚礼上拍的照片和视频。</p>
          <p class="muted">
            也可以在微信里搜索小程序
            <strong>「婚礼照片收集助手」</strong>，
            进入后输入活动码
            <code>${esc(event.id)}</code>。
          </p>
        </div>

        <div class="card">
          <p class="muted small">
            你上传的照片和视频只有你自己和婚礼主办者能看到，其他宾客看不到。
          </p>
        </div>
      `,
    }));
  });

  /** 隐私政策全文。审核会找这个页面。 */
  app.get('/privacy', async (request, reply) => {
    reply.header('Content-Type', 'text/html; charset=utf-8');
    reply.header(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'",
    );

    return reply.send(htmlPage({
      title: '隐私政策',
      body: `
        <div class="hero">
          <h1>隐私政策</h1>
          <p class="muted">婚礼照片收集助手</p>
        </div>

        <div class="card">
          <h2>我们收集什么</h2>
          <ul>
            <li><strong>微信匿名标识（openid）</strong>——由微信生成的一串字符，仅用于区分「谁上传的」。
                我们不获取你的昵称、头像、手机号或任何可直接识别你身份的信息。</li>
            <li><strong>你主动选择的照片和视频</strong>——仅限你在小程序里主动挑选并上传的内容。</li>
            <li><strong>可选的称呼</strong>——你可以不填。填了只是为了让主办者知道照片是谁拍的。</li>
          </ul>
        </div>

        <div class="card">
          <h2>我们不收集什么</h2>
          <ul>
            <li>不获取你的位置信息</li>
            <li>不读取你的通讯录</li>
            <li>不获取你的手机号</li>
            <li>不使用摄像头或麦克风（除你在小程序内主动拍摄时）</li>
          </ul>
        </div>

        <div class="card">
          <h2>谁能看到你上传的内容</h2>
          <p>只有你本人，以及这场婚礼的主办者（主持人或新人）。其他宾客无法看到你上传的内容。</p>
          <p>你可以随时删除自己上传的任何内容，删除后我们会从服务器移除该文件。</p>
        </div>

        <div class="card">
          <h2>数据存储在哪里</h2>
          <p>所有照片和视频都存储在主办者自有的存储设备上，不上传到任何第三方云服务。</p>
          <p>我们会对上传的图片做一次安全检测，检测过程中会向微信发送一张压缩后的缩略图，
             用于判断内容是否违规。原图不会离开主办者的设备。</p>
        </div>

        <div class="card">
          <h2>联系方式</h2>
          <p>如有任何疑问，请联系活动主办者。</p>
        </div>
      `,
    }));
  });

  /**
   * 服务条款式的说明页。审核有时也会找。
   * 内容很薄，但比 404 好。
   */
  app.get('/robots.txt', async (request, reply) => {
    reply.header('Content-Type', 'text/plain; charset=utf-8');
    // 宾客的相册页和文件出口都不该被搜索引擎收录
    return reply.send(['User-agent: *', 'Disallow: /e/', 'Disallow: /f/', 'Disallow: /api/', ''].join('\n'));
  });
}

/** HTML 转义。活动标题是管理端输入的，直接插进模板就是 XSS。 */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 一个极简的自包含页面模板，不引任何外部资源 */
function htmlPage({ title, body }) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0 0 48px;
    background: #f7f7f8; color: #1a1a1a;
    font: 16px/1.7 -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Helvetica Neue', sans-serif;
    -webkit-text-size-adjust: 100%;
  }
  .hero { padding: 40px 24px 24px; text-align: center; }
  .hero .icon { font-size: 56px; line-height: 1; margin-bottom: 16px; }
  h1 { font-size: 22px; margin: 0; font-weight: 600; }
  h2 { font-size: 17px; margin: 0 0 12px; font-weight: 600; }
  .sub { margin: 8px 0 0; color: #4a4a4a; }
  .muted { color: #6b6b6b; margin: 6px 0 0; font-size: 14px; }
  .small { font-size: 13px; }
  .lead { margin: 0 0 12px; }
  .card {
    background: #fff; border-radius: 14px; padding: 20px;
    margin: 12px 16px; box-shadow: 0 1px 3px rgba(0,0,0,.05);
  }
  code {
    background: #f0eeec; padding: 2px 8px; border-radius: 6px;
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 15px; letter-spacing: 1px;
  }
  ul { margin: 0; padding-left: 20px; }
  li { margin-bottom: 8px; }
  strong { font-weight: 600; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}
