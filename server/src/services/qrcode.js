import QRCode from "qrcode";
import config from "../config.js";

let cached;
export async function generateSiteQr() {
  cached ??= QRCode.toBuffer(`${config.publicBaseUrl}/`, {
    type: "png",
    width: 640,
    margin: 3,
    errorCorrectionLevel: "M",
  }).catch((err) => {
    cached = null;
    throw err;
  });
  return cached;
}
