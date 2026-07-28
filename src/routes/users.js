const express = require("express");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const pool = require("../db");
const { requireAuth, optionalAuth } = require("../middleware/auth");
const upload = require("../middleware/upload");
const push = require("../lib/push");

const router = express.Router();

function publicUser(row) {
  return {
    id: row.id,
    callsign: row.callsign,
    name: row.name,
    homeBase: row.home_base,
    bio: row.bio,
    hue: row.hue,
    avatarUrl: row.avatar_path ? `/uploads/${row.avatar_path}` : null,
    joined: row.created_at,
  };
}

// GET /api/users/me  (must come before /:callsign so "me" isn't read as a callsign)
router.get("/me", requireAuth, async (req, res) => {
  const result = await pool.query("SELECT * FROM users WHERE id = $1", [req.user.id]);
  if (!result.rows[0]) return res.status(404).json({ error: "ユーザーが見つかりません。" });
  res.json({ user: publicUser(result.rows[0]) });
});

// PATCH /api/users/me
// Accepts either JSON or multipart/form-data (multipart is required to
// include a new avatar image under the "avatar" field).
// Fields: name?, homeBase?, bio?, hue?, currentPassword?, newPassword?, avatar? (file)
router.patch("/me", requireAuth, upload.single("avatar"), async (req, res) => {
  try {
    const { name, homeBase, bio, hue, currentPassword, newPassword } = req.body;

    const existing = await pool.query("SELECT * FROM users WHERE id = $1", [req.user.id]);
    const user = existing.rows[0];
    if (!user) return res.status(404).json({ error: "ユーザーが見つかりません。" });

    const fields = [];
    const params = [];
    let idx = 1;

    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (!trimmed) return res.status(400).json({ error: "名前を入力してください。" });
      fields.push(`name = $${idx++}`);
      params.push(trimmed.slice(0, 100));
    }

    if (homeBase !== undefined) {
      fields.push(`home_base = $${idx++}`);
      params.push(String(homeBase || "").trim().toUpperCase().slice(0, 4));
    }

    if (bio !== undefined) {
      fields.push(`bio = $${idx++}`);
      params.push(String(bio || "").slice(0, 280));
    }

    if (hue !== undefined) {
      const h = Number(hue);
      if (!Number.isInteger(h) || h < 0 || h > 360) {
        return res.status(400).json({ error: "hueは0〜360の整数で指定してください。" });
      }
      fields.push(`hue = $${idx++}`);
      params.push(h);
    }

    if (req.file) {
      fields.push(`avatar_path = $${idx++}`);
      params.push(req.file.filename);
    }

    if (newPassword) {
      if (!currentPassword) {
        return res.status(400).json({ error: "現在のパスワードを入力してください。" });
      }
      const ok = await bcrypt.compare(currentPassword, user.password_hash);
      if (!ok) return res.status(401).json({ error: "現在のパスワードが正しくありません。" });
      if (newPassword.length < 8) {
        return res.status(400).json({ error: "新しいパスワードは8文字以上で入力してください。" });
      }
      const hash = await bcrypt.hash(newPassword, 12);
      fields.push(`password_hash = $${idx++}`);
      params.push(hash);
    }

    if (!fields.length) {
      return res.status(400).json({ error: "更新する項目がありません。" });
    }

    params.push(req.user.id);
    await pool.query(`UPDATE users SET ${fields.join(", ")} WHERE id = $${idx}`, params);

    // Clean up the old avatar file once the new one is safely saved.
    if (req.file && user.avatar_path) {
      const oldPath = `${process.env.UPLOAD_DIR || "./uploads"}/${user.avatar_path}`;
      fs.unlink(oldPath, () => {});
    }

    const updated = await pool.query("SELECT * FROM users WHERE id = $1", [req.user.id]);
    res.json({ user: publicUser(updated.rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "プロフィールの更新に失敗しました。" });
  }
});

// GET /api/users/search?q=...&limit=20
// Finds users by callsign or display name (partial, case-insensitive).
// Must come before /:callsign below, same reasoning as /me above — and
// before /:callsign/follow etc. too, though those wouldn't actually
// collide since Express matches on the full path shape.
router.get("/search", optionalAuth, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.json({ users: [] });

    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const like = `%${q}%`;
    const params = [like, like];
    let query = `SELECT * FROM users WHERE (callsign LIKE $1 OR name LIKE $2)`;

    if (req.user?.id) {
      params.push(req.user.id);
      query += ` AND id != $${params.length}`;
    }

    // Its own placeholder rather than reusing $1 — see the follow-stats
    // query below for why a positional placeholder can't be reused.
    params.push(like);
    query += ` ORDER BY (CASE WHEN callsign LIKE $${params.length} THEN 0 ELSE 1 END), callsign ASC`;
    params.push(limit);
    query += ` LIMIT $${params.length}`;

    const result = await pool.query(query, params);
    res.json({ users: result.rows.map(publicUser) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "ユーザー検索に失敗しました。" });
  }
});

// POST /api/users/:callsign/follow  (toggle)
// This path shape (an extra /follow segment) never collides with the bare
// GET "/:callsign" below regardless of declaration order, since Express
// matches on the full path shape, not just the leading segment.
router.post("/:callsign/follow", requireAuth, async (req, res) => {
  try {
    const cs = req.params.callsign.toUpperCase();
    const targetResult = await pool.query("SELECT id FROM users WHERE callsign = $1", [cs]);
    const target = targetResult.rows[0];
    if (!target) return res.status(404).json({ error: "パイロットが見つかりません。" });
    if (target.id === req.user.id) {
      return res.status(400).json({ error: "自分自身をフォローすることはできません。" });
    }

    const existing = await pool.query(
      "SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = $2",
      [req.user.id, target.id]
    );

    let following;
    if (existing.rows.length) {
      await pool.query(
        "DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2",
        [req.user.id, target.id]
      );
      following = false;
    } else {
      await pool.query(
        "INSERT INTO follows (follower_id, followee_id) VALUES ($1, $2)",
        [req.user.id, target.id]
      );
      following = true;
    }

    const countResult = await pool.query(
      "SELECT COUNT(*) AS c FROM follows WHERE followee_id = $1",
      [target.id]
    );

    // Only on a new follow, never on unfollow. Unlike post notifications,
    // this isn't gated by notify_pref — anyone with an active push
    // subscription gets it.
    if (following) {
      push.pushToUsers([target.id], {
        title: "新しいフォロワー",
        body: `${req.user.callsign}さんにフォローされました`,
        url: "/",
        tag: `follow-${req.user.id}`,
      }).catch((err) => console.error("follow notify failed:", err));
    }

    res.json({ following, followerCount: Number(countResult.rows[0].c) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "フォロー処理に失敗しました。" });
  }
});

// GET /api/users/:callsign/followers  — users who follow :callsign
router.get("/:callsign/followers", async (req, res) => {
  try {
    const cs = req.params.callsign.toUpperCase();
    const targetResult = await pool.query("SELECT id FROM users WHERE callsign = $1", [cs]);
    const target = targetResult.rows[0];
    if (!target) return res.status(404).json({ error: "パイロットが見つかりません。" });

    const result = await pool.query(
      `SELECT u.* FROM follows f
       JOIN users u ON u.id = f.follower_id
       WHERE f.followee_id = $1
       ORDER BY f.created_at DESC`,
      [target.id]
    );
    res.json({ users: result.rows.map(publicUser) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "フォロワー一覧の取得に失敗しました。" });
  }
});

// GET /api/users/:callsign/following  — users :callsign follows
router.get("/:callsign/following", async (req, res) => {
  try {
    const cs = req.params.callsign.toUpperCase();
    const targetResult = await pool.query("SELECT id FROM users WHERE callsign = $1", [cs]);
    const target = targetResult.rows[0];
    if (!target) return res.status(404).json({ error: "パイロットが見つかりません。" });

    const result = await pool.query(
      `SELECT u.* FROM follows f
       JOIN users u ON u.id = f.followee_id
       WHERE f.follower_id = $1
       ORDER BY f.created_at DESC`,
      [target.id]
    );
    res.json({ users: result.rows.map(publicUser) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "フォロー中一覧の取得に失敗しました。" });
  }
});

// GET /api/users/:callsign  (optionalAuth: an anonymous viewer still gets
// follower/following counts, just with isFollowedByMe always false)
router.get("/:callsign", optionalAuth, async (req, res) => {
  try {
    const cs = req.params.callsign.toUpperCase();
    const userResult = await pool.query("SELECT * FROM users WHERE callsign = $1", [cs]);
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ error: "パイロットが見つかりません。" });

    // flight is stored as a JSON string in SQLite, so use json_extract()
    // instead of Postgres's ->> operator, with an explicit CAST.
    const stats = await pool.query(
      `SELECT COUNT(*) AS flight_count,
              COALESCE(SUM(CAST(json_extract(flight, '$.durMin') AS INTEGER)), 0) AS total_min,
              COALESCE(SUM(CAST(json_extract(flight, '$.distance') AS INTEGER)), 0) AS total_nm
       FROM posts WHERE author_id = $1 AND type = 'flight'`,
      [user.id]
    );

    // Each subquery below gets its own sequential placeholder even though
    // some reuse the same value (user.id) — db.js's $N -> ? conversion is
    // purely positional/in-order, never keyed by the literal N, so a
    // placeholder can't be safely reused across positions (see db.js).
    const followStats = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM follows WHERE followee_id = $1) AS follower_count,
         (SELECT COUNT(*) FROM follows WHERE follower_id = $2) AS following_count,
         EXISTS (SELECT 1 FROM follows WHERE follower_id = $3 AND followee_id = $4) AS is_following`,
      [user.id, user.id, req.user?.id || null, user.id]
    );
    const followRow = followStats.rows[0];

    res.json({
      user: publicUser(user),
      stats: {
        flights: Number(stats.rows[0].flight_count),
        hours: Number(stats.rows[0].total_min) / 60,
        distanceNm: Number(stats.rows[0].total_nm),
      },
      follow: {
        followerCount: Number(followRow.follower_count),
        followingCount: Number(followRow.following_count),
        // SQLite's EXISTS(...) yields 0/1, not a real boolean
        isFollowedByMe: !!followRow.is_following,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "プロフィールの取得に失敗しました。" });
  }
});

module.exports = router;
