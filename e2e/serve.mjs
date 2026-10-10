import { getApp, stopApp } from "../server/test/_app.js";
const app = await getApp();
await app.listen({ port: 3107, host: "127.0.0.1" });
process.on("SIGTERM", async () => {
  await stopApp();
  process.exit(0);
});
process.on("SIGINT", async () => {
  await stopApp();
  process.exit(0);
});
