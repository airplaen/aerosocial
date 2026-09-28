-- AeroSocial database schema (SQLite)
-- Run with: npm run migrate

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  callsign      TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  home_base     TEXT,
  bio           TEXT,
  favorite_anime TEXT,
  hue           INTEGER DEFAULT 200,
  avatar_path   TEXT,
  password_hash TEXT NOT NULL,
  google_id     TEXT UNIQUE,
  fsa_auto_post INTEGER NOT NULL DEFAULT 1,
  warning_area_code TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS posts (
  id          TEXT PRIMARY KEY,
  author_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text', 'flight')),
  text        TEXT,
  flight      TEXT,
  image_path  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS post_images (
  id         TEXT PRIMARY KEY,
  post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_post_images_post ON post_images (post_id, position);

-- Poll feature (投票機能). A poll is optionally attached to any post (one
-- per post, regardless of the post's `type`) rather than being its own
-- `posts.type` value — that would require rebuilding the `posts` table to
-- widen its `type` CHECK constraint, which SQLite can't do with a plain
-- ALTER TABLE. `polls.post_id` being the primary key enforces "at most one
-- poll per post". Options are a separate table (2-6 per poll, enforced in
-- routes/posts.js) so each can be voted on independently.
CREATE TABLE IF NOT EXISTS polls (
  post_id    TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS poll_options (
  id         TEXT PRIMARY KEY,
  post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_poll_options_post ON poll_options (post_id, position);

-- One vote per user per poll (PRIMARY KEY on post_id+user_id) — voting for
-- a different option overwrites the row (see POST /:id/vote), voting for
-- the same option again clears it (un-vote).
CREATE TABLE IF NOT EXISTS poll_votes (
  post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  option_id  TEXT NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (post_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_poll_votes_post ON poll_votes (post_id);
CREATE INDEX IF NOT EXISTS idx_poll_votes_option ON poll_votes (option_id);

CREATE TABLE IF NOT EXISTS likes (
  post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id         TEXT PRIMARY KEY,
  post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS follows (
  follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id != followee_id)
);

-- Single-row settings table (id is always 1) holding whatever ad network
-- embed code (Google AdSense / AdMax / etc.) the admin pastes into the
-- admin panel's 広告 tab, whether that slot is turned on, and how many
-- posts appear between ad insertions in the feed. See routes/admin.js
-- (management) and routes/ads.js (public read used by the feed).
CREATE TABLE IF NOT EXISTS ad_settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  enabled    INTEGER NOT NULL DEFAULT 0,
  code       TEXT NOT NULL DEFAULT '',
  frequency  INTEGER NOT NULL DEFAULT 5,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT OR IGNORE INTO ad_settings (id) VALUES (1);

CREATE INDEX IF NOT EXISTS idx_posts_created ON posts (created_at DESC);
-- ログブック/実績/ランキング(flightStats.js, achievements.js,
-- routes/logbook.js)が author_id + type='flight' で頻繁に絞り込むため。
CREATE INDEX IF NOT EXISTS idx_posts_author_type ON posts (author_id, type);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments (post_id);
CREATE INDEX IF NOT EXISTS idx_likes_post ON likes (post_id);
CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows (follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows (followee_id);

-- Events (イベント機能). A single table covers both "みんなで飛ぶ集合フライト"
-- (event_type = 'flight', using departure/arrival ICAO) and general-purpose
-- events like オフ会/配信 (event_type = 'general', using the free-text
-- `location` field instead). Any user may create an event; `capacity` is
-- optional (NULL = 無制限) and set per-event by its creator, same for
-- `notify_discord` (per-event opt-in to a Discord announcement, reusing the
-- existing bot/channel config in services/discordNotify.js).
CREATE TABLE IF NOT EXISTS events (
  id             TEXT PRIMARY KEY,
  creator_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type     TEXT NOT NULL DEFAULT 'general' CHECK (event_type IN ('flight', 'general')),
  title          TEXT NOT NULL,
  description    TEXT,
  starts_at      TEXT NOT NULL,
  ends_at        TEXT,
  location       TEXT,
  departure_icao TEXT,
  arrival_icao   TEXT,
  capacity       INTEGER,
  notify_discord INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Who's going. PRIMARY KEY on (event_id, user_id) enforces "at most one
-- join per user per event", same pattern as `likes`/`poll_votes` above.
CREATE TABLE IF NOT EXISTS event_participants (
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_events_starts_at ON events (starts_at);
CREATE INDEX IF NOT EXISTS idx_event_participants_event ON event_participants (event_id);
CREATE INDEX IF NOT EXISTS idx_event_participants_user ON event_participants (user_id);

-- 好きなアニメ紹介画像 (GET /api/anime-image, Jikan APIの結果) のキャッシュ。
-- Jikan自体がMyAnimeList側への接続に失敗して504を返すことがあるため、一度
-- 取得できた画像URLは検索キーワード単位で保存しておき、以降はJikanを叩かず
-- 即返す。失敗した結果はキャッシュしない(次回また取得を試みられるように
-- するため) — see src/routes/animeImage.js.
CREATE TABLE IF NOT EXISTS anime_image_cache (
  query_key     TEXT PRIMARY KEY,
  image         TEXT NOT NULL,
  source_page   TEXT,
  matched_title TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 日本語ニュースパネル (人気のフライトパネル下部)。APITube News APIを
-- ポーリングして得た記事のキャッシュ兼配信元。id はAPITube側のid、無ければ
-- 記事URLをそのまま使う (INSERT OR IGNOREでの重複防止キー) —
-- see src/services/newsFeed.js.
-- 手書き対応メモ(ニーボード)機能。VATSIMでのフライト中に使うことを想定し、
-- テキストメモと手描きスケッチ(iPad Pencil等のポインタイベント経由で
-- フロントが書き出すPNGのdata URL)を1件のメモに両方持てるようにしている。
-- SimBriefから取得したフライト情報を本文に挿入するショートカットは
-- フロント側(既存のGET /api/simbrief/:usernameを再利用)で提供する。
-- see src/routes/memos.js.
CREATE TABLE IF NOT EXISTS memos (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL DEFAULT '無題のメモ',
  text_content TEXT NOT NULL DEFAULT '',
  drawing_data TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_memos_user_updated ON memos (user_id, updated_at DESC);

-- 運営からのメッセージ(管理者パネルからの一斉配信お知らせ)。既読管理は
-- 持たない — 送信時にWebSocket(announcement:new)とWeb Pushで即時配信
-- される一過性の速報で、この表はその送信履歴(管理者パネル表示用)。
-- see src/routes/admin.js.
CREATE TABLE IF NOT EXISTS announcements (
  id         TEXT PRIMARY KEY,
  author_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_announcements_created ON announcements (created_at DESC);

CREATE TABLE IF NOT EXISTS news_items (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  summary      TEXT,
  link         TEXT NOT NULL,
  source       TEXT,
  category     TEXT,
  image_url    TEXT,
  is_breaking  INTEGER NOT NULL DEFAULT 0,
  published_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_news_items_published ON news_items (published_at DESC);
