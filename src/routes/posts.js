const express = require("express");
const fs = require("fs");
const crypto = require("crypto");
const pool = require("../db");
const { requireAuth, optionalAuth } = require("../middleware/auth");
const upload = require("../middleware/upload");
const { broadcast } = require("../ws");

const router = express.Router();

function serializePost(row, viewerId) {
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
    imageUrl: row.image_path ? `/uploads/${row.image_path}` : null,
    likeCount: Number(row.like_count),
    // SQLite's EXISTS(...) yields 0/1, not a real boolean
    likedByMe: viewerId ? !!row.liked_by_me : false,
    commentCount: Number(row.comment_count),
    // Total number of flight-type posts by this author, shown as a badge
    // next to the post (based on the flight cards they've posted).
    authorFlightCount: Number(row.author_flight_count || 0),
    createdAt: row.created_at,
  };
}

const FEED_QUERY = `
  SELECT p.*, u.callsign, u.name, u.hue, u.avatar_path,
    COALESCE(l.like_count, 0) AS like_count,
    COALESCE(c.comment_count, 0) AS comment_count,
    COALESCE(fc.flight_count, 0) AS author_flight_count,
    EXISTS (SELECT 1 FROM likes WHERE post_id = p.id AND user_id = $1) AS liked_by_me
  FROM posts p
  JOIN users u ON u.id = p.author_id
  LEFT JOIN (SELECT post_id, COUNT(*) AS like_count FROM likes GROUP BY post_id) l ON l.post_id = p.id
  LEFT JOIN (SELECT post_id, COUNT(*) AS comment_count FROM comments GROUP BY post_id) c ON c.post_id = p.id
  LEFT JOIN (SELECT author_id, COUNT(*) AS flight_count FROM posts WHERE type = 'flight' GROUP BY author_id) fc ON fc.author_id = p.author_id
`;

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
    res.json({ posts: result.rows.map((r) => serializePost(r, req.user?.id)) });
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
    res.json({ posts: result.rows.map((r) => serializePost(r, req.user?.id)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "人気のフライトの取得に失敗しました。" });
  }
});

// POST /api/posts  (multipart/form-data: text, flight (JSON string), image (file, optional))
router.post("/", requireAuth, upload.single("image"), async (req, res) => {
  try {
    const { text } = req.body;
    let flight = null;
    if (req.body.flight) {
      try { flight = JSON.parse(req.body.flight); } catch { flight = null; }
    }
    if (!text?.trim() && !flight && !req.file) {
      return res.status(400).json({ error: "本文・フライトログ・画像のいずれかが必要です。" });
    }

    // SQLite has no gen_random_uuid(), so the id is generated here instead
    // of relying on a column default.
    const id = crypto.randomUUID();
    const result = await pool.query(
      `INSERT INTO posts (id, author_id, type, text, flight, image_path)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        id,
        req.user.id,
        flight ? "flight" : "text",
        text?.trim() || null,
        flight ? JSON.stringify(flight) : null,
        req.file?.filename || null,
      ]
    );

    const full = await pool.query(`${FEED_QUERY} WHERE p.id = $2`, [req.user.id, result.rows[0].id]);
    const post = serializePost(full.rows[0], req.user.id);
    broadcast("post:new", post);
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

// GET /api/posts/:id/comments
router.get("/:id/comments", async (req, res) => {
  const result = await pool.query(
    `SELECT c.id, c.text, c.created_at, u.callsign AS author_callsign, u.name AS author_name, u.id AS author_id
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

    await pool.query("DELETE FROM posts WHERE id = $1", [req.params.id]);
    if (post.image_path) {
      const filePath = `${process.env.UPLOAD_DIR || "./uploads"}/${post.image_path}`;
      fs.unlink(filePath, () => {});
    }
    broadcast("post:deleted", { id: req.params.id });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "削除に失敗しました。" });
  }
});

module.exports = router;
