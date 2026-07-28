/**
 * src/routes/fsaPilotId.js
 * ---------------------------------------------------------------
 * ユーザーが自分のAeroSocialアカウントにFSA(Flight Stream Assistant)の
 * パイロットIDを登録・解除するための設定API。
 *
 * app.js（設定パネル内のFSAパイロットID入力欄）と
 * fsa-settings.html/fsa-settings.js の両方から
 *   GET/PATCH /api/settings/fsa-pilot-id
 * として呼ばれる。users.fsa_pilot_id は scripts/migrate.js で追加した
 * UNIQUEな部分インデックス付きTEXT列（1つのpilot_idにつき紐付けられる
 * アカウントは1つだけ）なので、他ユーザーが既に使っているIDを登録しよう
 * とした場合は409で分かりやすいエラーを返す。
 *
 * db層は src/db.js の { query, raw } シム（pg互換、$1,$2... プレースホルダ、
 * 内部でbetter-sqlite3に変換される）。posts.js / fsaAutoPost.js と同じ流儀。
 *
 * 組み込み方（src/index.js に1行追加。fsaAutoPost.js の近くが分かりやすい）:
 *   app.use("/api/settings/fsa-pilot-id", require("./routes/fsaPilotId"));
 */

"use strict";

const express = require("express");
const pool = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// better-sqlite3のユニーク制約違反は err.code === "SQLITE_CONSTRAINT_UNIQUE"、
// もしくはメッセージに "UNIQUE constraint failed" を含む形で投げられる
// （db.js のquery()はエラーをそのままreject/throwしているだけなので、
// ここでも生のbetter-sqlite3エラー形式を見ることになる）。
function isUniqueConstraintError(err) {
  return !!err && (err.code === "SQLITE_CONSTRAINT_UNIQUE" || /UNIQUE constraint failed/i.test(err.message || ""));
}

// GET /api/settings/fsa-pilot-id -> { pilotId: string|null }
router.get("/", requireAuth, async (req, res) => {
  try {
    const result = await pool.query("SELECT fsa_pilot_id FROM users WHERE id = $1", [req.user.id]);
    if (!result.rows[0]) return res.status(404).json({ error: "user_not_found" });
    res.json({ pilotId: result.rows[0].fsa_pilot_id || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "パイロットIDの取得に失敗しました。" });
  }
});

// PATCH /api/settings/fsa-pilot-id  body: { pilotId: string|null } -> { pilotId }
router.patch("/", requireAuth, express.json(), async (req, res) => {
  const raw = req.body ? req.body.pilotId : undefined;
  const pilotId = raw === null || raw === undefined ? null : String(raw).trim() || null;

  try {
    const result = await pool.query(
      "UPDATE users SET fsa_pilot_id = $1 WHERE id = $2",
      [pilotId, req.user.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "user_not_found" });
    res.json({ pilotId });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return res.status(409).json({ error: "このパイロットIDは既に他のアカウントで登録されています。" });
    }
    console.error(err);
    res.status(500).json({ error: "パイロットIDの保存に失敗しました。" });
  }
});

module.exports = router;
