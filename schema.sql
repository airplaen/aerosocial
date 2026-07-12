-- AeroSocial database schema (SQLite)
-- Run with: npm run migrate

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  callsign      TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  home_base     TEXT,
  bio           TEXT,
  hue           INTEGER DEFAULT 200,
  avatar_path   TEXT,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS posts (
  id          TEXT PRIMARY KEY,
  author_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text', 'flight')),
  text        TEXT,
  flight      TEXT, -- JSON-encoded flight log (JSON.stringify/parse in app code)
  image_path  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

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

CREATE INDEX IF NOT EXISTS idx_posts_created ON posts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments (post_id);
CREATE INDEX IF NOT EXISTS idx_likes_post ON likes (post_id);
