/**
 * 媒体类型白名单 + magic bytes 嗅探。
 *
 * 这是上传安全里最重要的一道控制，因为**文件最终落在用户会亲自去翻的 NAS 上**。
 *
 * 双层防御：
 *   ① 客户端声明的扩展名/MIME 必须在白名单里（挡住明显不对的东西）
 *   ② 落盘后按**实际字节**嗅探，确认容器格式和声明一致
 *      （挡住「文件名是 .jpg、内容是 HTML/脚本」这类多态文件）
 *
 * 再配合「任何存储目录都不作为静态内容对外提供」，
 * 可执行文件既建不出来，也执行不了。
 */

/** 扩展名 → MIME。这是唯一被认为合法的组合表。 */
const EXT_TO_MIME = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  bmp: 'image/bmp',

  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  '3gp': 'video/3gpp',
  webm: 'video/webm',
};

/**
 * 同一个容器的不同叫法，嗅探结果和声明不一样时允许互换。
 *
 * ⚠️ 视频这一组必须放宽到整个 ISO-BMFF 家族：
 *    .mov / .mp4 / .m4v / .3gp 是**同一个容器**，只是扩展名约定不同，
 *    而文件头里的 brand 字段并不能可靠区分它们
 *    （大量 .mov 的实际 brand 就是 `mp42`，而不是 `qt  `）。
 *    如果按 brand 严格比对扩展名，iPhone 拍的 .mov 会被全部拒掉。
 *
 *    放宽这一组**不会削弱安全属性**：多态文件（比如内容是 HTML 的
 *    「.jpg」）根本嗅探不成 ISO-BMFF，仍然会被拦下。
 *    真正要紧的判据是「声明为图片，实际是视频」这类跨类别的错配，
 *    那个由 kind 检查负责，仍然严格。
 */
const EQUIVALENT_EXT = [
  new Set(['jpg', 'jpeg']),
  new Set(['heic', 'heif']),
  new Set(['mp4', 'm4v', 'mov', '3gp']),
];

function isEquivalent(a, b) {
  if (a === b) return true;
  return EQUIVALENT_EXT.some((s) => s.has(a) && s.has(b));
}

/**
 * 把客户端给的文件名/类型归一化成白名单里的条目。
 * @param {string} filename
 * @param {string} [declaredMime]
 * @returns {{ext: string, mime: string, kind: 'image'|'video'}|null} 不在白名单则为 null
 */
export function normalizeDeclared(filename, declaredMime) {
  const raw = String(filename ?? '').trim();
  const dot = raw.lastIndexOf('.');
  if (dot < 0) return null;

  let ext = raw.slice(dot + 1).toLowerCase();
  // 有些客户端会传 image/jpg 这种非标准写法
  if (ext === 'jpe') ext = 'jpeg';

  const mime = EXT_TO_MIME[ext];
  if (!mime) return null;

  // 声明了 MIME 就一并核对；没声明则以扩展名为准
  if (declaredMime && typeof declaredMime === 'string' && declaredMime.trim()) {
    const declared = declaredMime.trim().toLowerCase();
    // 允许 image/jpg 这类历史写法
    const normalized = declared === 'image/jpg' ? 'image/jpeg' : declared;
    if (normalized !== mime) return null;
  }

  return { ext, mime, kind: mime.startsWith('video/') ? 'video' : 'image' };
}

/** 读 ASCII，越界部分补 \0 */
function ascii(buf, start, len) {
  return buf.toString('latin1', start, start + len);
}

/**
 * 按文件头字节判断真实类型。
 *
 * @param {Buffer} head 文件开头的若干字节（32 字节足够）
 * @returns {{ext: string, kind: 'image'|'video'} | null} 认不出来返回 null
 */
export function sniff(head) {
  if (!Buffer.isBuffer(head) || head.length < 12) return null;

  // JPEG: FF D8 FF
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { ext: 'jpg', kind: 'image' };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 &&
    head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a
  ) {
    return { ext: 'png', kind: 'image' };
  }

  // GIF: 'GIF87a' / 'GIF89a'
  const gif = ascii(head, 0, 6);
  if (gif === 'GIF87a' || gif === 'GIF89a') {
    return { ext: 'gif', kind: 'image' };
  }

  // WebP: 'RIFF' .... 'WEBP'
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') {
    return { ext: 'webp', kind: 'image' };
  }

  // BMP: 'BM'
  if (ascii(head, 0, 2) === 'BM') {
    return { ext: 'bmp', kind: 'image' };
  }

  // ISO-BMFF 家族（mp4 / mov / m4v / 3gp / heic / heif）：
  // 偏移 4 处是 'ftyp'，紧接着 4 字节是 brand
  if (ascii(head, 4, 4) === 'ftyp') {
    const brand = ascii(head, 8, 4).trim().toLowerCase();

    // HEIC / HEIF 系列
    if (['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) {
      return { ext: brand.startsWith('he') ? 'heic' : 'heif', kind: 'image' };
    }

    // 3GP
    if (brand.startsWith('3gp')) return { ext: '3gp', kind: 'video' };

    // QuickTime (.mov)。注意：很多 .mov 实际用 mp42/isom brand，
    // 所以这里不把 brand 当作扩展名的判据，只判断「属于这一类视频容器」。
    return { ext: 'mp4', kind: 'video' };
  }

  // WebM / Matroska: EBML 头 1A 45 DF A3
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return { ext: 'webm', kind: 'video' };
  }

  return null;
}

/**
 * 校验落盘后的真实类型是否与声明相符。
 *
 * @param {Buffer} head 文件开头字节
 * @param {{ext: string, kind: 'image'|'video'}} declared
 * @returns {{ok: true, detected: object} | {ok: false, reason: string}}
 */
export function verifyAgainstDeclared(head, declared) {
  const detected = sniff(head);
  if (!detected) {
    return { ok: false, reason: '无法识别的文件格式（可能不是真实的图片或视频）' };
  }
  if (detected.kind !== declared.kind) {
    return {
      ok: false,
      reason: `文件内容与声明的类型不符：声明为${declared.kind === 'video' ? '视频' : '图片'}，实际是${detected.kind === 'video' ? '视频' : '图片'}`,
    };
  }
  if (!isEquivalent(detected.ext, declared.ext)) {
    return {
      ok: false,
      reason: `文件内容与扩展名不符：声明 .${declared.ext}，实际是 .${detected.ext}`,
    };
  }
  return { ok: true, detected };
}

/** 允许的上传扩展名，用于错误提示和文档 */
export const ALLOWED_EXTENSIONS = Object.keys(EXT_TO_MIME);

/** 某些视频编码在安卓微信里会黑屏，标出来给前端降级展示 */
export function looksNeedsTranscode(ext) {
  return ext === 'mov';
}
