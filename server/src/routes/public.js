import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { REPO_ROOT } from "../config.js";
import { currentEvent } from "../repositories/site.repo.js";
import { notFound } from "../lib/errors.js";

const require = createRequire(import.meta.url);
const webRoot = path.join(REPO_ROOT, "web");
const assets = [
  "styles.css",
  "api.js",
  "guest.js",
  "gallery.js",
  "uploader.js",
  "hash-worker.js",
  "admin.js",
];
const hashes = ["sha2.js", "_md.js", "_u64.js", "utils.js"];
const csp =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

export default async function publicRoutes(app) {
  for (const [url, file] of [
    ["/", "index.html"],
    ["/admin", "admin.html"],
    ["/privacy", "privacy.html"],
  ]) {
    app.get(url, async (request, reply) =>
      reply
        .type("text/html; charset=utf-8")
        .header("Content-Security-Policy", csp)
        .header("Cache-Control", "no-cache")
        .send(await fs.readFile(path.join(webRoot, file))),
    );
  }
  for (const file of assets) {
    app.get(`/assets/${file}`, async (request, reply) =>
      reply
        .type(file.endsWith(".css") ? "text/css" : "text/javascript")
        .header("Cache-Control", "no-cache")
        .send(await fs.readFile(path.join(webRoot, file))),
    );
  }
  for (const file of hashes) {
    app.get(`/assets/hash/${file}`, async (request, reply) =>
      reply
        .type("text/javascript")
        .send(
          await fs.readFile(
            path.join(
              path.dirname(require.resolve("@noble/hashes/sha2.js")),
              file,
            ),
          ),
        ),
    );
  }
  app.get("/e/:eventId", async (request, reply) => {
    if (request.params.eventId !== currentEvent().id)
      throw notFound("活动不存在");
    return reply.redirect("/");
  });
  app.get("/robots.txt", async (request, reply) =>
    reply.type("text/plain").send("User-agent: *\nDisallow: /\n"),
  );
}
