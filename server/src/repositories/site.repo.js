import { randomBytes, createHash } from "node:crypto";
import { all, get, run, tx } from "../db/index.js";
import config from "../config.js";
import * as events from "./events.repo.js";
import * as memberships from "./eventGuests.repo.js";
import { unauthorized } from "../lib/errors.js";

const randomId = () => randomBytes(24).toString("base64url");
const digest = (token) => createHash("sha256").update(token).digest("hex");

export function currentEvent() {
  const row = get("SELECT event_id FROM site WHERE id = 1");
  const event = row && events.findById(row.event_id);
  if (!event) throw new Error("单场婚礼尚未初始化");
  return event;
}

export function initializeSite() {
  return tx(() => {
    const existing = get("SELECT * FROM site WHERE id = 1");
    if (existing) {
      if (config.eventId && config.eventId !== existing.event_id)
        throw new Error("EVENT_ID 与已有站点不符，请使用独立数据目录");
      return currentEvent();
    }
    const candidates = all("SELECT id FROM events WHERE deleted_at IS NULL");
    let event;
    if (config.eventId) {
      event = events.findById(config.eventId);
      if (!event) throw new Error("EVENT_ID 对应的婚礼不存在");
    } else if (candidates.length > 1) {
      throw new Error(
        "旧数据库包含多场婚礼，请通过 EVENT_ID 明确选择，原数据不会删除",
      );
    } else {
      event = candidates.length
        ? events.findById(candidates[0].id)
        : events.create({
            title: "我们的婚礼",
            welcomeText: "谢谢你，留下今天的美好瞬间。",
          });
    }
    run("INSERT INTO site (id, event_id, instance_id) VALUES (1, ?, ?)", [
      event.id,
      randomId(),
    ]);
    return event;
  });
}

export function instanceId() {
  return get("SELECT instance_id FROM site WHERE id = 1").instance_id;
}

export function createSession(displayName) {
  const event = currentEvent();
  const token = randomBytes(32).toString("base64url");
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 180 * 86400000).toISOString();
  return tx(() => {
    const folder = randomId();
    const result = run(
      "INSERT INTO guests (legacy_identity, folder_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)",
      [randomId(), folder, now, now],
    );
    const id = Number(result.lastInsertRowid);
    memberships.ensure(event.id, id, displayName);
    run(
      "INSERT INTO guest_sessions (token_hash, event_id, guest_id, expires_at) VALUES (?, ?, ?, ?)",
      [digest(token), event.id, id, expiresAt],
    );
    return { token, expiresAt, guest: { id, folderId: folder } };
  });
}

export function verifySession(token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token))
    throw unauthorized("会话无效，请重新进入");
  const event = currentEvent();
  const row = get(
    `SELECT g.id, g.folder_id, g.banned FROM guest_sessions s
    JOIN guests g ON g.id = s.guest_id
    WHERE s.token_hash = ? AND s.event_id = ? AND s.expires_at > ? AND s.revoked = 0`,
    [digest(token), event.id, new Date().toISOString()],
  );
  if (!row || row.banned)
    throw unauthorized("会话已失效或被限制，请联系主办者");
  return { id: row.id, folderId: row.folder_id, eventId: event.id };
}

export function revokeSession(token) {
  run(
    "UPDATE guest_sessions SET revoked = 1 WHERE token_hash = ? AND event_id = ?",
    [digest(token), currentEvent().id],
  );
}
