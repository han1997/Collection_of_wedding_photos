import "./_setup.js";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import config from "../src/config.js";
import { openDb, closeDb, run, get, all } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { initializeSite, currentEvent } from "../src/repositories/site.repo.js";
import { ensureDataDirs, toAbs } from "../src/services/storage.js";

ensureDataDirs();
openDb({ file: config.paths.dbFile });
after(closeDb);

test("旧库升级保留宾客 ID、媒体路径、文件和外键关系", () => {
  const oldDir = path.join(config.dataRoot, "old-migrations");
  fs.mkdirSync(oldDir);
  fs.copyFileSync(
    path.join(config.paths.migrations, "001_init.sql"),
    path.join(oldDir, "001_init.sql"),
  );
  migrate({ dir: oldDir, log() {} });
  const now = new Date().toISOString();
  run(
    "INSERT INTO events (id, title, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ["legacy", "旧婚礼", "legacy", now, now],
  );
  run(
    "INSERT INTO guests (id, openid, first_seen_at, last_seen_at) VALUES (42, ?, ?, ?)",
    ["historical-identity", now, now],
  );
  run(
    "INSERT INTO event_guests (event_id, guest_id, first_join_at, last_active_at) VALUES (?, 42, ?, ?)",
    ["legacy", now, now],
  );
  const rel = "events/legacy/originals/old.jpg";
  fs.mkdirSync(path.dirname(toAbs(rel)), { recursive: true });
  fs.writeFileSync(toAbs(rel), "legacy-bytes");
  run(
    `INSERT INTO media (id, event_id, guest_id, kind, ext, mime, bytes, rel_path, status, created_at, updated_at)
    VALUES ('old-media', 'legacy', 42, 'image', 'jpg', 'image/jpeg', 12, ?, 'ready', ?, ?)`,
    [rel, now, now],
  );
  migrate({ log() {} });
  assert.equal(
    get("SELECT id FROM guests WHERE legacy_identity = ?", [
      "historical-identity",
    ]).id,
    42,
  );
  assert.ok(get("SELECT folder_id FROM guests WHERE id = 42").folder_id);
  assert.equal(
    get("SELECT rel_path FROM media WHERE id = ?", ["old-media"]).rel_path,
    rel,
  );
  assert.equal(fs.readFileSync(toAbs(rel), "utf8"), "legacy-bytes");
  assert.deepEqual(all("PRAGMA foreign_key_check"), []);
  initializeSite();
  assert.equal(currentEvent().id, "legacy");
  assert.deepEqual(migrate({ log() {} }).applied, []);
});
test("旧库多场婚礼不会被自动选择或清除", () => {
  run("DELETE FROM site");
  const now = new Date().toISOString();
  run(
    "INSERT INTO events (id, title, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ["second", "另一场", "second", now, now],
  );
  assert.throws(() => initializeSite(), /EVENT_ID/);
  assert.equal(get("SELECT COUNT(*) AS n FROM events").n, 2);
  assert.equal(get("SELECT COUNT(*) AS n FROM media").n, 1);
  config.eventId = "legacy";
  initializeSite();
  config.eventId = "";
  assert.equal(currentEvent().id, "legacy");
});
