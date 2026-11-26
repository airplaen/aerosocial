const express = require("express");
const fs = require("fs");
const crypto = require("crypto");
const pool = require("../db");
const { requireAuth, optionalAuth } = require("../middleware/auth");
const upload = require("../middleware/upload");
const { broadcast } = require("../ws");

const router = express.Router();

// ストーリー機能 (24時間で消える投稿)。
// - 投稿: 画像1枚 and/or テキスト (最大200字)。どちらか必須。
// - 表示: フィード上部のバーにユーザー単位でグループ化して出す
//   (フロントは public/stories.js、app.js 本体は無改造)。
// - 既読: story_views に記録し、未読/既読のリング表示に使う。
// - 期限切れ: expires_at を過ぎたものは一覧に出さず、GET/POST の
//   ついでに遅延掃除する (行削除 + 画像ファイル削除)。専用の cron を
//   持たない代わりに、掃除は最大で5分に1回までに絞る。

const TEXT_MAX_LEN = 200;
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ACTIVE_PER_USER = 20;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

let lastCleanupAt = 0;

async function cleanupExpiredStories() {
  const now = Date.now();
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now;
  try {
    const expired = await pool.query(
      `SELECT id, image_path FROM stories WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
    );
    if (!expired.rows.length) return;
    const uploadDir = process.env.UPLOAD_DIR || "./uploads";
    for (const row of expired.rows) {
      await pool.query(`DELETE FROM stories WHERE id = $1`, [row.id]);
      if (row.image_path) fs.unlink(`${uploadDir}/${row.image_path}`, () => {});
      broadcast("story:deleted", { id: row.id });
    }
  } catch (err) {
    console.error("story cleanup failed:", err);
  }
}

function serializeStory(row, viewerId) {
  const story = {
    id: row.id,
    authorId: row.author_id,
    authorCallsign: row.callsign,
    authorName: row.name,
    authorHue: row.user_hue,
    authorAvatarUrl: row.avatar_path ? `/uploads/${row.avatar_path}` : null,
    text: row.text || "",
    imageUrl: row.image_path ? `/uploads/${row.image_path}` : null,
    hue: row.story_hue,
    viewedByMe: viewerId ? !!row.viewed_by_me : false,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
  // 閲覧数は投稿者本人にだけ見せる (誰が見たかは /:id/viewers も本人限定)。
  if (viewerId && viewerId === row.author_id) {
    story.viewCount = Number(row.view_count || 0);
  }
  return story;
}

const STORY_QUERY = `
  SELECT s.id, s.author_id, s.text, s.image_path, s.hue AS story_hue,
         s.created_at, s.expires_at,
         u.callsign, u.name, u.hue AS user_hue, u.avatar_path,
         CASE WHEN v.user_id IS NULL THEN 0 ELSE 1 END AS viewed_by_me,
         (SELECT COUNT(*) FROM story_views sv WHERE sv.story_id = s.id) AS view_count
  FROM stories s
  JOIN users u ON u.id = s.author_id
  LEFT JOIN story_views v ON v.story_id = s.id AND v.user_id = $1
  WHERE s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ORDER BY s.created_at ASC
`;

// GET /api/stories — 有効なストーリーをユーザーごとにグループ化して返す。
// 未ログインでも閲覧可 (フィードと同じ方針)。並びは「自分 → 未読 →
// 最新の投稿が新しい順」。
router.get("/", optionalAuth, async (req, res) => {
  try {
    await cleanupExpiredStories();
    const viewerId = req.user ? req.user.id : null;
    const result = await pool.query(STORY_QUERY, [viewerId]);
    const stories = result.rows.map((r) => serializeStory(r, viewerId));

    const groupsByAuthor = new Map();
    for (const story of stories) {
      if (!groupsByAuthor.has(story.authorId)) {
        groupsByAuthor.set(story.authorId, {
          user: {
            id: story.authorId,
            callsign: story.authorCallsign,
            name: story.authorName,
            hue: story.authorHue,
            avatarUrl: story.authorAvatarUrl,
          },
          stories: [],
          hasUnseen: false,
        });
      }
      const group = groupsByAuthor.get(story.authorId);
      group.stories.push(story);
      if (!story.viewedByMe && story.authorId !== viewerId) group.hasUnseen = true;
    }

    const groups = [...groupsByAuthor.values()].sort((a, b) => {
      const aMine = viewerId && a.user.id === viewerId ? 1 : 0;
      const bMine = viewerId && b.user.id === viewerId ? 1 : 0;
      if (aMine !== bMine) return bMine - aMine;
      if (a.hasUnseen !== b.hasUnseen) return a.hasUnseen ? -1 : 1;
      const aLatest = a.stories[a.stories.length - 1].createdAt;
      const bLatest = b.stories[b.stories.length - 1].createdAt;
      return bLatest.localeCompare(aLatest);
    });

    res.json({ groups });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "ストーリーの取得に失敗しました。" });
  }
});

// POST /api/stories — 新規投稿 (multipart: image は任意、text/hue はフィールド)。
router.post("/", requireAuth, upload.single("image"), async (req, res) => {
  const uploadedPath = req.file ? req.file.filename : null;
  const discardUpload = () => {
    if (uploadedPath) fs.unlink(`${process.env.UPLOAD_DIR || "./uploads"}/${uploadedPath}`, () => {});
  };

  const text = String(req.body.text ?? "").trim();
  if (text.length > TEXT_MAX_LEN) {
    discardUpload();
    return res.status(400).json({ error: `テキストは${TEXT_MAX_LEN}文字以内で入力してください。` });
  }
  if (!text && !uploadedPath) {
    return res.status(400).json({ error: "画像かテキストのどちらかは必要です。" });
  }

  try {
    await cleanupExpiredStories();
    const active = await pool.query(
      `SELECT COUNT(*) AS n FROM stories
       WHERE author_id = $1 AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      [req.user.id]
    );
    if (Number(active.rows[0].n) >= MAX_ACTIVE_PER_USER) {
      discardUpload();
      return res.status(429).json({ error: `ストーリーは同時に${MAX_ACTIVE_PER_USER}件までです。` });
    }

    const userResult = await pool.query(`SELECT hue FROM users WHERE id = $1`, [req.user.id]);
    const authorHue = userResult.rows[0] ? Number(userResult.rows[0].hue) : 200;
    let hue = Number.parseInt(req.body.hue, 10);
    if (!Number.isFinite(hue) || hue < 0 || hue > 359) hue = authorHue;

    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
    await pool.query(
      `INSERT INTO stories (id, author_id, text, image_path, hue, expires_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, req.user.id, text || null, uploadedPath, hue, expiresAt]
    );

    const result = await pool.query(
      STORY_QUERY.replace("ORDER BY s.created_at ASC", "AND s.id = $2 ORDER BY s.created_at ASC"),
      [req.user.id, id]
    );
    const story = serializeStory(result.rows[0], req.user.id);
    broadcast("story:new", story);
    res.status(201).json({ story });
  } catch (err) {
    console.error(err);
    discardUpload();
    res.status(500).json({ error: "ストーリーの投稿に失敗しました。" });
  }
});

// POST /api/stories/:id/view — 既読を付ける (自分のストーリーでは何もしない)。
router.post("/:id/view", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, author_id FROM stories WHERE id = $1 AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      [req.params.id]
    );
    const story = result.rows[0];
    if (!story) return res.status(404).json({ error: "ストーリーが見つかりません。" });
    if (story.author_id !== req.user.id) {
      await pool.query(
        `INSERT OR IGNORE INTO story_views (story_id, user_id) VALUES ($1, $2)`,
        [req.params.id, req.user.id]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "既読の記録に失敗しました。" });
  }
});

// GET /api/stories/:id/viewers — 閲覧者一覧 (投稿者本人のみ)。
router.get("/:id/viewers", requireAuth, async (req, res) => {
  try {
    const story = await pool.query(`SELECT author_id FROM stories WHERE id = $1`, [req.params.id]);
    if (!story.rows[0]) return res.status(404).json({ error: "ストーリーが見つかりません。" });
    if (story.rows[0].author_id !== req.user.id) {
      return res.status(403).json({ error: "投稿者本人だけが閲覧者を見られます。" });
    }
    const result = await pool.query(
      `SELECT u.callsign, u.name, u.hue, u.avatar_path, v.created_at AS viewed_at
       FROM story_views v JOIN users u ON u.id = v.user_id
       WHERE v.story_id = $1 ORDER BY v.created_at ASC`,
      [req.params.id]
    );
    res.json({
      viewers: result.rows.map((r) => ({
        callsign: r.callsign,
        name: r.name,
        hue: r.hue,
        avatarUrl: r.avatar_path ? `/uploads/${r.avatar_path}` : null,
        viewedAt: r.viewed_at,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "閲覧者の取得に失敗しました。" });
  }
});

// DELETE /api/stories/:id — 自分のストーリーを消す (画像ファイルも削除)。
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`SELECT author_id, image_path FROM stories WHERE id = $1`, [req.params.id]);
    const story = result.rows[0];
    if (!story) return res.status(404).json({ error: "ストーリーが見つかりません。" });
    if (story.author_id !== req.user.id) return res.status(403).json({ error: "自分のストーリーだけ削除できます。" });

    await pool.query(`DELETE FROM stories WHERE id = $1`, [req.params.id]);
    if (story.image_path) {
      fs.unlink(`${process.env.UPLOAD_DIR || "./uploads"}/${story.image_path}`, () => {});
    }
    broadcast("story:deleted", { id: req.params.id, authorId: req.user.id });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "ストーリーの削除に失敗しました。" });
  }
});

module.exports = router;
