const path = require('path');
const { Database } = require('node-sqlite3-wasm'); // WebAssembly版SQLite。ネイティブビルド不要・Nodeのバージョンを問わず動作

const dbPath = path.join(__dirname, '..', 'data.sqlite');
const raw = new Database(dbPath);

raw.exec('PRAGMA journal_mode = WAL;');

raw.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    google_id TEXT UNIQUE NOT NULL,
    email TEXT,
    name TEXT,
    avatar_url TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,               -- YouTubeのチャンネルID (UC...)
    handle TEXT,
    title TEXT,
    avatar_url TEXT,
    uploads_playlist_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_channels (
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    added_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, channel_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS channel_status (
    channel_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'offline',   -- 'live' | 'upcoming' | 'offline'
    video_id TEXT,
    video_title TEXT,
    video_description TEXT,
    thumbnail_url TEXT,
    scheduled_start TEXT,
    actual_start TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expires INTEGER
  );

  -- 配信していない時間帯に流す「過去配信」の候補キャッシュ
  CREATE TABLE IF NOT EXISTS channel_recent_uploads (
    channel_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    title TEXT,
    description TEXT,
    thumbnail_url TEXT,
    duration_seconds INTEGER,
    published_at TEXT,
    fetched_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (channel_id, video_id),
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
  );
`);

// 既存の data.sqlite (video_description / description 列が無いバージョン)を
// そのまま使い続けられるよう、無ければ列を追加するだけの簡易マイグレーション。
// 既に列がある場合はエラーになるが、その場合は「追加不要」という意味なので握りつぶす。
function addColumnIfMissing(table, columnDef) {
  try {
    raw.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
    return true; // 追加できた = 今回のマイグレーションで新規に追加された列
  } catch {
    // 既に列が存在する場合はここに来る(無視してOK)
    return false;
  }
}
addColumnIfMissing('channel_status', 'video_description TEXT');
addColumnIfMissing('channel_recent_uploads', 'description TEXT');

// 管理者フラグ。既存DBに対しては列が無ければ追加するだけのマイグレーション。
const isAdminColumnNew = addColumnIfMissing('users', 'is_admin INTEGER NOT NULL DEFAULT 0');
if (isAdminColumnNew) {
  // is_admin列を初めて追加したタイミング(=初回セットアップ相当)でのみ、
  // 初期管理者として「しろくま」さんを自動的に管理者に設定する。
  try {
    const initialAdmin = raw.get(
      "SELECT id FROM users WHERE name = 'しろくま' ORDER BY created_at ASC LIMIT 1"
    );
    if (initialAdmin) {
      raw.run('UPDATE users SET is_admin = 1 WHERE id = ?', [initialAdmin.id]);
      console.log('初期管理者として「しろくま」さんを管理者に設定しました。');
    } else {
      console.warn(
        '初期管理者候補の「しろくま」さんがusersテーブルに見つかりませんでした。管理者は未設定です。'
      );
    }
  } catch (err) {
    console.error('初期管理者の設定に失敗しました:', err.message);
  }
}

// このアプリの他のファイルは better-sqlite3 と同じ「可変長引数」形式
// (例: db.prepare(sql).run(a, b, c)) で書かれているため、
// node-sqlite3-wasm が要求する「配列」形式との差を吸収する薄いラッパーを噛ませる。
const db = {
  exec: (sql) => raw.exec(sql),
  prepare(sql) {
    return {
      run: (...params) => raw.run(sql, params),
      get: (...params) => raw.get(sql, params),
      all: (...params) => raw.all(sql, params),
    };
  },
};

module.exports = db;
