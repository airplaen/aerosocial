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

// GET /api/auth/google/config
router.get("/google/config", (_req, res) => {
  res.json({ clientId: process.env.GOOGLE_CLIENT_ID || null });
});

function googleRedirectUri(req) {
  return `${req.protocol}://${req.get("host")}/api/auth/google/callback`;
}

router.get("/google/start", (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.status(500).send("Googleログインが設定されていません。");
  }
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: googleRedirectUri(req),
    response_type: "code",
    scope: "openid email profile",
    prompt: "select_account",
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

router.get("/google/callback", async (req, res) => {
  try {
    const { code, error } = req.query;
    if (error || !code) {
      return res.redirect("/?googleError=" + encodeURIComponent("Googleログインがキャンセルされました。"));
    }
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      return res.redirect("/?googleError=" + encodeURIComponent("Googleログインが設定されていません。"));
    }

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: String(code),
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: googleRedirectUri(req),
        grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) {
      return res.redirect("/?googleError=" + encodeURIComponent("Googleログインの検証に失敗しました。"));
    }
    const tokenData = await tokenRes.json();
    if (!tokenData.id_token) {
      return res.redirect("/?googleError=" + encodeURIComponent("Googleログインの検証に失敗しました。"));
    }

    res.redirect(`/#google=${encodeURIComponent(tokenData.id_token)}`);
  } catch (err) {
    console.error(err);
    res.redirect("/?googleError=" + encodeURIComponent("Googleログインに失敗しました。"));
  }
});

router.post("/register", (_req, res) => {
  res.status(403).json({
    error: "セキュリティ強化のため、新規アカウント登録はGoogleログインのみご利用いただけます。",
  });
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

    // Checked after the password matches (not before) so a banned callsign
    // doesn't reveal itself as "exists" via a different error than a wrong
    // password would give.
    if (user.is_banned) return res.status(403).json({ error: "このアカウントは停止されています。" });

    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "ログインに失敗しました。" });
  }
});

router.post("/google", async (req, res) => {
  try {
    const { credential, callsign, homeBase } = req.body;
    if (!credential) {
      return res.status(400).json({ error: "Googleのクレデンシャルがありません。" });
    }
    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(500).json({ error: "Googleログインが設定されていません。" });
    }

    const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
    if (!verifyRes.ok) {
      return res.status(401).json({ error: "Googleログインの検証に失敗しました。" });
    }
    const payload = await verifyRes.json();

    if (payload.aud !== process.env.GOOGLE_CLIENT_ID) {
      return res.status(401).json({ error: "Googleログインの検証に失敗しました。" });
    }
    if (payload.email_verified !== "true" && payload.email_verified !== true) {
      return res.status(401).json({ error: "確認済みのメールアドレスが必要です。" });
    }

    const googleId = payload.sub;
    const existing = await pool.query("SELECT * FROM users WHERE google_id = $1", [googleId]);
    if (existing.rows[0]) {
      const user = existing.rows[0];
      if (user.is_banned) return res.status(403).json({ error: "このアカウントは停止されています。" });
      return res.json({ token: signToken(user), user: publicUser(user) });
    }

    if (!callsign) {
      const suggested = String(payload.given_name || payload.name || (payload.email || "").split("@")[0] || "")
        .toUpperCase()
        .replace(/[^A-Z0-9_]/g, "")
        .slice(0, 20);
      return res.json({ needsCallsign: true, suggestedCallsign: suggested, name: payload.name || null });
    }

    const cs = String(callsign).trim().toUpperCase();
    if (!CALLSIGN_RE.test(cs)) {
      return res.status(400).json({ error: "コールサインは英数字とアンダースコアのみ、3〜20文字で入力してください。" });
    }
    const dup = await pool.query("SELECT id FROM users WHERE callsign = $1", [cs]);
    if (dup.rows.length > 0) {
      return res.status(409).json({ error: "そのコールサインは既に使用されています。" });
    }

    const randomPasswordHash = await bcrypt.hash(crypto.randomUUID(), 12);
    const hue = Math.floor(Math.random() * 360);
    const id = crypto.randomUUID();
    const result = await pool.query(
      `INSERT INTO users (id, callsign, name, home_base, bio, hue, password_hash, google_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [id, cs, payload.name || cs, (homeBase || "").toUpperCase().slice(0, 4), "", hue, randomPasswordHash, googleId]
    );

    const user = result.rows[0];
    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Googleログインに失敗しました。" });
  }
});

router.get("/me", requireAuth, async (req, res) => {
  const result = await pool.query("SELECT * FROM users WHERE id = $1", [req.user.id]);
  if (!result.rows[0]) return res.status(404).json({ error: "ユーザーが見つかりません。" });
  res.json({ user: publicUser(result.rows[0]) });
});

module.exports = router;
