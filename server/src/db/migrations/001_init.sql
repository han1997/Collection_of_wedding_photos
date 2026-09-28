-- ============================================================================
-- 001_init.sql —— 初始表结构
--
-- 约定：
--   · 时间戳一律 TEXT，ISO-8601 UTC 字符串（如 2026-09-28T12:00:00.000Z）。
--     按「天」分目录用 Asia/Shanghai 现算（见 lib/time.js），不依赖进程 TZ。
--   · 布尔值一律 INTEGER 0/1。
--   · 所有 relative path 一律 POSIX 风格（'/'），由 lib/storage.js 保证。
--   · 核心不变式：**宾客侧的任何查询都必须同时带 event_id 和 guest_id**。
--     这一条就是「宾客只能看到自己上传的内容」的全部实现。
--
-- ⚠️ 此文件一经发布不可修改，只能新增 002_xxx.sql。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 管理员
-- ---------------------------------------------------------------------------
CREATE TABLE admins (
  id                   INTEGER PRIMARY KEY,
  username             TEXT    NOT NULL UNIQUE,
  password_hash        TEXT    NOT NULL,          -- scrypt$N$r$p$saltB64$keyB64
  display_name         TEXT,
  -- 一变就作废该管理员所有已签发的会话
  token_version        INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  last_login_at        TEXT,
  created_at           TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- 活动（每场婚礼一个）
-- ---------------------------------------------------------------------------
CREATE TABLE events (
  id              TEXT    PRIMARY KEY,            -- nanoid 10 位 [A-Za-z0-9]，同时用作 wxacode 的 scene
  title           TEXT    NOT NULL,               -- 例：张伟 & 李娜 婚礼
  couple_names    TEXT,
  event_date      TEXT,                           -- 'YYYY-MM-DD'
  venue           TEXT,
  welcome_text    TEXT,
  slug            TEXT    NOT NULL,               -- 例：2026-05-20-zhangwei-lina，做目录名

  qr_path         TEXT,                           -- 相对 DATA_ROOT 的 POSIX 路径
  qr_env_version  TEXT,                           -- release | trial | develop
  qr_generated_at TEXT,
  qr_mode         TEXT CHECK (qr_mode IN ('wxa', 'fallback', 'custom')),

  upload_enabled  INTEGER NOT NULL DEFAULT 1,
  status          TEXT    NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'closed', 'archived')),

  created_by      INTEGER REFERENCES admins(id),
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  deleted_at      TEXT
);
CREATE INDEX idx_events_status_date ON events(status, event_date DESC);
CREATE UNIQUE INDEX idx_events_slug ON events(slug) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 宾客（全局，一个人一行）
--
-- ⚠️ openid 是「相对该小程序」唯一的：同一位宾客参加两场婚礼，openid 相同。
--    所以宾客表必须是全局的，「谁参加过哪场」走 event_guests 关联，
--    绝不能拿 openid 直接当某场活动的过滤条件。
--
-- 我们只存 openid。session_key 拿到就丢——本服务不解密任何东西，
-- 留着它纯属负担。也正因为不收集昵称/头像/手机号/位置，隐私声明项才能压到最少。
-- ---------------------------------------------------------------------------
CREATE TABLE guests (
  id            INTEGER PRIMARY KEY,
  openid        TEXT    NOT NULL UNIQUE,
  unionid       TEXT,
  banned        INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT    NOT NULL,
  last_seen_at  TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- 活动 × 宾客（参与关系 + 每场活动的计数）
-- ---------------------------------------------------------------------------
CREATE TABLE event_guests (
  event_id      TEXT    NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  guest_id      INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  display_name  TEXT,                              -- 可选的「怎么称呼您」
  first_join_at TEXT    NOT NULL,
  last_active_at TEXT   NOT NULL,
  upload_count  INTEGER NOT NULL DEFAULT 0,
  bytes_uploaded INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, guest_id)
);
CREATE INDEX idx_event_guests_guest ON event_guests(guest_id);

-- ---------------------------------------------------------------------------
-- 媒体
-- ---------------------------------------------------------------------------
CREATE TABLE media (
  id            TEXT    PRIMARY KEY,               -- nanoid 16
  event_id      TEXT    NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  guest_id      INTEGER NOT NULL REFERENCES guests(id),

  kind          TEXT    NOT NULL CHECK (kind IN ('image', 'video')),
  ext           TEXT    NOT NULL,                  -- 小写、无点：jpg / png / heic / mp4 / mov …
  mime          TEXT    NOT NULL,                  -- 落库时由白名单定型，响应时也只信这个
  bytes         INTEGER NOT NULL,

  width         INTEGER,
  height        INTEGER,
  duration_ms   INTEGER,
  sha256        TEXT,                              -- 仅当客户端提供了才存

  rel_path      TEXT    NOT NULL,                  -- 原文件，相对 DATA_ROOT
  preview_path  TEXT,                              -- 长边 1600（供预览）
  thumb_path    TEXT,                              -- 长边 480（供网格）
  poster_path   TEXT,                              -- 视频封面帧

  status        TEXT    NOT NULL DEFAULT 'processing'
                        CHECK (status IN ('processing', 'ready', 'failed', 'blocked', 'deleted')),
  fail_reason   TEXT,
  needs_transcode INTEGER NOT NULL DEFAULT 0,      -- HEVC / .mov，安卓微信可能黑屏
  playable_path TEXT,                              -- 仅当真的转过码

  sec_status    TEXT    NOT NULL DEFAULT 'pending'
                        CHECK (sec_status IN ('pending', 'pass', 'risky', 'error', 'skipped')),
  sec_label     INTEGER,
  sec_checked_at TEXT,

  client_taken_at TEXT,
  device_info   TEXT,
  exif_json     TEXT,
  source_ip     TEXT,

  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  deleted_at    TEXT
);

-- 「我上传的」主查询路径
CREATE INDEX idx_media_owner ON media(event_id, guest_id, created_at DESC);
-- 管理端按活动翻全部
CREATE INDEX idx_media_admin ON media(event_id, status, created_at DESC);
-- 同活动同人的查重
CREATE INDEX idx_media_sha ON media(event_id, guest_id, sha256) WHERE sha256 IS NOT NULL;
-- 启动时恢复未处理完的任务
CREATE INDEX idx_media_status ON media(status) WHERE status = 'processing';

-- ---------------------------------------------------------------------------
-- 分片上传会话
--
-- tmp_dir 存绝对路径。⚠️ 它必须与 events/ 在同一个文件系统上——
-- 合并完成后靠 fs.rename 落盘，跨设备 rename 会退化成整文件拷贝。
-- ---------------------------------------------------------------------------
CREATE TABLE upload_sessions (
  id               TEXT    PRIMARY KEY,             -- nanoid 21
  event_id         TEXT    NOT NULL REFERENCES events(id),
  guest_id         INTEGER NOT NULL REFERENCES guests(id),

  kind             TEXT    NOT NULL CHECK (kind IN ('image', 'video')),
  mime             TEXT    NOT NULL,
  ext              TEXT    NOT NULL,
  declared_name    TEXT,
  declared_bytes   INTEGER NOT NULL,
  declared_sha256  TEXT,

  chunk_size       INTEGER NOT NULL,
  total_parts      INTEGER NOT NULL,
  tmp_dir          TEXT    NOT NULL,

  status           TEXT    NOT NULL DEFAULT 'open'
                           CHECK (status IN ('open', 'assembling', 'completed', 'expired', 'failed')),
  media_id         TEXT,

  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL,
  expires_at       TEXT    NOT NULL
);
CREATE INDEX idx_upload_sessions_gc ON upload_sessions(status, expires_at);
CREATE INDEX idx_upload_sessions_owner ON upload_sessions(event_id, guest_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 已收到的分片。续传的唯一真相来源（客户端只缓存 sessionId 做提示）。
-- ---------------------------------------------------------------------------
CREATE TABLE upload_parts (
  session_id  TEXT    NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
  part_no     INTEGER NOT NULL,                     -- 从 1 开始
  bytes       INTEGER NOT NULL,
  received_at TEXT    NOT NULL,
  PRIMARY KEY (session_id, part_no)
);

-- ---------------------------------------------------------------------------
-- 举报（合规必备：带上传功能的应用，审核会找这个入口）
-- ---------------------------------------------------------------------------
CREATE TABLE reports (
  id                 INTEGER PRIMARY KEY,
  media_id           TEXT    NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  reporter_guest_id  INTEGER REFERENCES guests(id),
  reason             TEXT,
  detail             TEXT,
  status             TEXT    NOT NULL DEFAULT 'open'
                             CHECK (status IN ('open', 'handled', 'dismissed')),
  created_at         TEXT    NOT NULL
);
CREATE INDEX idx_reports_status ON reports(status, created_at DESC);

-- ---------------------------------------------------------------------------
-- 内容安全检测留证。命中 risky 时不删文件，保留证据。
-- ---------------------------------------------------------------------------
CREATE TABLE content_checks (
  id         INTEGER PRIMARY KEY,
  media_id   TEXT    NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  provider   TEXT    NOT NULL,                      -- img_sec_check | msgSecCheck | media_check_async
  result     TEXT    NOT NULL,                      -- pass | risky | error | skipped
  label      INTEGER,
  detail     TEXT,
  checked_at TEXT    NOT NULL
);
CREATE INDEX idx_content_checks_media ON content_checks(media_id);

-- ---------------------------------------------------------------------------
-- 键值缓存：access_token、开关等
-- ---------------------------------------------------------------------------
CREATE TABLE kv (
  k          TEXT PRIMARY KEY,
  v          TEXT NOT NULL,
  expires_at TEXT,
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- 审计日志
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY,
  actor_type  TEXT NOT NULL,                        -- guest | admin | system
  actor_id    TEXT,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  ip          TEXT,
  ua          TEXT,
  detail_json TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_audit_created ON audit_log(created_at DESC);
CREATE INDEX idx_audit_target ON audit_log(target_type, target_id);
