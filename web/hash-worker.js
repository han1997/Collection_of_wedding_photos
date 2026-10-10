import { sha256 } from "./hash/sha2.js";

self.onmessage = async ({ data: file }) => {
  try {
    const hash = sha256.create();
    const chunk = 4 * 1024 * 1024;
    for (let start = 0; start < file.size; start += chunk) {
      hash.update(
        new Uint8Array(await file.slice(start, start + chunk).arrayBuffer()),
      );
      self.postMessage({ progress: Math.min(1, (start + chunk) / file.size) });
    }
    self.postMessage({
      hash: Array.from(hash.digest(), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join(""),
    });
  } catch {
    self.postMessage({ error: "无法读取文件，请重新选择。" });
  }
};
