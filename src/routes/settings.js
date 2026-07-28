/**
 * routes/settings.js
 * ---------------------------------------------------------------
 * index.js の他ルート（routes/notifications.js 等）と同じ流儀で、
 * app.use("/api/settings", settingsRoutes) としてマウントする前提。
 *
 *   GET   /api/settings/fsa-auto-post               -> { enabled: boolean }
 *   PATCH /api/settings/fsa-auto-post  { enabled }   -> { enabled: boolean }
 *   GET   /api/settings/fsa-pilot-id                 -> { pilotId: string|null }
 *   PATCH /api/settings/fsa-pilot-id   { pilotId }   -> { pilotId: string|null }
 *     (pilotId に null / "" を渡すと登録解除。1つのpilotIdにつき紐付けられる
 *      アカウントは1つだけ — users.fsa_pilot_id のUNIQUE partial index。
 *      他人が既に使っているpilotIdを指定すると409を返す。)
 *
 * ⚠️ 暫定版: middleware/auth.js の中身が未確認のため、下の requireAuth は
 * 自前でJWTを検証する仮実装。migrate.js のコメントによると is_banned は
 * middleware/auth.js 側で毎リクエストチェックされているとのことなので、
 * 本来は以下を
 *   const { requireAuth } = require("../middleware/auth");
 * に差し替えて、他の /api/* ルートと同じ認証・BANチェックに揃えるべき。
 * middleware/auth.js を共有してもらい次第、差し替える。
 */

"use strict";

const express = require("express");
const jwt = require("jsonwebtoken");
const path = require("path");
const Database = require("better-sqlite3");

const router = express.Router();

// このファイルは src/routes/settings.js に配置される前提。migrate.js 等は
// scripts/（プロジェクト直下から1階層）から path.join(__dirname, "..", ...) で
// プロジェクト直下の aerosocial.db に届くが、ここは src/routes/ （直下から
// 2階層）なので ".." を2つ重ねないと src/ で止まってしまい、存在しない
// DBファイルを新規作成してしまう（"no such table: users" の原因だった）。
const dbPath = process.env.SQLITE_PATH || path.join(__dirname, "..", "..", "aerosocial.db");

function getDb() {
  return new Database(dbPath);
}

function pickUserId(decoded) {
  return decoded.id ?? decoded.sub ?? decoded.userId ?? decoded.uid ?? null;
}

// TODO: middleware/auth.js を受け取り次第、これを削除して
// require("../middleware/auth") の requireAuth に置き換える。
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "認証が必要です。" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = pickUserId(decoded);
    if (!userId) return res.status(401).json({ error: "トークンからユーザーIDを特定できませんでした。" });
    req.authUserId = userId;
    next();
  } catch {
    return res.status(401).json({ error: "トークンが無効か期限切れです。" });
  }
}

router.get("/fsa-auto-post", requireAuth, (req, res) => {
  const db = getDb();
  try {
    const row = db.prepare("SELECT fsa_auto_post FROM users WHERE id = ?").get(req.authUserId);
    if (!row) return res.status(404).json({ error: "ユーザーが見つかりません。" });
    res.json({ enabled: !!row.fsa_auto_post });
  } finally {
    db.close();
  }
});

router.patch("/fsa-auto-post", requireAuth, (req, res) => {
  const enabled = !!(req.body && req.body.enabled);
  const db = getDb();
  try {
    const result = db.prepare("UPDATE users SET fsa_auto_post = ? WHERE id = ?").run(enabled ? 1 : 0, req.authUserId);
    if (result.changes === 0) return res.status(404).json({ error: "ユーザーが見つかりません。" });
    res.json({ enabled });
  } finally {
    db.close();
  }
});

router.get("/fsa-pilot-id", requireAuth, (req, res) => {
  const db = getDb();
  try {
    const row = db.prepare("SELECT fsa_pilot_id FROM users WHERE id = ?").get(req.authUserId);
    if (!row) return res.status(404).json({ error: "ユーザーが見つかりません。" });
    res.json({ pilotId: row.fsa_pilot_id || null });
  } finally {
    db.close();
  }
});

router.patch("/fsa-pilot-id", requireAuth, (req, res) => {
  // 空文字列やnullは「登録解除」として扱う。
  const raw = req.body && req.body.pilotId;
  const pilotId = raw === undefined || raw === null ? null : String(raw).trim() || null;

  const db = getDb();
  try {
    const result = db
      .prepare("UPDATE users SET fsa_pilot_id = ? WHERE id = ?")
      .run(pilotId, req.authUserId);
    if (result.changes === 0) return res.status(404).json({ error: "ユーザーが見つかりません。" });
    res.json({ pilotId });
  } catch (err) {
    // idx_users_fsa_pilot_id (UNIQUE ... WHERE fsa_pilot_id IS NOT NULL) の
    // 違反 = 他のユーザーが既にこのpilotIdを登録済み。
    if (/UNIQUE constraint failed/i.test(err.message)) {
      return res.status(409).json({ error: "このFSAパイロットIDは既に別のアカウントに登録されています。" });
    }
    console.error("[settings] fsa-pilot-id の更新に失敗しました:", err);
    res.status(500).json({ error: "更新に失敗しました。" });
  } finally {
    db.close();
  }
});

module.exports = router;
