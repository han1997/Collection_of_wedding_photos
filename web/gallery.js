import { $, el, bytes, date, message, mediaUrl } from "./api.js";

export function gallery(api, { admin = false, filters = () => "" } = {}) {
  const grid = $("#gallery"),
    more = $("#more"),
    dialog = $("#preview");
  let cursor = "",
    generation = 0,
    busy = false;
  const close = () => {
    dialog.close();
    $(".preview-content", dialog).replaceChildren();
  };
  $("[data-close]", dialog).onclick = close;
  dialog.addEventListener("close", () =>
    $(".preview-content", dialog).replaceChildren(),
  );
  async function preview(id) {
    try {
      const { media } = await api(
        `${admin ? "/api/admin" : "/api"}/media/${encodeURIComponent(id)}`,
      );
      const content = $(".preview-content", dialog);
      content.replaceChildren();
      const visual = document.createElement(
        media.kind === "video" ? "video" : "img",
      );
      if (media.kind === "video") {
        visual.controls = true;
        visual.preload = "metadata";
        visual.playsInline = true;
      } else visual.alt = "你选择查看的婚礼照片";
      visual.src = mediaUrl(media.videoUrl || media.previewUrl);
      const note = $(".preview-note", dialog);
      note.textContent = media.needsTranscode
        ? "此视频格式可能不受浏览器支持。可以下载原文件查看。"
        : `${date(media.createdAt)} · ${bytes(media.bytes)}`;
      visual.onerror = () => {
        note.textContent =
          "浏览器暂时无法预览此格式，原文件已保存，请下载后查看。";
      };
      content.append(visual);
      $(".download", dialog).href = mediaUrl(media.downloadUrl);
      $(".delete-media", dialog).onclick = async () => {
        if (!confirm("确定删除这份文件？删除后将从相册移除。")) return;
        try {
          await api(
            `${admin ? "/api/admin" : "/api"}/media/${encodeURIComponent(id)}`,
            { method: "DELETE" },
          );
          close();
          await load(true);
        } catch (error) {
          message(error.message, true);
        }
      };
      dialog.showModal();
    } catch (error) {
      message(error.message, true);
    }
  }
  function card(media) {
    const node = el("article", undefined, "media-card");
    const button = el("button", undefined, "media-thumb");
    button.setAttribute(
      "aria-label",
      `查看${media.kind === "video" ? "视频" : "照片"}，${date(media.createdAt)}`,
    );
    if (media.thumbUrl && media.status !== "processing") {
      const img = el("img");
      img.src = mediaUrl(media.thumbUrl);
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.onerror = () => {
        button.replaceChildren(
          el("span", media.kind === "video" ? "视频" : "原图已保存"),
        );
      };
      button.append(img);
    } else
      button.append(
        el("span", media.status === "processing" ? "预览处理中" : "视频"),
      );
    button.onclick = () => preview(media.id);
    const caption = el("div", undefined, "media-caption");
    caption.append(
      el("span", date(media.createdAt)),
      el("span", bytes(media.bytes)),
    );
    node.append(button, caption);
    return node;
  }
  async function load(reset = false) {
    if (busy && !reset) return;
    const ticket = ++generation;
    busy = true;
    if (reset) {
      cursor = "";
      grid.replaceChildren(
        ...Array.from({ length: 4 }, () => el("div", undefined, "skeleton")),
      );
    }
    more.disabled = true;
    try {
      const base = admin ? "/api/admin/media" : "/api/media";
      const data = await api(
        `${base}?limit=30&cursor=${encodeURIComponent(cursor)}${filters()}`,
      );
      if (ticket !== generation) return;
      if (reset) grid.replaceChildren();
      grid.append(...data.media.map(card));
      cursor = data.nextCursor;
      more.hidden = !cursor;
      if (!grid.children.length) {
        const empty = el("div", undefined, "empty");
        empty.append(
          el("strong", admin ? "还没有符合条件的作品" : "你的相册，等你来填满"),
          el(
            "span",
            admin
              ? "宾客上传后会出现在这里。"
              : "选几张喜欢的照片，分享给主办者。",
          ),
        );
        grid.append(empty);
      }
    } catch (error) {
      if (ticket !== generation) return;
      message(error.message, true);
      if (reset)
        grid.replaceChildren(
          el("p", "相册暂时无法载入，请点击刷新重试。", "empty"),
        );
    } finally {
      if (ticket === generation) {
        busy = false;
        more.disabled = false;
      }
    }
  }
  more.onclick = () => load();
  $("#refresh").onclick = () => load(true);
  return { load };
}
