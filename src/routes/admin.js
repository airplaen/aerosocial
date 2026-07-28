const express = require("express");
const fs = require("fs");
const pool = require("../db");
const { requireAuth } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/requireAdmin");
const { broadcast } = require("../ws");
const push = require("../lib/push");

const router = express.Router();

// Every route below requires a valid session AND the is_admin flag.
router.use(requireAuth, requireAdmin);

function adminUserView(row) {
  return {
    id: row.id,
    callsign: row.callsign,
    name: row.name,
    homeBase: row.home_base,
    hue: row.hue,
    avatarUrl: row.avatar_path ? `/uploads/${row.avatar_path}` : null,
    isAdmin: !!row.is_admin,
    isBanned: !!row.is_banned,
    joined: row.created_at,
    postCount: Number(row.post_count || 0),
    followerCount: Number(row.follower_count || 0),
  };
}

// GET /api/admin/me
// Lets the admin frontend confirm (after a normal /api/auth/login) that
// this account actually has admin rights, and who it's logged in as.
router.get("/me", (req, res) => {
  res.json({ id: req.user.id, callsign: req.user.callsign });
});

// GET /api/admin/stats
router.get("/stats", async (_req, res) => {
  try {
    const [users, posts, comments, likes, follows, pushSubs, banned, admins] = await Promise.all([
      pool.query("SELECT COUNT(*) AS c FROM users"),
      pool.query("SELECT COUNT(*) AS c FROM posts"),
      pool.query("SELECT COUNT(*) AS c FROM comments"),
      pool.query("SELECT COUNT(*) AS c FROM likes"),
      pool.query("SELECT COUNT(*) AS c FROM follows"),
      pool.query("SELECT COUNT(*) AS c FROM push_subscriptions"),
      pool.query("SELECT COUNT(*) AS c FROM users WHERE is_banned = 1"),
      pool.query("SELECT COUNT(*) AS c FROM users WHERE is_admin = 1"),
    ]);
    const postsByType = await pool.query("SELECT type, COUNT(*) AS c FROM posts GROUP BY type");
    const recentUsers = await pool.query(
      "SELECT COUNT(*) AS c FROM users WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')"
    );
    const recentPosts = await pool.query(
      "SELECT COUNT(*) AS c FROM posts WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')"
    );

    res.json({
      totals: {
        users: Number(users.rows[0].c),
        posts: Number(posts.rows[0].c),
        comments: Number(comments.rows[0].c),
        likes: Number(likes.rows[0].c),
        follows: Number(follows.rows[0].c),
        pushSubscriptions: Number(pushSubs.rows[0].c),
        bannedUsers: Number(banned.rows[0].c),
        adminUsers: Number(admins.rows[0].c),
      },
      postsByType: Object.fromEntries(postsByType.rows.map((r) => [r.type, Number(r.c)])),
      last7Days: {
        newUsers: Number(recentUsers.rows[0].c),
        newPosts: Number(recentPosts.rows[0].c),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "統計の取得に失敗しました。" });
  }
});

// GET /api/admin/users?search=&limit=&offset=
router.get("/users", async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const where = search ? "WHERE UPPER(u.callsign) LIKE $1 OR u.name LIKE $2" : "";
    const params = search ? [`%${search.toUpperCase()}%`, `%${search}%`] : [];

    params.push(limit, offset);
    const query = `
      SELECT u.*,
        (SELECT COUNT(*) FROM posts WHERE author_id = u.id) AS post_count,
        (SELECT COUNT(*) FROM follows WHERE followee_id = u.id) AS follower_count
      FROM users u
      ${where}
      ORDER BY u.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;
    const result = await pool.query(query, params);

    const countParams = search ? [`%${search.toUpperCase()}%`, `%${search}%`] : [];
    const countWhere = search ? "WHERE UPPER(callsign) LIKE $1 OR name LIKE $2" : "";
    const countResult = await pool.query(`SELECT COUNT(*) AS c FROM users ${countWhere}`, countParams);

    res.json({ users: result.rows.map(adminUserView), total: Number(countResult.rows[0].c) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "ユーザー一覧の取得に失敗しました。" });
  }
});

// PATCH /api/admin/users/:id   { isAdmin?, isBanned? }
router.patch("/users/:id", async (req, res) => {
  try {
    const { isAdmin, isBanned } = req.body;
    const targetId = req.params.id;

    if (targetId === req.user.id && isAdmin === false) {
      return res.status(400).json({ error: "自分自身の管理者権限は解除できません。" });
    }
    if (targetId === req.user.id && isBanned === true) {
      return res.status(400).json({ error: "自分自身をBANすることはできません。" });
    }

    const existing = await pool.query(
      `SELECT u.*, (SELECT COUNT(*) FROM posts WHERE author_id = u.id) AS post_count,
              (SELECT COUNT(*) FROM follows WHERE followee_id = u.id) AS follower_count
       FROM users u WHERE u.id = $1`,
      [targetId]
    );
    if (!existing.rows[0]) return res.status(404).json({ error: "ユーザーが見つかりません。" });

    const fields = [];
    const params = [];
    let idx = 1;
    if (isAdmin !== undefined) { fields.push(`is_admin = $${idx++}`); params.push(isAdmin ? 1 : 0); }
    if (isBanned !== undefined) { fields.push(`is_banned = $${idx++}`); params.push(isBanned ? 1 : 0); }
    if (!fields.length) return res.status(400).json({ error: "更新する項目がありません。" });

    params.push(targetId);
    await pool.query(`UPDATE users SET ${fields.join(", ")} WHERE id = $${idx}`, params);

    const updated = await pool.query("SELECT * FROM users WHERE id = $1", [targetId]);
    res.json({
      user: adminUserView({
        ...updated.rows[0],
        post_count: existing.rows[0].post_count,
        follower_count: existing.rows[0].follower_count,
      }),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "ユーザーの更新に失敗しました。" });
  }
});

// DELETE /api/admin/users/:id
router.delete("/users/:id", async (req, res) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: "自分自身は削除できません。" });
    }
    const existing = await pool.query("SELECT * FROM users WHERE id = $1", [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: "ユーザーが見つかりません。" });

    const uploadDir = process.env.UPLOAD_DIR || "./uploads";
    if (existing.rows[0].avatar_path) {
      fs.unlink(`${uploadDir}/${existing.rows[0].avatar_path}`, () => {});
    }
    // posts/likes/comments/follows/push_subscriptions cascade via the
    // ON DELETE CASCADE foreign keys in schema.sql — only the on-disk
    // image files need explicit cleanup here.
    const images = await pool.query(
      `SELECT pi.path FROM post_images pi JOIN posts p ON p.id = pi.post_id WHERE p.author_id = $1`,
      [req.params.id]
    );
    images.rows.forEach((r) => fs.unlink(`${uploadDir}/${r.path}`, () => {}));

    await pool.query("DELETE FROM users WHERE id = $1", [req.params.id]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "ユーザーの削除に失敗しました。" });
  }
});

// GET /api/admin/posts?search=&type=&author=&limit=&offset=
router.get("/posts", async (req, res) => {
  try {
    const { search, type, author } = req.query;
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const conditions = [];
    const params = [];
    if (search) { params.push(`%${search}%`); conditions.push(`p.text LIKE $${params.length}`); }
    if (type) { params.push(type); conditions.push(`p.type = $${params.length}`); }
    if (author) { params.push(String(author).toUpperCase()); conditions.push(`u.callsign = $${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    params.push(limit, offset);
    const query = `
      SELECT p.id, p.type, p.text, p.created_at, u.callsign, u.id AS author_id,
        COALESCE(l.like_count, 0) AS like_count,
        COALESCE(c.comment_count, 0) AS comment_count
      FROM posts p
      JOIN users u ON u.id = p.author_id
      LEFT JOIN (SELECT post_id, COUNT(*) AS like_count FROM likes GROUP BY post_id) l ON l.post_id = p.id
      LEFT JOIN (SELECT post_id, COUNT(*) AS comment_count FROM comments GROUP BY post_id) c ON c.post_id = p.id
      ${where}
      ORDER BY p.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;
    const result = await pool.query(query, params);

    res.json({
      posts: result.rows.map((r) => ({
        id: r.id,
        type: r.type,
        text: r.text,
        authorCallsign: r.callsign,
        authorId: r.author_id,
        likeCount: Number(r.like_count),
        commentCount: Number(r.comment_count),
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "投稿一覧の取得に失敗しました。" });
  }
});

// DELETE /api/admin/posts/:id
// Same cleanup as the author-only DELETE /api/posts/:id in routes/posts.js,
// but without the ownership check — an admin can remove any post.
router.delete("/posts/:id", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM posts WHERE id = $1", [req.params.id]);
    const post = result.rows[0];
    if (!post) return res.status(404).json({ error: "投稿が見つかりません。" });

    const imagesResult = await pool.query("SELECT path FROM post_images WHERE post_id = $1", [req.params.id]);
    const imagePaths = imagesResult.rows.map((r) => r.path);
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

// GET /api/admin/notifications — push notification delivery overview
router.get("/notifications", async (_req, res) => {
  try {
    const totalSubs = await pool.query("SELECT COUNT(*) AS c FROM push_subscriptions");
    const usersWithSubs = await pool.query("SELECT COUNT(DISTINCT user_id) AS c FROM push_subscriptions");
    const byPref = await pool.query("SELECT notify_pref, COUNT(*) AS c FROM users GROUP BY notify_pref");

    res.json({
      vapidConfigured: push.enabled,
      totalSubscriptions: Number(totalSubs.rows[0].c),
      usersWithSubscriptions: Number(usersWithSubs.rows[0].c),
      notifyPrefBreakdown: Object.fromEntries(byPref.rows.map((r) => [r.notify_pref, Number(r.c)])),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "通知状況の取得に失敗しました。" });
  }
});

// GET /api/admin/ads
// Returns the current ad embed code (AdSense/AdMax/etc. snippet), whether
// it's turned on, and how many posts appear between insertions in the
// feed. Backed by the single-row ad_settings table (id = 1).
router.get("/ads", async (_req, res) => {
  try {
    const result = await pool.query("SELECT enabled, code, frequency FROM ad_settings WHERE id = 1");
    const row = result.rows[0] || { enabled: 0, code: "", frequency: 5 };
    res.json({ enabled: !!row.enabled, code: row.code || "", frequency: Number(row.frequency) || 5 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "広告設定の取得に失敗しました。" });
  }
});

// PUT /api/admin/ads   { enabled, code, frequency }
// `code` is stored and served back to every visitor's browser verbatim
// (see routes/ads.js) — it's expected to contain the raw <script>/<ins>
// snippet issued by an ad network, so no HTML sanitization is applied
// here. Only admins (already gated by requireAdmin above) can set it.
router.put("/ads", async (req, res) => {
  try {
    const enabled = !!req.body.enabled;
    const code = String(req.body.code ?? "");
    if (code.length > 20000) {
      return res.status(400).json({ error: "広告コードが長すぎます（20000文字以内）。" });
    }

    let frequency = Number(req.body.frequency);
    if (!Number.isInteger(frequency) || frequency < 1) frequency = 5;
    frequency = Math.min(frequency, 50);

    await pool.query(
      `UPDATE ad_settings
       SET enabled = $1, code = $2, frequency = $3, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = 1`,
      [enabled ? 1 : 0, code, frequency]
    );
    res.json({ enabled, code, frequency });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "広告設定の保存に失敗しました。" });
  }
});

module.exports = router;
