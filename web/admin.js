import { $, el, client, storage, message, bytes } from "./api.js";
import { gallery } from "./gallery.js";

const store = storage("sessionStorage");
let token = store.get("wedding-admin") || "";
const api = client(() => token);
const album = gallery(api, {
  admin: true,
  filters: () =>
    `&guestId=${encodeURIComponent($("#guest-filter").value)}&kind=${encodeURIComponent($("#kind-filter").value)}`,
});
function saveToken(value) {
  token = value;
  store.set("wedding-admin", value);
}
async function guests() {
  const data = await api("/api/admin/wedding");
  const filter = $("#guest-filter"),
    selection = filter.value;
  filter.replaceChildren(new Option("全部宾客", ""));
  const rows = data.guests.map((g) => {
    const name = g.displayName || `宾客 ${g.guestId}`;
    filter.add(new Option(name, g.guestId));
    const row = el("div", undefined, "guest-row"),
      info = el("div");
    info.append(
      el("strong", name),
      el(
        "div",
        `${g.uploadCount} 份文件 · ${bytes(g.bytesUploaded)}`,
        "helper",
      ),
      el("div", `目录：${g.folderId}`, "helper"),
    );
    const button = el(
      "button",
      g.banned ? "解除限制" : "限制上传",
      "secondary",
    );
    button.onclick = async () => {
      if (!confirm(`${g.banned ? "解除" : "限制"}这位宾客的访问权限？`)) return;
      try {
        await api(`/api/admin/guests/${g.guestId}`, {
          method: "PATCH",
          body: { banned: !g.banned },
        });
        await guests();
      } catch (error) {
        message(error.message, true);
      }
    };
    row.append(info, button);
    return row;
  });
  $("#guests").replaceChildren(
    ...(rows.length ? rows : [el("p", "尚无宾客进入。", "helper")]),
  );
  filter.value = selection;
  return data;
}
async function load() {
  try {
    const { admin } = await api("/api/admin/me");
    $("#login-panel").hidden = true;
    $("#password-panel").hidden = !admin.mustChangePassword;
    $("#admin-content").hidden = Boolean(admin.mustChangePassword);
    if (admin.mustChangePassword) return;
    const { event } = await guests();
    $("#title").value = event.title;
    $("#couple").value = event.coupleNames || "";
    $("#date").value = event.eventDate || "";
    $("#venue").value = event.venue || "";
    $("#welcome").value = event.welcomeText || "";
    $("#upload-enabled").checked =
      event.uploadEnabled && event.status === "active";
    const qr = await api("/api/admin/qr");
    $("#qr").src = qr.image;
    $("#qr-download").href = qr.image;
    $("#site-url").textContent = qr.url;
    $("#site-url").href = qr.url;
    await album.load(true);
  } catch (error) {
    message(error.message, true);
    if (error.status === 401) {
      $("#login-panel").hidden = false;
      $("#admin-content").hidden = true;
      $("#password-panel").hidden = true;
    }
  }
}
$("#login").onsubmit = async (e) => {
  e.preventDefault();
  const button = $("button", e.target);
  button.disabled = true;
  try {
    const data = await api("/api/admin/login", {
      method: "POST",
      body: { username: $("#username").value, password: $("#password").value },
    });
    saveToken(data.token);
    $("#password").value = "";
    message("");
    await load();
  } catch (error) {
    message(error.message, true);
  } finally {
    button.disabled = false;
  }
};
$("#settings").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api("/api/admin/wedding", {
      method: "PATCH",
      body: {
        title: $("#title").value,
        coupleNames: $("#couple").value,
        eventDate: $("#date").value,
        venue: $("#venue").value,
        welcomeText: $("#welcome").value,
        uploadEnabled: $("#upload-enabled").checked,
        status: "active",
      },
    });
    message("婚礼信息已保存。");
  } catch (error) {
    message(error.message, true);
  }
};
$("#change-password").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const data = await api("/api/admin/password", {
      method: "POST",
      body: {
        currentPassword: $("#current-password").value,
        newPassword: $("#new-password").value,
      },
    });
    saveToken(data.token);
    e.target.reset();
    message("密码已修改，旧管理会话已失效。");
    await load();
  } catch (error) {
    message(error.message, true);
  }
};
$("#change-password-button").onclick = () => {
  $("#password-panel").hidden = false;
  $("#current-password").focus();
};
$("#logout").onclick = () => {
  store.remove("wedding-admin");
  location.reload();
};
$("#guest-filter").onchange = $("#kind-filter").onchange = () =>
  album.load(true);
$("#refresh").onclick = async () => {
  try {
    await guests();
    await album.load(true);
  } catch (error) {
    message(error.message, true);
  }
};
if (token) load();
