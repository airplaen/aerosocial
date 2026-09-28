require("dotenv").config();
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

function main() {
  const dbPath = process.env.SQLITE_PATH || path.join(__dirname, "..", "aerosocial.db");
  const sql = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");

  console.log(`Applying schema.sql to ${dbPath} ...`);
  const db = new Database(dbPath);

  // schema.sql's final statement (the post_images index) can fail on a DB
  // where post_images already existed in an older/different shape — e.g.
  // without the image_path/position columns this schema expects. If that
  // happens mid-exec, everything before the failing statement has already
  // been applied (CREATE TABLE/INDEX IF NOT EXISTS run sequentially), so
  // it's safe to log and continue rather than abort the whole migration —
  // the ALTERs below repair post_images, and the index is re-created
  // afterward once the columns it depends on actually exist.
  try {
    db.exec(sql);
  } catch (err) {
    console.warn(`schema.sql hit an issue (continuing to repair): ${err.message}`);
  }

  // For databases created before avatar support existed: CREATE TABLE IF
  // NOT EXISTS above won't add a column to an already-existing table, so
  // add it here and ignore the error if it's already present.
  try {
    db.exec("ALTER TABLE users ADD COLUMN avatar_path TEXT");
    console.log("Added avatar_path column to users.");
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }

  // Same idea for post_images: repair a table that existed before this
  // schema.sql's current shape was introduced. No-ops (safely ignored) if
  // the columns are already there.
  for (const stmt of [
    "ALTER TABLE post_images ADD COLUMN image_path TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE post_images ADD COLUMN position INTEGER NOT NULL DEFAULT 0",
  ]) {
    try {
      db.exec(stmt);
      console.log(`Applied: ${stmt}`);
    } catch (err) {
      if (!/duplicate column/i.test(err.message)) throw err;
    }
  }

  // Re-create the post_images index now that the columns it depends on are
  // guaranteed to exist (harmless no-op if schema.sql already created it).
  db.exec("CREATE INDEX IF NOT EXISTS idx_post_images_post ON post_images (post_id, position)");

  // For databases created before Google login existed: same pattern as
  // avatar_path above.
  try {
    db.exec("ALTER TABLE users ADD COLUMN google_id TEXT");
    console.log("Added google_id column to users.");
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users (google_id) WHERE google_id IS NOT NULL");

  // For databases created before the follow feature existed: schema.sql's
  // CREATE TABLE IF NOT EXISTS above only takes effect if db.exec(sql) made
  // it that far without aborting (see the post_images comment above) — so
  // create the follows table again here explicitly, guaranteeing it exists
  // regardless of whether that first exec succeeded, failed, or partially
  // completed. Harmless no-op if schema.sql already created it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS follows (
      follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      followee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (follower_id, followee_id),
      CHECK (follower_id != followee_id)
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows (follower_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows (followee_id)");
  console.log("Ensured follows table exists.");

  // For databases created before push notifications existed: same pattern
  // as avatar_path/google_id above. Controls which new posts a user is
  // pushed a notification for — 'all' (everyone's posts) or 'following'
  // (only people they follow). Follow notifications aren't gated by this
  // column; they're sent to anyone with an active subscription.
  try {
    db.exec("ALTER TABLE users ADD COLUMN notify_pref TEXT NOT NULL DEFAULT 'all'");
    console.log("Added notify_pref column to users.");
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }

  // One row per browser/device push subscription — a user may have several
  // (phone, laptop, ...), each notified independently. Harmless no-op if
  // schema.sql already created it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id         TEXT NOT NULL PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint   TEXT NOT NULL UNIQUE,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions (user_id)");
  console.log("Ensured push_subscriptions table exists.");

  // --- Admin panel support -------------------------------------------
  // For databases created before the admin panel existed: same
  // add-column-if-missing pattern as avatar_path/google_id/notify_pref
  // above. is_admin gates access to every /api/admin/* route (see
  // middleware/requireAdmin.js); is_banned is checked on every
  // authenticated request (see middleware/auth.js) so a ban takes effect
  // immediately rather than waiting for the user's token to expire.
  try {
    db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
    console.log("Added is_admin column to users.");
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }
  try {
    db.exec("ALTER TABLE users ADD COLUMN is_banned INTEGER NOT NULL DEFAULT 0");
    console.log("Added is_banned column to users.");
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }

  // --- FSA (Flight Stream Assistant) 連携: 自動投稿ON/OFF -------------
  // 「フライト開始」をFSA側でクリックした時にAeroSocialへ自動投稿する機能の
  // ユーザーごとのON/OFFフラグ。既定は1(ON)。scripts/fsa-to-aerosocial-bridge.js
  // がこの列を直接参照して、OFFのユーザーへの投稿をスキップする。
  try {
    db.exec("ALTER TABLE users ADD COLUMN fsa_auto_post INTEGER NOT NULL DEFAULT 1");
    console.log("Added fsa_auto_post column to users.");
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }

  // --- Ad slot support (admin-managed AdSense/AdMax embed code) -------
  // Single-row settings table (id is always 1) holding whatever ad
  // network snippet the admin pastes into the admin panel's 広告 tab,
  // whether that slot is turned on, and how many posts appear between ad
  // insertions in the feed. Same "explicit re-create after the try/catch
  // above" reasoning as the follows/push_subscriptions tables: guarantees
  // it exists regardless of whether the first db.exec(sql) aborted
  // partway through. Harmless no-op if schema.sql already created it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ad_settings (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      enabled    INTEGER NOT NULL DEFAULT 0,
      code       TEXT NOT NULL DEFAULT '',
      frequency  INTEGER NOT NULL DEFAULT 5,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  db.exec("INSERT OR IGNORE INTO ad_settings (id) VALUES (1)");
  console.log("Ensured ad_settings table exists.");

  // --- FSA連携: パイロットIDのユーザー紐付け ---------------------------
  // 誰でも自分のAeroSocialアカウントの設定画面からFSAパイロットIDを登録
  // できるようにするための列（従来は.envにFSA_PILOT_ID=1人分だけ書く方式
  // だったが、それを廃止してユーザーごとに設定できるようにする）。
  // 1つのpilot_idにつき紐付けられるAeroSocialアカウントは1つだけ
  // （google_id列と同じ、UNIQUE partial index パターン）。
  try {
    db.exec("ALTER TABLE users ADD COLUMN fsa_pilot_id TEXT");
    console.log("Added fsa_pilot_id column to users.");
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_fsa_pilot_id ON users (fsa_pilot_id) WHERE fsa_pilot_id IS NOT NULL"
  );
  console.log("Ensured fsa_pilot_id unique index exists.");

  // --- Poll support (投票機能) -----------------------------------------
  // Same "explicit re-create after the try/catch above" reasoning as the
  // follows/push_subscriptions/ad_settings tables: guarantees these exist
  // regardless of whether the first db.exec(sql) aborted partway through.
  // Harmless no-op if schema.sql already created them.
  db.exec(`
    CREATE TABLE IF NOT EXISTS polls (
      post_id    TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS poll_options (
      id       TEXT PRIMARY KEY,
      post_id  TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      text     TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_poll_options_post ON poll_options (post_id, position)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS poll_votes (
      post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      option_id  TEXT NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (post_id, user_id)
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_poll_votes_post ON poll_votes (post_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_poll_votes_option ON poll_votes (option_id)");
  console.log("Ensured polls/poll_options/poll_votes tables exist.");

  // --- Events support (イベント機能) -----------------------------------
  // Same "explicit re-create after the try/catch above" reasoning as the
  // other feature tables: guarantees these exist regardless of whether the
  // first db.exec(sql) aborted partway through. Harmless no-op if
  // schema.sql already created them.
  db.exec(`
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
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_participants (
      event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (event_id, user_id)
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_events_starts_at ON events (starts_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_event_participants_event ON event_participants (event_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_event_participants_user ON event_participants (user_id)");
  console.log("Ensured events/event_participants tables exist.");

  // --- 好きなアニメ (プロフィール表示欄) ---------------------------------
  // For databases created before this field existed: same
  // add-column-if-missing pattern as avatar_path/google_id above.
  try {
    db.exec("ALTER TABLE users ADD COLUMN favorite_anime TEXT");
    console.log("Added favorite_anime column to users.");
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }

  // --- 好きなアニメ紹介画像のキャッシュ (Jikan API) ----------------------
  // GET /api/anime-image はJikan(MyAnimeListの非公式API)を毎回叩いていたが、
  // Jikan自体がMAL側への接続に失敗して504を返すことがある(不安定な外部API)
  // ため、一度取得できた画像URLは検索キーワード単位でここに保存し、以降は
  // Jikanを叩かずキャッシュから即返せるようにする。失敗した結果はキャッシュ
  // しない(次回また取得を試みられるようにするため)。
  // Same "explicit re-create after the try/catch above" reasoning as the
  // other feature tables: harmless no-op if schema.sql already created it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS anime_image_cache (
      query_key     TEXT PRIMARY KEY,
      image         TEXT NOT NULL,
      source_page   TEXT,
      matched_title TEXT,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  console.log("Ensured anime_image_cache table exists.");

  // --- ニュースパネル (APITube News API) ------------------------------
  // Same "explicit re-create after the try/catch above" reasoning as the
  // other feature tables: guarantees this exists regardless of whether the
  // first db.exec(sql) aborted partway through. Harmless no-op if
  // schema.sql already created it. See src/services/newsFeed.js.
  db.exec(`
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
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_news_items_published ON news_items (published_at DESC)");
  console.log("Ensured news_items table exists.");

  // --- 気象警報・注意報 (地震情報パネル下部) --------------------------
  // ユーザーが選んだ地域(気象庁の府県予報区コード)。null = 未選択/機能
  // オフ。scripts/weather-warning-push-bridge.js がこの列を持つユーザー
  // だけを対象に、選んだ地域の警報・注意報が更新されていないか定期的に
  // チェックする。avatar_path/google_id/notify_pref と同じ
  // add-column-if-missing パターン。
  try {
    db.exec("ALTER TABLE users ADD COLUMN warning_area_code TEXT");
    console.log("Added warning_area_code column to users.");
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }

  // --- メモ(ニーボード)機能: 手書き+テキスト -----------------------
  // Same "explicit re-create after the try/catch above" reasoning as the
  // other feature tables: guarantees this exists regardless of whether the
  // first db.exec(sql) aborted partway through. Harmless no-op if
  // schema.sql already created it. See src/routes/memos.js.
  db.exec(`
    CREATE TABLE IF NOT EXISTS memos (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title        TEXT NOT NULL DEFAULT '無題のメモ',
      text_content TEXT NOT NULL DEFAULT '',
      drawing_data TEXT,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_memos_user_updated ON memos (user_id, updated_at DESC)");
  console.log("Ensured memos table exists.");

  // --- ログブック/実績/ランキング機能 ---------------------------------
  // 新しいテーブルは無い(posts.flightから都度集計 — src/flightStats.js,
  // src/achievements.js, src/routes/logbook.js参照)が、author_id+type
  // での絞り込みが増えるため専用インデックスだけ追加する。schema.sqlの
  // 実行が途中で止まっていても(他のALTER修復パターンと同じ理由)確実に
  // 作られるよう、ここでも明示的に再実行しておく。
  db.exec("CREATE INDEX IF NOT EXISTS idx_posts_author_type ON posts (author_id, type)");
  console.log("Ensured idx_posts_author_type index exists.");

  // --- 運営からのメッセージ(一斉配信お知らせ) -------------------------
  // Same "explicit re-create after the try/catch above" reasoning as the
  // other feature tables: guarantees this exists regardless of whether the
  // first db.exec(sql) aborted partway through. Harmless no-op if
  // schema.sql already created it. See src/routes/admin.js.
  db.exec(`
    CREATE TABLE IF NOT EXISTS announcements (
      id         TEXT PRIMARY KEY,
      author_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_announcements_created ON announcements (created_at DESC)");
  console.log("Ensured announcements table exists.");

  db.close();
  console.log("Done.");
}

main();
