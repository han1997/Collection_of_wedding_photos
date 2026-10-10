import { generateSiteQr } from "../services/qrcode.js";
import config from "../config.js";

export default async function qrcodeRoutes(app) {
  app.get("/api/admin/qr", { preHandler: app.requireAdminReady }, async () => ({
    ok: true,
    data: {
      url: `${config.publicBaseUrl}/`,
      image: `data:image/png;base64,${(await generateSiteQr()).toString("base64")}`,
    },
  }));
}
