/**
 * 统一错误类型与错误处理。
 *
 * 两条硬规矩：
 *   1. 响应体里的 error.code 是稳定的机器可读标识，前端按它分支；
 *      message 是给人看的，可以随时改。
 *   2. **越权访问一律回 404，不回 403**——403 等于告诉对方「这个 ID 存在，
 *      只是你没权限」，本身就是信息泄露。
 */

export const ErrorCode = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  UPLOAD_INCOMPLETE: 'UPLOAD_INCOMPLETE',
  WECHAT_ERROR: 'WECHAT_ERROR',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  INTERNAL: 'INTERNAL',
};

const DEFAULT_STATUS = {
  [ErrorCode.BAD_REQUEST]: 400,
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.RATE_LIMITED]: 429,
  [ErrorCode.QUOTA_EXCEEDED]: 429,
  [ErrorCode.PAYLOAD_TOO_LARGE]: 413,
  [ErrorCode.UNSUPPORTED_MEDIA_TYPE]: 415,
  [ErrorCode.UPLOAD_INCOMPLETE]: 409,
  [ErrorCode.WECHAT_ERROR]: 502,
  [ErrorCode.UPSTREAM_ERROR]: 502,
  [ErrorCode.INTERNAL]: 500,
};

export class AppError extends Error {
  /**
   * @param {string} code 取自 ErrorCode
   * @param {string} message 给人看的说明
   * @param {{status?: number, details?: any, cause?: unknown}} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = opts.status ?? DEFAULT_STATUS[code] ?? 500;
    this.details = opts.details;
    this.expose = this.status < 500;
    if (opts.cause) this.cause = opts.cause;
  }
}

export const badRequest = (msg, details) => new AppError(ErrorCode.BAD_REQUEST, msg, { details });
export const unauthorized = (msg = '请先登录') => new AppError(ErrorCode.UNAUTHORIZED, msg);

/** 资源不存在。**跨账号越权也走这个**，避免泄露存在性。 */
export const notFound = (msg = '资源不存在') => new AppError(ErrorCode.NOT_FOUND, msg);

export const conflict = (msg, details) => new AppError(ErrorCode.CONFLICT, msg, { details });
export const forbidden = (msg = '没有权限') => new AppError(ErrorCode.FORBIDDEN, msg);
export const quotaExceeded = (msg, details) => new AppError(ErrorCode.QUOTA_EXCEEDED, msg, { details });
export const unsupportedMedia = (msg, details) =>
  new AppError(ErrorCode.UNSUPPORTED_MEDIA_TYPE, msg, { details });
export const wechatError = (msg, details) => new AppError(ErrorCode.WECHAT_ERROR, msg, { details });

/**
 * Fastify 统一错误处理器。
 *
 * 5xx 只回一句笼统的话——堆栈和上游细节只进日志，绝不回给客户端。
 * 公网域名上线几小时内就会被扫，错误信息是最廉价的情报来源。
 */
export function errorHandler(error, request, reply) {
  // 显式抛出的 AppError
  if (error instanceof AppError) {
    if (error.status >= 500) {
      request.log.error({ err: error, code: error.code }, 'app error (5xx)');
    } else {
      request.log.info({ code: error.code, msg: error.message }, 'app error (4xx)');
    }
    return reply.code(error.status).send({
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    });
  }

  // Fastify 自带的状态码错误（body 过大、JSON 解析失败、路由未找到等）
  const status = Number(error.statusCode) || 500;

  if (status === 413) {
    return reply.code(413).send({
      ok: false,
      error: { code: ErrorCode.PAYLOAD_TOO_LARGE, message: '请求体过大' },
    });
  }
  if (status === 404) {
    return reply.code(404).send({
      ok: false,
      error: { code: ErrorCode.NOT_FOUND, message: '接口不存在' },
    });
  }
  if (status === 429) {
    return reply.code(429).send({
      ok: false,
      error: { code: ErrorCode.RATE_LIMITED, message: '请求过于频繁，请稍后再试' },
    });
  }
  if (status >= 400 && status < 500) {
    return reply.code(status).send({
      ok: false,
      error: { code: ErrorCode.BAD_REQUEST, message: '请求格式有误' },
    });
  }

  request.log.error({ err: error }, '未处理的服务端错误');
  return reply.code(500).send({
    ok: false,
    error: { code: ErrorCode.INTERNAL, message: '服务器内部错误' },
  });
}

/**
 * 成功响应信封。所有接口统一用它，前端解析逻辑只有一条路径。
 * @param {any} data
 */
export function ok(data) {
  return { ok: true, data };
}
