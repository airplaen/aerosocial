/**
 * src/routes/fsaAutoPost.js
 * ---------------------------------------------------------------
 * FSA (Flight Stream Assistant) から「フライト開始」を検知して
 * AeroSocialへ自動投稿する機能の、ユーザーごとのON/OFF設定API。
 *
 * users.fsa_auto_post 列（scripts/migrate.js で追加）を読み書きするだけの
 * 小さなルーター。
 *
 * db層は src/db.js が export している { query, raw } シム
 * （pg の Pool.query 互換インターフェースを better-sqlite3 の上に被せた
 * もの。$1,$2... のプレースホルダのまま渡せば内部で "?" に変換される）。
 * posts.js と同じ流儀にするため、生の better-sqlite3 (`.raw`/`.prepare()`)
 * ではなくこの `query()` を使う。
 *
 * 組み込み方（src/index.js に1行追加）:
 *   app.use("/api/settings/fsa-auto-post", require("./routes/fsaAutoPost"));
 */

"use strict";

const express = require("express");
const pool = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// GET /api/settings/fsa-auto-post -> { enabled: boolean }
router.get("/", requireAuth, async (req, res) => {
  try {
    const result = await pool.query("SELECT fsa_auto_post FROM users WHERE id = $1", [req.user.id]);
    if (!result.rows[0]) return res.status(404).json({ error: "user_not_found" });
    res.json({ enabled: !!result.rows[0].fsa_auto_post });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "設定の取得に失敗しました。" });
  }
});

// PATCH /api/settings/fsa-auto-post  body: { enabled: boolean } -> { enabled: boolean }
router.patch("/", requireAuth, express.json(), async (req, res) => {
  try {
    const enabled = !!(req.body && req.body.enabled);
    const result = await pool.query(
      "UPDATE users SET fsa_auto_post = $1 WHERE id = $2",
      [enabled ? 1 : 0, req.user.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "user_not_found" });
    res.json({ enabled });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "保存に失敗しました。" });
  }
});

module.exports = router;
