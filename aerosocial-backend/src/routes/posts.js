const express = require("express");
const fs = require("fs");
const pool = require("../db");
const { requireAuth, optionalAuth } = require("../middleware/auth");
const upload = require("../middleware/upload");

const router = express.Router();

function serializePost(row, viewerId) {
  return {
    id: row.id,
    authorId: row.author_id,
    authorCallsign: row.callsign,
    authorName: row.name,
    authorHue: row.hue,
    type: row.type,
    text: row.text,
    flight: row.flight,
    imageUrl: row.image_path ? `/uploads/${row.image_path}` : null,
    likeCount: Number(row.like_count),
    likedByMe: viewerId ? row.liked_by_me : false,
    commentCount: Number(row.comment_count),
    createdAt: row.created_at,
  };
}

const FEED_QUERY = `
  SELECT p.*, u.callsign, u.name, u.hue,
    COALESCE(l.like_count, 0) AS like_count,
    COALESCE(c.comment_count, 0) AS comment_count,
    EXISTS (SELECT 1 FROM likes WHERE post_id = p.id AND user_id = $1) AS liked_by_me
  FROM posts p
  JOIN users u ON u.id = p.author_id
  LEFT JOIN (SELECT post_id, COUNT(*) AS like_count FROM likes GROUP BY post_id) l ON l.post_id = p.id
  LEFT JOIN (SELECT post_id, COUNT(*) AS comment_count FROM comments GROUP BY post_id) c ON c.post_id = p.id
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

    const result = await pool.query(
      `INSERT INTO posts (author_id, type, text, flight, image_path)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [req.user.id, flight ? "flight" : "text", text?.trim() || null, flight, req.file?.filename || null]
    );

    const full = await pool.query(`${FEED_QUERY} WHERE p.id = $2`, [req.user.id, result.rows[0].id]);
    res.status(201).json({ post: serializePost(full.rows[0], req.user.id) });
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
    if (existing.rows.length) {
      await pool.query("DELETE FROM likes WHERE post_id = $1 AND user_id = $2", [req.params.id, req.user.id]);
      return res.json({ liked: false });
    }
    await pool.query("INSERT INTO likes (post_id, user_id) VALUES ($1, $2)", [req.params.id, req.user.id]);
    res.json({ liked: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "いいねに失敗しました。" });
  }
});

// GET /api/posts/:id/comments
router.get("/:id/comments", async (req, res) => {
  const result = await pool.query(
    `SELECT c.id, c.text, c.created_at, u.callsign AS author_callsign, u.id AS author_id
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
    const result = await pool.query(
      `INSERT INTO comments (post_id, author_id, text) VALUES ($1, $2, $3)
       RETURNING id, text, created_at`,
      [req.params.id, req.user.id, text]
    );
    res.status(201).json({
      comment: { ...result.rows[0], authorCallsign: req.user.callsign, authorId: req.user.id },
    });
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
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "削除に失敗しました。" });
  }
});

module.exports = router;
