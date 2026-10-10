import { badRequest } from "../lib/errors.js";
import { toClientList } from "../services/mediaService.js";
import * as media from "../repositories/media.repo.js";

export default async function eventRoutes(app) {
  app.get("/api/media", { preHandler: app.requireGuest }, async (request) => {
    const limit = Number(request.query?.limit ?? 30);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw badRequest("分页数量不合法");
    const rows = media.listMine({
      eventId: request.guest.eventId,
      guestId: request.guest.id,
      cursor: request.query?.cursor,
      limit,
    });
    return {
      ok: true,
      data: {
        media: toClientList(rows, request.guest.id),
        nextCursor:
          rows.length === limit ? media.encodeCursor(rows.at(-1)) : "",
      },
    };
  });
}
