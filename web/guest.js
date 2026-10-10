import { $, client, storage, message } from "./api.js";
import { gallery } from "./gallery.js";
import { uploader } from "./uploader.js";

const store = storage();
let token = "",
  key = "",
  ready = false,
  uploads,
  wedding;
const api = client(() => token);
const album = gallery(api);

async function connect(createNew = false) {
  ready = false;
  $("#files").disabled = true;
  $("#reconnect").hidden = true;
  $("#recovery").hidden = true;
  message("");
  try {
    const site = await api("/api/site");
    wedding = site.event;
    key = `wedding:${site.instanceId}:session`;
    $("#title").textContent = wedding.title;
    document.title = `${wedding.title} · 照片收集`;
    $("#couple").textContent = wedding.coupleNames || "";
    $("#date").textContent = wedding.eventDate || "相聚的日子，值得珍藏";
    $("#venue").textContent = wedding.venue || "";
    $("#welcome").textContent =
      wedding.welcomeText || "谢谢你，留下今天的美好瞬间。";
    token = createNew ? "" : store.get(key) || "";
    if (!token) {
      const session = await api("/api/auth/session", {
        method: "POST",
        body: { displayName: $("#name").value },
      });
      token = session.token;
      store.set(key, token);
    }
    const { me } = await api("/api/auth/me");
    $("#name").value = me.displayName || "";
    $("#session-note").textContent = store.available
      ? "已记住这次会话。同一浏览器再次扫码，可查看上次上传。请勿清除浏览器数据。"
      : "浏览器无法保存会话。当前仍可上传，但关闭页面后可能无法找回记录。";
    ready = true;
    $("#files").disabled = !wedding.uploadEnabled;
    if (!wedding.uploadEnabled)
      message("主办者已暂停接收文件，你仍可查看已上传记录。");
    uploads ??= uploader(
      api,
      () => token,
      () => album.load(true),
    );
    await uploads.restore();
    await album.load(true);
  } catch (error) {
    message(error.message, true);
    $("#session-note").textContent =
      "未连接到可用会话。已有原文件仍由主办者保管。";
    if (error.status === 401) $("#recovery").hidden = false;
    else $("#reconnect").hidden = false;
  }
}
$("#identity").onsubmit = async (e) => {
  e.preventDefault();
  if (!ready) {
    message("请先恢复连接。", true);
    return;
  }
  try {
    await api("/api/auth/me", {
      method: "PATCH",
      body: { displayName: $("#name").value },
    });
    message("称呼已保存，不会改变你的上传目录。");
  } catch (error) {
    message(error.message, true);
  }
};
$("#files").onchange = (e) => {
  if (ready && wedding.uploadEnabled) uploads.add(e.target.files);
  e.target.value = "";
};
const zone = $("#dropzone");
zone.addEventListener("dragover", (e) => {
  e.preventDefault();
  zone.classList.add("dragging");
});
zone.addEventListener("dragleave", () => zone.classList.remove("dragging"));
zone.addEventListener("drop", (e) => {
  e.preventDefault();
  zone.classList.remove("dragging");
  if (ready && wedding.uploadEnabled) uploads.add(e.dataTransfer.files);
  else message("当前无法上传，请检查连接或等待主办者开放上传。", true);
});
$("#new-session").onclick = () => {
  if (confirm("创建新会话？新会话不能访问上一个会话的上传记录。")) {
    store.remove(key);
    location.reload();
  }
};
$("#reconnect").onclick = () => connect();
window.addEventListener("offline", () =>
  message("网络已断开。请勿清除浏览器数据，联网后可重试。", true),
);
connect();
