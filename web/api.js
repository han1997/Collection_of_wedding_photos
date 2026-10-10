export const $ = (selector, root = document) => root.querySelector(selector);
export function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
export function storage(kind = "localStorage") {
  let available = true;
  const memory = new Map();
  return {
    get available() {
      return available;
    },
    get(key) {
      try {
        return window[kind].getItem(key) ?? memory.get(key) ?? null;
      } catch {
        available = false;
        return memory.get(key) ?? null;
      }
    },
    set(key, value) {
      memory.set(key, value);
      try {
        window[kind].setItem(key, value);
      } catch {
        available = false;
      }
    },
    remove(key) {
      memory.delete(key);
      try {
        window[kind].removeItem(key);
      } catch {
        available = false;
      }
    },
  };
}
export function client(getToken) {
  return async (url, { method = "GET", body, signal } = {}) => {
    const headers = {};
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        cache: "no-store",
      });
    } catch (cause) {
      throw new Error("连接中断，请检查网络后重试。已有记录不会丢失。", {
        cause,
      });
    }
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.ok) {
      const error = new Error(
        result?.error?.message || `请求失败（${response.status}）`,
      );
      error.status = response.status;
      throw error;
    }
    return result.data;
  };
}
export function message(text, isError = false) {
  const box = $("#message");
  box.textContent = text;
  box.hidden = !text;
  box.classList.toggle("error", isError);
}
export function bytes(value) {
  const units = ["B", "KB", "MB", "GB"];
  let n = Number(value) || 0,
    i = 0;
  while (n >= 1024 && i < 3) {
    n /= 1024;
    i++;
  }
  return `${i ? n.toFixed(1) : n} ${units[i]}`;
}
export const date = (value) =>
  new Date(value).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
// 原文件始终同源，不允许配置误差把匿名凭证或请求发给外站。
export function mediaUrl(value) {
  const url = new URL(value, location.origin);
  if (!url.pathname.startsWith("/f/")) throw new Error("文件地址无效");
  return `${url.pathname}${url.search}`;
}
