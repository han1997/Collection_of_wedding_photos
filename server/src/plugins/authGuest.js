import fp from "fastify-plugin";
import { extractBearer } from "../lib/jwt.js";
import { verifySession } from "../repositories/site.repo.js";

export default fp(
  async (app) => {
    app.decorate("requireGuest", async (request) => {
      request.guest = verifySession(extractBearer(request));
    });
  },
  { name: "auth-guest" },
);
