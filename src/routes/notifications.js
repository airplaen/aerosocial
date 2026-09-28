const express = require("express");
const crypto = require("crypto");
const pool = require("../db");
const { requireAuth } = require("../middleware/auth");
const push = require("../lib/push");

const router = express.Router();

const POST_NOTIFY_VALUES = new Set(["all", "following"]);

// GET /api/notifications/vapid-public-key
// Public (no auth needed, no secret involved) — the frontend needs this to
// call pushManager.subscribe(). Returns null if the server has no VAPID
// keys configured, so the frontend can hide the toggle instead of failing.
router.get("/vapid-public-key", (_req, res) => {
  res.json({ key: push.enabled ? push.PUBLIC_KEY : null });
});

// GET /api/notifications/settings
// Whether *this browser* currently has an active push subscription is
// determined client-side (via pushManager.getSubscription()), so only the
// "which posts should notify me" preference lives here.
router.get("/settings", requireAuth, async (req, res) => {
  const result = await pool.query("SELECT notify_pref FROM users WHERE id = $1", [req.user.id]);
  res.json({ postNotify: result.rows[0]?.notify_pref || "all" });
});

// PATCH /api/notifications/settings  { postNotify: "all" | "following" }
router.patch("/settings", requireAuth, async (req, res) => {
  const { postNotify } = req.body;
  if (!POST_NOTIFY_VALUES.has(postNotify)) {
    return res.status(400).json({ error: "postNotifyは'all'または'following'を指定してください。" });
  }
  await pool.query("UPDATE users SET notify_pref = $1 WHERE id = $2", [postNotify, req.user.id]);
  res.json({ postNotify });
});

// POST /api/notifications/subscribe  { subscription: PushSubscriptionJSON }
// Upserts by endpoint: the same browser subscribing again (e.g. after
// re-logging in as a different user on a shared machine) re-points the
// existing row instead of creating a duplicate.
router.post("/subscribe", requireAuth, async (req, res) => {
  try {
    const subscription = req.body.subscription || req.body;
    const { endpoint, keys } = subscription || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: "プッシュ購読情報が不正です。" });
    }

    const existing = await pool.query("SELECT id FROM push_subscriptions WHERE endpoint = $1", [endpoint]);
    if (existing.rows[0]) {
      await pool.query(
        "UPDATE push_subscriptions SET user_id = $1, p256dh = $2, auth = $3 WHERE endpoint = $4",
        [req.user.id, keys.p256dh, keys.auth, endpoint]
      );
    } else {
      await pool.query(
        "INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4, $5)",
        [crypto.randomUUID(), req.user.id, endpoint, keys.p256dh, keys.auth]
      );
    }
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "プッシュ通知の登録に失敗しました。" });
  }
});

// GET /api/notifications/announcements?limit=50 — 運営からのメッセージ履歴
// (管理者パネルの /api/admin/announcements と同じテーブルを読むだけの
// 一般ユーザー向け版。管理者権限は不要 — ログインさえしていれば誰でも
// 読める、DM風の「メッセージ」タブ表示用)。新着はWebSocketの
// "announcement:new"(src/routes/admin.js参照)でリアルタイムに届くので、
// ここは初回表示時の履歴取得のみを担う。
router.get("/announcements", requireAuth, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const result = await pool.query(
      `SELECT a.*, u.callsign FROM announcements a
       JOIN users u ON u.id = a.author_id
       ORDER BY a.created_at DESC
       LIMIT $1`,
      [limit]
    );
    res.json({
      announcements: result.rows.map((row) => ({
        id: row.id,
        message: row.message,
        authorCallsign: row.callsign,
        createdAt: row.created_at,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "お知らせ履歴の取得に失敗しました。" });
  }
});

// POST /api/notifications/unsubscribe  { endpoint }
router.post("/unsubscribe", requireAuth, async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (endpoint) {
      await pool.query(
        "DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2",
        [endpoint, req.user.id]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "プッシュ通知の解除に失敗しました。" });
  }
});

module.exports = router;
