import { $, el, bytes, message } from "./api.js";

const stopError = () => new DOMException("已暂停", "AbortError");
function hashFile(file, signal, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker("/assets/hash-worker.js", { type: "module" });
    const finish = (error, result) => {
      worker.terminate();
      signal.removeEventListener("abort", abort);
      error ? reject(error) : resolve(result);
    };
    const abort = () => finish(stopError());
    signal.addEventListener("abort", abort, { once: true });
    worker.onerror = () =>
      finish(new Error("文件校验模块无法加载，请刷新后重试"));
    worker.onmessage = ({ data }) => {
      if (data.error) finish(new Error(data.error));
      else if (data.hash) finish(null, data.hash);
      else onProgress(data.progress);
    };
    worker.postMessage(file);
  });
}
function putPart(url, blob, token, signal, progress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    signal.addEventListener("abort", abort, { once: true });
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.timeout = 120000;
    xhr.upload.onprogress = (e) => progress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else {
        let body;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {}
        const err = new Error(body?.error?.message || "分片上传失败");
        err.status = xhr.status;
        reject(err);
      }
    };
    xhr.onerror = xhr.ontimeout = () =>
      reject(new Error("网络不稳定，分片上传中断"));
    xhr.onabort = () => reject(stopError());
    xhr.onloadend = () => signal.removeEventListener("abort", abort);
    if (signal.aborted) {
      reject(stopError());
      return;
    }
    xhr.send(blob);
  });
}

export function uploader(api, getToken, onComplete) {
  const tasks = [];
  let running = false;
  const list = $("#queue");
  const activeStates = ["等待上传", "校验文件", "上传中", "正在合并"];
  function progress(t, value) {
    t.progress = value;
    if (t.bar) t.bar.value = value;
  }
  function render() {
    $("#queue-section").hidden = !tasks.length;
    list.replaceChildren(
      ...tasks.map((t) => {
        const row = el("div", undefined, "queue-item");
        const info = el("div");
        info.append(
          el("div", t.name, "queue-name"),
          el("div", `${bytes(t.size)} · ${t.error || t.state}`, "queue-status"),
        );
        const actions = el("div", undefined, "queue-actions");
        function button(label, fn) {
          const b = el("button", label, "secondary");
          b.onclick = fn;
          actions.append(b);
        }
        if (["等待上传", "校验文件", "上传中"].includes(t.state))
          button("暂停", () => {
            t.state = "已暂停";
            t.controller?.abort();
            render();
          });
        if (["已暂停", "上传失败"].includes(t.state) && t.file)
          button("重试", () => {
            t.error = "";
            t.state = "等待上传";
            render();
            pump();
          });
        if (!t.file && t.state !== "已完成")
          button("选择原文件续传", () => {
            const input = document.createElement("input");
            input.type = "file";
            input.onchange = () => {
              const file = input.files[0];
              if (!file) return;
              if (file.size !== t.size) {
                message("文件大小不一致，请选择上次上传的原文件。", true);
                return;
              }
              t.file = file;
              t.state = "等待上传";
              t.error = "";
              render();
              pump();
            };
            input.click();
          });
        if (!activeStates.includes(t.state) || t.state === "等待上传")
          button(t.state === "已完成" ? "移除" : "取消", async () => {
            if (
              t.state !== "已完成" &&
              !confirm(
                "取消此任务并清除临时分片？已经上传成功的原文件不会被删除。",
              )
            )
              return;
            t.controller?.abort();
            try {
              if (t.id && t.state !== "已完成")
                await api(`/api/uploads/${t.id}`, { method: "DELETE" });
              tasks.splice(tasks.indexOf(t), 1);
              render();
            } catch (error) {
              message(error.message, true);
            }
          });
        const bar = el("progress");
        bar.max = 1;
        bar.value = t.progress || 0;
        t.bar = bar;
        bar.setAttribute("aria-label", `${t.name}进度`);
        row.append(info, actions, bar);
        return row;
      }),
    );
  }
  async function upload(t) {
    const signal = t.controller.signal;
    if (!t.hashChecked) {
      t.state = "校验文件";
      render();
      const hash = await hashFile(t.file, signal, (p) => progress(t, p));
      if (t.hash && t.hash !== hash)
        throw new Error("文件内容不一致。请取消此任务后重新选择原文件。");
      t.hash = hash;
      t.hashChecked = true;
    }
    if (signal.aborted) throw stopError();
    if (!t.id) {
      const data = await api("/api/uploads/init", {
        method: "POST",
        body: {
          fileName: t.name,
          mime: t.file.type,
          bytes: t.size,
          sha256: t.hash,
        },
      });
      t.id = data.sessionId;
    }
    const status = await api(`/api/uploads/${t.id}`);
    if (status.status === "completed") {
      t.state = "已完成";
      t.progress = 1;
      t.file = null;
      return;
    }
    if (status.status !== "open")
      throw new Error("上传会话不可继续，请取消后重新上传");
    const received = new Set(status.receivedParts);
    let sent = status.receivedBytes;
    t.state = "上传中";
    render();
    for (let part = 1; part <= status.totalParts; part++) {
      if (signal.aborted) throw stopError();
      if (received.has(part)) continue;
      const blob = t.file.slice(
        (part - 1) * status.chunkSize,
        part * status.chunkSize,
      );
      for (let retry = 0; ; retry++) {
        try {
          await putPart(
            `/api/uploads/${t.id}/parts/${part}`,
            blob,
            getToken(),
            signal,
            (n) => progress(t, (sent + n) / t.size),
          );
          break;
        } catch (error) {
          if (
            error.name === "AbortError" ||
            signal.aborted ||
            retry >= 2 ||
            (error.status && error.status < 500)
          )
            throw error;
          await new Promise((r) => setTimeout(r, 1000 * 2 ** retry));
          if (signal.aborted) throw stopError();
        }
      }
      sent += blob.size;
    }
    if (signal.aborted) throw stopError();
    t.state = "正在合并";
    render();
    await api(`/api/uploads/${t.id}/complete`, { method: "POST" });
    t.state = "已完成";
    t.progress = 1;
    t.file = null;
  }
  async function pump() {
    if (running) return;
    running = true;
    try {
      for (;;) {
        const t = tasks.find((t) => t.state === "等待上传");
        if (!t) break;
        t.controller = new AbortController();
        try {
          await upload(t);
          await onComplete();
        } catch (error) {
          t.state = t.controller.signal.aborted ? "已暂停" : "上传失败";
          t.error = t.controller.signal.aborted ? "" : error.message;
        }
        render();
      }
    } finally {
      running = false;
    }
  }
  async function restore() {
    const { sessions } = await api("/api/uploads");
    for (const s of sessions) {
      if (tasks.some((t) => t.id === s.sessionId)) continue;
      tasks.push({
        id: s.sessionId,
        name: s.fileName,
        size: s.declaredBytes,
        hash: s.sha256,
        state: "等待选择原文件",
        progress: s.receivedCount / s.totalParts,
      });
    }
    render();
  }
  function add(files) {
    for (const file of files)
      tasks.push({
        file,
        name: file.name,
        size: file.size,
        state: "等待上传",
        progress: 0,
      });
    render();
    pump();
  }
  window.addEventListener("beforeunload", (e) => {
    if (tasks.some((t) => activeStates.includes(t.state))) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  return { add, restore };
}
