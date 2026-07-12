const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

const CALLSIGN_RE = /^[A-Z0-9_]{3,20}$/;

function signToken(user) {
  return jwt.sign(
    { id: user.id, callsign: user.callsign },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "30d" }
  );
}

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

router.post("/register", async (req, res) => {
  try {
    const { callsign, name, homeBase, bio, password } = req.body;
    const cs = String(callsign || "").trim().toUpperCase();

    if (!CALLSIGN_RE.test(cs)) {
      return res.status(400).json({ error: "コールサインは英数字とアンダースコアのみ、3〜20文字で入力してください。" });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: "パスワードは8文字以上で入力してください。" });
    }

    const existing = await pool.query("SELECT id FROM users WHERE callsign = $1", [cs]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "そのコールサインは既に使用されています。" });
    }

    const hash = await bcrypt.hash(password, 12);
    const hue = Math.floor(Math.random() * 360);
    // SQLite has no gen_random_uuid(), so the id is generated here instead
    // of relying on a column default.
    const id = crypto.randomUUID();
    const result = await pool.query(
      `INSERT INTO users (id, callsign, name, home_base, bio, hue, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [id, cs, name || cs, (homeBase || "").toUpperCase().slice(0, 4), bio || "", hue, hash]
    );

    const user = result.rows[0];
    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "登録に失敗しました。" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { callsign, password } = req.body;
    const cs = String(callsign || "").trim().toUpperCase();

    const result = await pool.query("SELECT * FROM users WHERE callsign = $1", [cs]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: "コールサインまたはパスワードが違います。" });

    const ok = await bcrypt.compare(password || "", user.password_hash);
    if (!ok) return res.status(401).json({ error: "コールサインまたはパスワードが違います。" });

    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "ログインに失敗しました。" });
  }
});

router.get("/me", requireAuth, async (req, res) => {
  const result = await pool.query("SELECT * FROM users WHERE id = $1", [req.user.id]);
  if (!result.rows[0]) return res.status(404).json({ error: "ユーザーが見つかりません。" });
  res.json({ user: publicUser(result.rows[0]) });
});

module.exports = router;
