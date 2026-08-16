const express = require("express");
const fs = require("fs");
const crypto = require("crypto");
const pool = require("../db");
const { requireAuth, optionalAuth } = require("../middleware/auth");
const upload = require("../middleware/upload");
const { broadcast } = require("../ws");
const push = require("../lib/push");
// Discord Bot通知。この下で定義しているプッシュ通知用の notifyNewPost と
// 名前が衝突するため、インポート時に notifyDiscordNewPost としてリネーム。
const { notifyNewPost: notifyDiscordNewPost } = require("../services/discordNotify");

const router = express.Router();

// Poll limits (投票機能): kept generous but bounded — the composer/vote UI
// on the client enforces the same numbers, this is the server-side backstop.
const POLL_MIN_OPTIONS = 2;
const POLL_MAX_OPTIONS = 6;
const POLL_MAX_OPTION_LEN = 60;

// Fetches poll + option + vote-count data for a batch of post ids in two
// queries total (not one query per post), and returns a Map keyed by
// post_id so serializePost can attach it synchronously below. `viewerId`
// (nullable) is used to mark which option, if any, the current viewer
// voted for.
async function loadPollsForPosts(postIds, viewerId) {
  const pollsByPost = new Map();
  if (!postIds.length) return pollsByPost;

  const placeholders = postIds.map((_, i) => `$${i + 1}`).join(", ");
  const optionsResult = await pool.query(
    `SELECT po.id, po.post_id, po.text, po.position,
            COALESCE(v.vote_count, 0) AS vote_count
     FROM poll_options po
     LEFT JOIN (SELECT option_id, COUNT(*) AS vote_count FROM poll_votes GROUP BY option_id) v
       ON v.option_id = po.id
     WHERE po.post_id IN (${placeholders})
     ORDER BY po.post_id, po.position ASC`,
    postIds
  );
  if (!optionsResult.rows.length) return pollsByPost;

  // viewerId may be null (logged-out visitor) — pool.query's `$N` params
  // are positional, so this only needs one extra placeholder appended.
  const myVotes = new Map();
  if (viewerId) {
    // db.js's $N -> "?" conversion binds purely by position in the SQL
    // text (its own comment: placeholders are "used sequentially and
    // never reused/reordered"), so $N must count up in the order the
    // placeholders appear here — the IN(...) list first, then viewerId —
    // matching the params array order below exactly.
    const votesResult = await pool.query(
      `SELECT post_id, option_id FROM poll_votes WHERE post_id IN (${placeholders}) AND user_id = $${postIds.length + 1}`,
      [...postIds, viewerId]
    );
    votesResult.rows.forEach((r) => myVotes.set(r.post_id, r.option_id));
  }

  optionsResult.rows.forEach((row) => {
    if (!pollsByPost.has(row.post_id)) {
      pollsByPost.set(row.post_id, { totalVotes: 0, myVoteOptionId: myVotes.get(row.post_id) || null, options: [] });
    }
    const poll = pollsByPost.get(row.post_id);
    poll.options.push({ id: row.id, text: row.text, voteCount: Number(row.vote_count) });
    poll.totalVotes += Number(row.vote_count);
  });

  return pollsByPost;
}

function serializePost(row, viewerId, poll) {
  // `image_paths` is a "||"-joined list built by FEED_QUERY's post_images
  // subquery, already ordered by position. Fall back to the legacy single
  // `image_path` column for posts created before multi-image support
  // existed and not yet backfilled by migrate.js.
  const imagePaths = row.image_paths
    ? row.image_paths.split("||").filter(Boolean)
    : (row.image_path ? [row.image_path] : []);
  const imageUrls = imagePaths.map((p) => `/uploads/${p}`);

  return {
    id: row.id,
    authorId: row.author_id,
    authorCallsign: row.callsign,
    authorName: row.name,
    authorHue: row.hue,
    authorAvatarUrl: row.avatar_path ? `/uploads/${row.avatar_path}` : null,
    type: row.type,
    text: row.text,
    // flight is stored as a JSON string in SQLite (no native JSONB type)
    flight: row.flight ? JSON.parse(row.flight) : null,
    imageUrls,
    // Kept for older client code paths — always the first image.
    imageUrl: imageUrls[0] || null,
    likeCount: Number(row.like_count),
    // SQLite's EXISTS(...) yields 0/1, not a real boolean
    likedByMe: viewerId ? !!row.liked_by_me : false,
    commentCount: Number(row.comment_count),
    // Total number of flight-type posts by this author, shown as a badge
    // next to the post (based on the flight cards they've posted).
    authorFlightCount: Number(row.author_flight_count || 0),
    // Poll data (投票機能), attached by the caller via loadPollsForPosts —
    // null for posts with no poll. Not fetched by a FEED_QUERY subquery
    // like likeCount/commentCount since a poll has a variable number of
    // options; see loadPollsForPosts for why this is a separate batch query.
    poll: poll || null,
    createdAt: row.created_at,
  };
}

// Batches serializePost + loadPollsForPosts for a full result set (feed
// pages, search results, popular-flights) in one extra pair of queries
// total, rather than one pair per post.
async function serializePosts(rows, viewerId) {
  const pollsByPost = await loadPollsForPosts(rows.map((r) => r.id), viewerId);
  return rows.map((r) => serializePost(r, viewerId, pollsByPost.get(r.id)));
}

const FEED_QUERY = `
  SELECT p.*, u.callsign, u.name, u.hue, u.avatar_path,
    COALESCE(l.like_count, 0) AS like_count,
    COALESCE(c.comment_count, 0) AS comment_count,
    COALESCE(fc.flight_count, 0) AS author_flight_count,
    EXISTS (SELECT 1 FROM likes WHERE post_id = p.id AND user_id = $1) AS liked_by_me,
    (SELECT GROUP_CONCAT(path, '||') FROM (
      SELECT path FROM post_images WHERE post_id = p.id ORDER BY position ASC, created_at ASC
    )) AS image_paths
  FROM posts p
  JOIN users u ON u.id = p.author_id
  LEFT JOIN (SELECT post_id, COUNT(*) AS like_count FROM likes GROUP BY post_id) l ON l.post_id = p.id
  LEFT JOIN (SELECT post_id, COUNT(*) AS comment_count FROM comments GROUP BY post_id) c ON c.post_id = p.id
  LEFT JOIN (SELECT author_id, COUNT(*) AS flight_count FROM posts WHERE type = 'flight' GROUP BY author_id) fc ON fc.author_id = p.author_id
`;

// Pushes a "new post" notification to every user eligible for it: anyone
// with notify_pref = 'all', plus followers of the author with
// notify_pref = 'following'. The author never notifies themselves. This is
// fire-and-forget from the caller's perspective (errors are logged, never
// thrown) so a push failure can never fail the post creation request.
async function notifyNewPost(post, author) {
  try {
    const result = await pool.query(
      `SELECT id FROM users
       WHERE id != $1
         AND (
           notify_pref = 'all'
           OR (notify_pref = 'following' AND id IN (
             SELECT follower_id FROM follows WHERE followee_id = $2
           ))
         )`,
      [author.id, author.id]
    );
    const userIds = result.rows.map((r) => r.id);
    if (!userIds.length) return;

    const body = post.text
      ? post.text.slice(0, 100)
      : (post.flight ? "フライトログを投稿しました" : "画像を投稿しました");

    await push.pushToUsers(userIds, {
      title: `${author.callsign}が投稿しました`,
      body,
      url: `/?post=${post.id}`,
      tag: `post-${post.id}`,
    });
  } catch (err) {
    console.error("notifyNewPost failed:", err);
  }
}

// Shared post-creation logic. Used by:
//  - POST /api/posts below (normal, JWT-authenticated client flow)
//  - src/routes/fsaFlightPost.js (FSA自動投稿ブリッジ経由の投稿。
//    scripts/fsa-to-aerosocial-bridge.js -> POST /api/internal/fsa-flight-post)
// so both paths insert/broadcast/notify identically instead of drifting out
// of sync with each other over time.
//
// `files` is the multer-style array (each with a `.filename`); pass an
// empty array for callers that never attach images (e.g. the FSA bridge).
async function createPost({ authorId, text, flight, files, poll }) {
  // SQLite has no gen_random_uuid(), so the id is generated here instead
  // of relying on a column default.
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO posts (id, author_id, type, text, flight)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      id,
      authorId,
      flight ? "flight" : "text",
      text?.trim() || null,
      flight ? JSON.stringify(flight) : null,
    ]
  );

  const imageFiles = files || [];
  for (let i = 0; i < imageFiles.length; i++) {
    await pool.query(
      `INSERT INTO post_images (id, post_id, path, position) VALUES ($1, $2, $3, $4)`,
      [crypto.randomUUID(), id, imageFiles[i].filename, i]
    );
  }

  // poll is pre-validated (option count/length) by the POST "/" handler
  // below — createPost() itself is also called by fsaFlightPost.js, which
  // never passes one, so this stays a no-op in that path.
  if (poll) {
    await pool.query(`INSERT INTO polls (post_id) VALUES ($1)`, [id]);
    for (let i = 0; i < poll.options.length; i++) {
      await pool.query(
        `INSERT INTO poll_options (id, post_id, text, position) VALUES ($1, $2, $3, $4)`,
        [crypto.randomUUID(), id, poll.options[i], i]
      );
    }
  }

  const full = await pool.query(`${FEED_QUERY} WHERE p.id = $2`, [authorId, id]);
  const [post] = await serializePosts(full.rows, authorId);
  broadcast("post:new", post);
  notifyNewPost(post, { id: authorId, callsign: post.authorCallsign });
  // Discord通知もfire-and-forget(awaitしない)。Bot未接続時やDiscord側の
  // 障害時もnotifyDiscordNewPost内部でcatch済みなので、ここで例外が投稿
  // 作成レスポンスに影響することはない。
  notifyDiscordNewPost({
    callsign: post.authorCallsign,
    content: post.text || (post.flight ? "フライトログを投稿しました" : null),
    postId: post.id,
    imageUrls: post.imageUrls.map((p) => `${process.env.SITE_URL || ""}${p}`),
  });
  return post;
}

// GET /api/posts?type=flight&author=CALLSIGN&before=<ISO date>&limit=20
router.get("/", optionalAuth, async (req, res) => {
  try {
    const { type, author, before } = req.query;
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const conditions = [];
    const params = [req.user?.id || null];

    if (type) { params.push(type); conditions.push(`p.type = $${params.length}`); }
    if (author) { params.push(String(author).toUpperCase()); conditions.push(`u.callsign = $${params.length}`); }
    if (before) { params.push(before); conditions.push(`p.created_at < $${params.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);
    const query = `${FEED_QUERY} ${where} ORDER BY p.created_at DESC LIMIT $${params.length}`;

    const result = await pool.query(query, params);
    res.json({ posts: await serializePosts(result.rows, req.user?.id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "フィードの取得に失敗しました。" });
  }
});

// GET /api/posts/popular-flights?limit=5
// Returns the most-liked flight-type posts, for the "人気のフライト" panel.
// Must be declared before any GET "/:id..." routes so "popular-flights"
// isn't swallowed as an :id — there currently isn't a bare GET "/:id" route,
// but keeping this near the top avoids future collisions.
router.get("/popular-flights", optionalAuth, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 5, 20);
    const query = `${FEED_QUERY} WHERE p.type = 'flight' ORDER BY like_count DESC, p.created_at DESC LIMIT $2`;
    const result = await pool.query(query, [req.user?.id || null, limit]);
    res.json({ posts: await serializePosts(result.rows, req.user?.id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "人気のフライトの取得に失敗しました。" });
  }
});

// GET /api/posts/search?q=...&limit=30
// Searches post text, and — since `flight` is stored as a JSON string —
// a route/airport/aircraft substring inside a flight log too (e.g. "RJTT"
// matches flight posts through Haneda even with no free-text caption).
// Declared before the bare GET "/:id" route below so "search" isn't
// swallowed as an :id, same reasoning as "/popular-flights" above.
router.get("/search", optionalAuth, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.json({ posts: [] });

    const limit = Math.min(Number(req.query.limit) || 30, 50);
    const like = `%${q}%`;
    const params = [req.user?.id || null];
    params.push(like);
    const textCond = `p.text LIKE $${params.length}`;
    params.push(like);
    const flightCond = `p.flight LIKE $${params.length}`;
    params.push(limit);

    const query = `${FEED_QUERY} WHERE (${textCond} OR ${flightCond}) ORDER BY p.created_at DESC LIMIT $${params.length}`;
    const result = await pool.query(query, params);
    res.json({ posts: await serializePosts(result.rows, req.user?.id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "検索に失敗しました。" });
  }
});

// GET /api/posts/:id
// Fetches a single post by id, regardless of whether it's within the most
// recently loaded feed page. Used for permalinks / the "share post" feature,
// since a shared link may point to a post older than the feed's normal
// page window. Must be declared after "/popular-flights" (so that literal
// path isn't swallowed here) but can otherwise sit anywhere relative to the
// other /:id... routes, since Express matches by exact path shape.
router.get("/:id", optionalAuth, async (req, res) => {
  try {
    const result = await pool.query(`${FEED_QUERY} WHERE p.id = $2`, [req.user?.id || null, req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: "投稿が見つかりません。" });
    const [post] = await serializePosts([result.rows[0]], req.user?.id);
    res.json({ post });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "投稿の取得に失敗しました。" });
  }
});

// POST /api/posts
// multipart/form-data: text, flight (JSON string), images (0-6 files,
// field repeated once per file — e.g. FormData#append("images", file) in a
// loop on the client)
router.post("/", requireAuth, upload.array("images", upload.MAX_FILES_PER_POST), async (req, res) => {
  try {
    const { text } = req.body;
    let flight = null;
    if (req.body.flight) {
      try { flight = JSON.parse(req.body.flight); } catch { flight = null; }
    }

    // poll (投票機能): JSON string like { "options": ["A", "B", "C"] } —
    // the poll's "question" is just the post's own `text`, same as how a
    // flight-type post's caption and flight card are already independent
    // fields. 2-6 non-empty options, each capped at POLL_MAX_OPTION_LEN,
    // required to have an actual caption to ask the question with.
    let poll = null;
    if (req.body.poll) {
      let parsed;
      try { parsed = JSON.parse(req.body.poll); } catch { parsed = null; }
      const options = Array.isArray(parsed?.options)
        ? parsed.options.map((o) => String(o || "").trim()).filter(Boolean)
        : [];
      if (options.length) {
        if (!text?.trim()) {
          return res.status(400).json({ error: "投票には質問文（本文）が必要です。" });
        }
        if (options.length < POLL_MIN_OPTIONS || options.length > POLL_MAX_OPTIONS) {
          return res.status(400).json({ error: `選択肢は${POLL_MIN_OPTIONS}〜${POLL_MAX_OPTIONS}個にしてください。` });
        }
        if (options.some((o) => o.length > POLL_MAX_OPTION_LEN)) {
          return res.status(400).json({ error: `選択肢は${POLL_MAX_OPTION_LEN}文字以内にしてください。` });
        }
        poll = { options };
      }
    }

    const files = req.files || [];
    if (!text?.trim() && !flight && !files.length && !poll) {
      return res.status(400).json({ error: "本文・フライトログ・画像・投票のいずれかが必要です。" });
    }

    const post = await createPost({ authorId: req.user.id, text, flight, files, poll });
    res.status(201).json({ post });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "投稿に失敗しました。" });
  }
});

// POST /api/posts/:id/like  (toggle)
router.post("/:id/like", requireAuth, async (req, res) => {
  try {
    const existing = await pool.query(
      "SELECT 1 FROM likes WHERE post_id = $1 AND user_id = $2",
      [req.params.id, req.user.id]
    );
    let liked;
    if (existing.rows.length) {
      await pool.query("DELETE FROM likes WHERE post_id = $1 AND user_id = $2", [req.params.id, req.user.id]);
      liked = false;
    } else {
      await pool.query("INSERT INTO likes (post_id, user_id) VALUES ($1, $2)", [req.params.id, req.user.id]);
      liked = true;
    }

    const countResult = await pool.query("SELECT COUNT(*) AS c FROM likes WHERE post_id = $1", [req.params.id]);
    const likeCount = Number(countResult.rows[0].c);
    broadcast("post:like", { postId: req.params.id, userId: req.user.id, liked, likeCount });
    res.json({ liked, likeCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "いいねに失敗しました。" });
  }
});

// POST /api/posts/:id/vote  { optionId }
// One vote per user per poll: voting for a new option overwrites the
// previous one (PRIMARY KEY (post_id, user_id) on poll_votes), voting for
// the option already selected clears the vote (un-vote) — same toggle
// pattern as /like above, just keyed by option rather than a bare boolean.
router.post("/:id/vote", requireAuth, async (req, res) => {
  try {
    const postId = req.params.id;
    const optionId = String(req.body.optionId || "");

    const optionResult = await pool.query(
      "SELECT id FROM poll_options WHERE id = $1 AND post_id = $2",
      [optionId, postId]
    );
    if (!optionResult.rows.length) {
      return res.status(404).json({ error: "選択肢が見つかりません。" });
    }

    const existing = await pool.query(
      "SELECT option_id FROM poll_votes WHERE post_id = $1 AND user_id = $2",
      [postId, req.user.id]
    );

    if (existing.rows[0]?.option_id === optionId) {
      await pool.query("DELETE FROM poll_votes WHERE post_id = $1 AND user_id = $2", [postId, req.user.id]);
    } else if (existing.rows.length) {
      await pool.query(
        "UPDATE poll_votes SET option_id = $1, created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE post_id = $2 AND user_id = $3",
        [optionId, postId, req.user.id]
      );
    } else {
      await pool.query(
        "INSERT INTO poll_votes (post_id, option_id, user_id) VALUES ($1, $2, $3)",
        [postId, optionId, req.user.id]
      );
    }

    const pollsByPost = await loadPollsForPosts([postId], req.user.id);
    const poll = pollsByPost.get(postId) || { totalVotes: 0, myVoteOptionId: null, options: [] };
    broadcast("poll:vote", { postId, poll: { ...poll, myVoteOptionId: undefined } });
    res.json({ poll });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "投票に失敗しました。" });
  }
});

// GET /api/posts/:id/comments
router.get("/:id/comments", async (req, res) => {
  const result = await pool.query(
    `SELECT c.id, c.text, c.created_at AS "createdAt",
            u.callsign AS "authorCallsign", u.name AS "authorName", u.id AS "authorId"
     FROM comments c JOIN users u ON u.id = c.author_id
     WHERE c.post_id = $1 ORDER BY c.created_at ASC`,
    [req.params.id]
  );
  res.json({ comments: result.rows });
});

// POST /api/posts/:id/comments  { text }
router.post("/:id/comments", requireAuth, async (req, res) => {
  try {
    const text = String(req.body.text || "").trim();
    if (!text) return res.status(400).json({ error: "コメントを入力してください。" });

    const id = crypto.randomUUID();
    const result = await pool.query(
      `INSERT INTO comments (id, post_id, author_id, text) VALUES ($1, $2, $3, $4)
       RETURNING id, text, created_at`,
      [id, req.params.id, req.user.id, text]
    );
    // req.user comes from the JWT, which only carries id/callsign, so the
    // display name is fetched separately here for the realtime broadcast.
    const authorRow = await pool.query("SELECT name FROM users WHERE id = $1", [req.user.id]);
    const comment = {
      ...result.rows[0],
      authorCallsign: req.user.callsign,
      authorName: authorRow.rows[0]?.name || req.user.callsign,
      authorId: req.user.id,
    };
    broadcast("comment:new", { postId: req.params.id, comment });
    res.status(201).json({ comment });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "コメントの投稿に失敗しました。" });
  }
});

// DELETE /api/posts/:id  (author only)
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM posts WHERE id = $1", [req.params.id]);
    const post = result.rows[0];
    if (!post) return res.status(404).json({ error: "投稿が見つかりません。" });
    if (post.author_id !== req.user.id) return res.status(403).json({ error: "この投稿を削除する権限がありません。" });

    const imagesResult = await pool.query("SELECT path FROM post_images WHERE post_id = $1", [req.params.id]);
    const imagePaths = imagesResult.rows.map((r) => r.path);
    // Legacy column, for posts that predate multi-image support and
    // haven't been backfilled into post_images yet.
    if (post.image_path && !imagePaths.includes(post.image_path)) imagePaths.push(post.image_path);

    await pool.query("DELETE FROM posts WHERE id = $1", [req.params.id]);
    const uploadDir = process.env.UPLOAD_DIR || "./uploads";
    imagePaths.forEach((p) => fs.unlink(`${uploadDir}/${p}`, () => {}));
    broadcast("post:deleted", { id: req.params.id });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "削除に失敗しました。" });
  }
});

module.exports = router;
// Exposed as a property on the router (still a plain function, so
// `app.use("/api/posts", require("./routes/posts"))` in index.js keeps
// working unchanged) so other route files — currently just
// fsaFlightPost.js — can create a post the exact same way this file does,
// without duplicating the insert/broadcast/notify logic.
router.createPost = createPost;
