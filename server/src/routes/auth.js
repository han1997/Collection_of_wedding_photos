import { badRequest } from "../lib/errors.js";
import { extractBearer } from "../lib/jwt.js";
import {
  createSession,
  revokeSession,
  currentEvent,
  instanceId,
} from "../repositories/site.repo.js";
import * as memberships from "../repositories/eventGuests.repo.js";
import { sanitizeName, writeGuestManifest } from "../services/storage.js";

function displayName(body) {
  if (body?.displayName !== undefined && typeof body.displayName !== "string")
    throw badRequest("称呼必须是文字");
  return sanitizeName(body?.displayName ?? "", { maxLen: 24 }) || "";
}

export default async function authRoutes(app) {
  app.get("/api/site", async () => {
    const e = currentEvent();
    return {
      ok: true,
      data: {
        instanceId: instanceId(),
        event: {
          title: e.title,
          coupleNames: e.coupleNames,
          eventDate: e.eventDate,
          venue: e.venue,
          welcomeText: e.welcomeText,
          uploadEnabled: e.uploadEnabled && e.status === "active",
        },
      },
    };
  });
  app.post(
    "/api/auth/session",
    {
      config: {
        rateLimit: {
          max: 120,
          timeWindow: "1 minute",
          keyGenerator: (request) => request.ip,
        },
      },
    },
    async (request) => {
      const name = displayName(request.body);
      const result = createSession(name);
      await writeGuestManifest(result.guest.folderId, name);
      return {
        ok: true,
        data: { token: result.token, expiresAt: result.expiresAt },
      };
    },
  );
  app.get(
    "/api/auth/me",
    { preHandler: app.requireGuest },
    async (request) => ({
      ok: true,
      data: { me: memberships.find(request.guest.eventId, request.guest.id) },
    }),
  );
  app.patch(
    "/api/auth/me",
    { preHandler: app.requireGuest },
    async (request) => {
      const name = displayName(request.body);
      const me = memberships.ensure(
        request.guest.eventId,
        request.guest.id,
        name,
      );
      await writeGuestManifest(request.guest.folderId, name);
      return { ok: true, data: { me } };
    },
  );
  app.delete(
    "/api/auth/session",
    { preHandler: app.requireGuest },
    async (request) => {
      revokeSession(extractBearer(request));
      return { ok: true, data: {} };
    },
  );
}
