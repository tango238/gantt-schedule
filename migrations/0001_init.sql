-- Schedule 初期スキーマ。時刻はすべて UNIX エポックのミリ秒 (INTEGER)。
-- メールアドレスは常に小文字で保存する。

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  name          TEXT NOT NULL,
  picture       TEXT,
  -- 直近ログイン時に検証した Google の hd クレーム (無ければ NULL)。セッション再判定で使う。
  hd            TEXT,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL
);

-- id はセッショントークン (乱数 32 バイト) の SHA-256 (hex)。トークン本体は保存しない。
CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

-- ALLOWED_DOMAINS 以外で許可する例外アドレス (管理画面で編集)。
CREATE TABLE allowed_emails (
  email      TEXT PRIMARY KEY CHECK (email = lower(email)),
  added_by   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- doc は元の JSON スキーマ version 1 のドキュメント (view は含まない)。上限 1MB はアプリ側で検査。
-- deleted_at / deleted_by は論理削除 (NULL = 有効)。
CREATE TABLE schedules (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  doc        TEXT NOT NULL,
  rev        INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  deleted_by TEXT REFERENCES users(id)
);
CREATE INDEX idx_schedules_deleted_updated ON schedules(deleted_at, updated_at DESC);

CREATE TABLE schedule_versions (
  id          TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('manual', 'auto')),
  doc         TEXT NOT NULL,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  -- バージョンを作った時点のスケジュールの rev (表示・調査用。古い行は NULL)。
  rev         INTEGER
);
CREATE INDEX idx_versions_schedule_created ON schedule_versions(schedule_id, created_at DESC);
CREATE INDEX idx_versions_schedule_kind ON schedule_versions(schedule_id, kind, created_at DESC);

-- タスクのコメント。スケジュール本体の JSON (schedules.doc) には入れず、別の表に持つ。
-- task_id は doc.tasks[].id (小文字の UUID)。タスクが削除されても行は消さない (同じ ID のタスクが
-- 復元されれば再び見える)。スケジュールを物理削除する場合だけ一緒に消える (論理削除では消えない)。
-- updated_at が NULL = 未編集。コメントの編集・削除は書いた本人だけ (アプリ側で検査)。
CREATE TABLE task_comments (
  id          TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  task_id     TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id),
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER
);
CREATE INDEX idx_task_comments_schedule_task ON task_comments(schedule_id, task_id, created_at);

-- ユーザーごとのお気に入り (一覧で上に固定する)。スケジュール本体の JSON (schedules.doc) には入れない。
-- スケジュールが論理削除されても行は消さない (復元すれば再び固定される。一覧には削除中は出ない)。
-- スケジュールを物理削除する場合だけ一緒に消える。
CREATE TABLE schedule_favorites (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, schedule_id)
);
