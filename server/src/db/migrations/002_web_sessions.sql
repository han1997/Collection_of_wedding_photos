-- 保留旧宾客主键与外键；历史身份字段不再承担登录职责。
ALTER TABLE guests RENAME COLUMN openid TO legacy_identity;
ALTER TABLE guests RENAME COLUMN unionid TO legacy_union;
ALTER TABLE guests ADD COLUMN folder_id TEXT;
UPDATE guests SET folder_id = lower(hex(randomblob(16)));
CREATE UNIQUE INDEX idx_guests_folder ON guests(folder_id);
CREATE TABLE site (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  event_id TEXT NOT NULL REFERENCES events(id),
  instance_id TEXT NOT NULL UNIQUE
);
CREATE TABLE guest_sessions (
  token_hash TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  guest_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (event_id, guest_id) REFERENCES event_guests(event_id, guest_id)
);
CREATE INDEX idx_guest_sessions_owner ON guest_sessions(event_id, guest_id);
