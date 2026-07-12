const express = require("express");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const pool = require("../db");
const { requireAuth } = require("../middleware/auth");
const upload = require("../middleware/upload");

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

router.get("/:callsign", async (req, res) => {
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

  res.json({
    user: publicUser(user),
    stats: {
      flights: Number(stats.rows[0].flight_count),
      hours: Number(stats.rows[0].total_min) / 60,
      distanceNm: Number(stats.rows[0].total_nm),
    },
  });
});

module.exports = router;
