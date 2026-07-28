/**
 * src/routes/fsaFlightPost.js
 * ---------------------------------------------------------------
 * scripts/fsa-to-aerosocial-bridge.js が叩く
 *   POST /api/internal/fsa-flight-post
 * を処理するルーター。X-Bridge-Secretで認証し、pilotId から
 * fsa_pilot_id が一致するAeroSocialユーザーを解決し、そのユーザーとして
 * flight投稿を作成する。
 *
 * 実際の投稿作成は src/routes/posts.js が export している createPost() を
 * そのまま呼ぶ（INSERT・post_images・broadcast("post:new")・
 * notifyNewPost まで posts.js 側と完全に同じ処理を通る。二重実装なし）。
 *
 * db層は src/db.js の { query, raw } シム（pg互換、$1,$2... プレースホルダ、
 * 内部でbetter-sqlite3に変換される）。posts.js と同じ流儀。
 *
 * 組み込み方（src/index.js に1行追加。fsaAutoPost.js のすぐ下あたりが
 * 分かりやすい）:
 *   app.use("/api/internal/fsa-flight-post", require("./routes/fsaFlightPost"));
 *
 * レスポンス形状は fsa-to-aerosocial-bridge.js の postFlightCard() が
 * 期待する { posted: boolean, reason?: string, postId?: string } に
 * 合わせてある。「pilotIdが誰にも登録されていない」「そのユーザーが
 * 自動投稿をOFFにしている」は異常系ではないので、あえて404/400では
 * なく200 + posted:false で返している（ブリッジ側は非2xxを
 * 「エラー」としてログするため）。
 */

"use strict";

const express = require("express");
const pool = require("../db");
const { createPost } = require("./posts");

const router = express.Router();

router.post("/", express.json(), async (req, res) => {
  // 0. .envにFSA_BRIDGE_SECRETが設定されていなければ、認証なしで
  //    誰でも他人になりすまして投稿できてしまうため、このエンドポイント
  //    自体を無効化する。
  const bridgeSecret = process.env.FSA_BRIDGE_SECRET;
  if (!bridgeSecret) {
    console.error("[fsa-flight-post] FSA_BRIDGE_SECRET が未設定のため無効化しています。");
    return res.status(500).json({ error: "fsa_bridge_secret_not_configured" });
  }

  // 1. 共有シークレットで認証
  const provided = req.get("X-Bridge-Secret");
  if (!provided || provided !== bridgeSecret) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const { pilotId, flight, caption } = req.body || {};
  if (pilotId === undefined || pilotId === null || pilotId === "") {
    return res.status(400).json({ error: "pilotId is required" });
  }

  // 2. pilotId -> AeroSocialユーザーの解決
  //    fsa_pilot_id は scripts/migrate.js で追加したTEXT列。
  let user;
  try {
    const result = await pool.query(
      "SELECT id, callsign, fsa_auto_post FROM users WHERE fsa_pilot_id = $1",
      [String(pilotId)]
    );
    user = result.rows[0];
  } catch (err) {
    // fsa_pilot_id 列自体がまだ無い環境向けの分かりやすいエラー
    // （node scripts/migrate.js の実行漏れを疑わせる）。
    console.error("[fsa-flight-post] users.fsa_pilot_id の参照に失敗しました。migrate.jsは実行済みですか？", err);
    return res.status(500).json({ error: "db_error" });
  }

  if (!user) {
    // 誰もこのpilotIdを登録していないだけなので正常系。
    return res.status(200).json({ posted: false, reason: "pilot_not_registered" });
  }

  // 3. そのユーザーが自動投稿をOFFにしていれば何もしない
  if (!user.fsa_auto_post) {
    return res.status(200).json({ posted: false, reason: "auto_post_disabled" });
  }

  // 4. 実際の投稿作成。posts.js の createPost() をそのまま利用することで、
  //    INSERT・画像処理・WebSocket通知・プッシュ通知まで通常投稿と
  //    完全に同じ経路を通る。ブリッジは画像を送らないので files は空配列。
  try {
    const post = await createPost({ authorId: user.id, text: caption, flight, files: [] });
    return res.status(200).json({ posted: true, postId: post.id });
  } catch (err) {
    console.error("[fsa-flight-post] 投稿作成に失敗しました:", err);
    return res.status(500).json({ error: "failed_to_create_post" });
  }
});

module.exports = router;
