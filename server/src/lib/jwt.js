/**
 * 会话令牌（JWT，HS256）。
 *
 * 为什么用 jose 而不是手搓 HS256：算法混淆攻击、exp/nbf 校验、base64url 的边界情况
 * 都很容易写错，而这些错误不会以「报错」的形式出现，只会以「被绕过」的形式出现。
 *
 * 两类令牌分开签名、互相校验不了：
 *   · 宾客 token —— typ='guest'，7 天。婚礼当天不能反复要求登录。
 *   · 管理员 token —— typ='admin'，附带 token_version，改密码即可全部作废。
 */
import { SignJWT, jwtVerify } from 'jose';
import config from '../config.js';

const ISSUER = 'wedding-collect';
const AUDIENCE = 'wedding-collect';

const GUEST_TTL = '7d';
const ADMIN_TTL = '12h';

const secretKey = new TextEncoder().encode(config.secrets.jwt);

/**
 * @param {number} guestId
 * @param {string} openid
 */
export async function signGuestToken(guestId, openid) {
  return new SignJWT({ typ: 'guest', oid: openid })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(guestId))
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(GUEST_TTL)
    .sign(secretKey);
}

/**
 * @param {number} adminId
 * @param {number} tokenVersion 改密码/强制下线时递增，旧 token 立即失效
 */
export async function signAdminToken(adminId, tokenVersion) {
  return new SignJWT({ typ: 'admin', ver: tokenVersion })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(adminId))
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(ADMIN_TTL)
    .sign(secretKey);
}

/**
 * 校验并解出载荷。任何问题都抛错，由调用方转成 401。
 * @param {string} token
 * @returns {Promise<{typ: string, sub: number, oid?: string, ver?: number}>}
 */
export async function verifyToken(token) {
  const { payload } = await jwtVerify(token, secretKey, {
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ['HS256'], // 显式限定，防止 alg 混淆
  });

  const typ = payload.typ;
  if (typ !== 'guest' && typ !== 'admin') {
    throw new Error('令牌类型不认识');
  }

  const sub = Number(payload.sub);
  if (!Number.isInteger(sub) || sub <= 0) {
    throw new Error('令牌主体不合法');
  }

  return {
    typ,
    sub,
    ...(payload.oid ? { oid: String(payload.oid) } : {}),
    ...(payload.ver !== undefined ? { ver: Number(payload.ver) } : {}),
  };
}

/**
 * 从 Authorization 头里取出 Bearer token。取不到返回 null。
 * @param {import('fastify').FastifyRequest} request
 */
export function extractBearer(request) {
  const raw = request.headers.authorization;
  if (!raw || typeof raw !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1].trim() : null;
}
