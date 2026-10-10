import fp from "fastify-plugin";
import rateLimit from "@fastify/rate-limit";
import { createHash } from "node:crypto";
import config from "../config.js";
import { ErrorCode } from "../lib/errors.js";

// 同一场宾客可能共用 Wi-Fi/反代出口。已认证请求按凭证分桶，避免互相耗尽额度。
export function requestKey(request) {
  const token = request.headers.authorization;
  return token ? createHash("sha256").update(token).digest("hex") : request.ip;
}

export default fp(
  async (app) => {
    await app.register(rateLimit, {
      global: true,
      max: 300,
      timeWindow: "1 minute",
      keyGenerator: requestKey,
      allowList: (request) =>
        config.isTest ||
        request.url.startsWith("/assets/") ||
        request.url.startsWith("/f/") ||
        request.url === "/api/health" ||
        request.url === "/healthz",
      errorResponseBuilder: () => ({
        ok: false,
        error: {
          code: ErrorCode.RATE_LIMITED,
          message: "请求过于频繁，请稍后再试",
        },
      }),
    });
  },
  { name: "rate-limit" },
);
